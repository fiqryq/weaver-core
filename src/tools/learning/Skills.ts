import { Effect, Predicate, Schema } from "effect"
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { LibraryStore } from "../../features/learning/library/LibraryStore.ts"
import type {
  LocatedSkill,
  SkillExists,
  SkillInvalid,
  SkillNotFound,
  SkillStorageError,
  SkillStore
} from "../../features/learning/skills/SkillStore.ts"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"
import { resolveInWorkspace } from "../builtin/Files.ts"

const done = "This update is complete — don't repeat it."
const sharedNote = "Every bot that uses this library skill gets the change."

/** Where a loaded skill's files are copied in the bot's workspace. */
export const skillFilesDir = ".skills"

export const filesNote = (name: string) =>
  `This skill's files are in your workspace at ${skillFilesDir}/${name}/ — run its scripts from there.`

/** Copies a skill folder, leaving out hidden files; files starting with a shebang become executable. */
const exportDir = async (from: string, to: string): Promise<void> => {
  await mkdir(to)
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      await exportDir(source, target)
    } else if (entry.isFile()) {
      const bytes = await readFile(source)
      await writeFile(target, bytes, { flag: "wx" })
      if (bytes[0] === 0x23 && bytes[1] === 0x21) {
        const mode = (await stat(target)).mode & 0o777
        await chmod(target, mode | ((mode & 0o444) >> 2))
      }
    }
  }
}

/**
 * Replaces `<workspace>/.skills/<name>/` with a copy of the skill's folder, so its scripts can be run.
 * The copy is written like the file tools write, so it gets the workspace's group and ACLs.
 */
export const copySkillToWorkspace = (workspace: string, skill: LocatedSkill): Effect.Effect<void, ToolFailure> =>
  Effect.gen(function*() {
    const target = yield* resolveInWorkspace(workspace, `${skillFilesDir}/${skill.name}`)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(join(target, ".."), { recursive: true })
        await rm(target, { recursive: true, force: true })
        await exportDir(skill.dir, target)
      },
      catch: (cause) => new ToolFailure({ message: cause instanceof Error ? cause.message : String(cause) })
    })
  })

const ListParams = Schema.Struct({
  category: Schema.optional(Schema.String).annotate({ description: "Optional category filter to narrow results." })
})

const ViewParams = Schema.Struct({
  name: Schema.String.annotate({ description: "The skill name (use skills_list to see your skills)." }),
  file_path: Schema.optional(Schema.String).annotate({
    description:
      "OPTIONAL: Path to a linked file within the skill (e.g. 'references/api.md', 'templates/config.yaml', 'scripts/validate.py'). Omit to get the main SKILL.md content."
  })
})

const ManageParams = Schema.Struct({
  action: Schema.Literals(["create", "patch", "edit", "delete", "write_file", "remove_file"]).annotate({
    description: "What to do."
  }),
  name: Schema.String.annotate({
    description: "The skill's name: lowercase letters, numbers, hyphens, dots and underscores, at most 64 characters."
  }),
  content: Schema.optional(Schema.String).annotate({
    description:
      "create and edit: the full SKILL.md text (YAML frontmatter with name and description, then a markdown body). For edit it REPLACES the whole file."
  }),
  category: Schema.optional(Schema.String).annotate({ description: "create: optional category folder (e.g. 'devops')." }),
  file_path: Schema.optional(Schema.String).annotate({
    description:
      "write_file, remove_file, and optionally patch: path RELATIVE to the skill's own folder, e.g. 'references/api.md' — no leading slash; in your own skills the first folder is references/, templates/, scripts/ or assets/ (library skills take any relative path). patch defaults to SKILL.md."
  }),
  file_content: Schema.optional(Schema.String).annotate({ description: "write_file: the full text of the supporting file." }),
  old_string: Schema.optional(Schema.String).annotate({
    description: "patch: exact text to find. It must appear exactly once unless replace_all is set."
  }),
  new_string: Schema.optional(Schema.String).annotate({
    description: "patch: the replacement; an empty string deletes the match."
  }),
  replace_all: Schema.optional(Schema.Boolean).annotate({
    description: "patch: replace every occurrence (default false)."
  })
})
type ManageParams = typeof ManageParams.Type

const toFailure = (error: SkillNotFound | SkillInvalid | SkillExists | SkillStorageError) =>
  new ToolFailure({
    message: error._tag === "SkillNotFound" ? `${error.message} Use skills_list to see your skills.` : error.message
  })

const argsOf = (params: unknown): Record<string, unknown> => Predicate.isObject(params) ? params as Record<string, unknown> : {}

/** The schemas advertise optional fields as nullable, and models fill the unused ones of the flat shape with null. */
const withoutNulls = (params: unknown): unknown =>
  Predicate.isObject(params) ? Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null)) : params

const nameOf = (params: unknown): string => {
  const name = argsOf(params).name
  return Predicate.isString(name) ? shorten(name, 60) : ""
}

const manageTitle = (params: unknown): string => {
  const name = nameOf(params)
  const verb = (() => {
    switch (argsOf(params).action) {
      case "create":
        return "Created skill"
      case "delete":
        return "Deleted skill"
      case "write_file":
        return "Added a file to skill"
      case "remove_file":
        return "Removed a file from skill"
      default:
        return "Updated skill"
    }
  })()
  return name.length > 0 ? `${verb} ${name}` : verb
}

const required = (value: string | undefined, field: string, action: string): Effect.Effect<string, ToolFailure> =>
  value === undefined ? Effect.fail(new ToolFailure({ message: `${field} is required for ${action}.` })) : Effect.succeed(value)

/**
 * The bot's own skills and the shared library skills assigned to it: listing, loading and maintaining
 * them. Its own skill wins when both have a name. With `workspace`, loading a skill that has files
 * copies them to `.skills/<name>/` there.
 */
export const skillTools = (options: {
  readonly store: SkillStore["Service"]
  readonly botId: string
  readonly library?: LibraryStore["Service"] | undefined
  readonly assigned?: ReadonlyArray<string> | undefined
  readonly workspace?: string | undefined
}): Array<AgentTool> => {
  const { botId, library, store, workspace } = options
  const assigned = new Set(library === undefined ? [] : options.assigned ?? [])

  /** The library, when `name` is an assigned library skill the bot has no own skill for. */
  const libraryFor = (name: string) =>
    Effect.gen(function*() {
      if (library === undefined || !assigned.has(name)) return undefined
      if ((yield* store.folderOf(botId, name)) !== undefined) return undefined
      return (yield* library.folderOf(name)) === undefined ? undefined : library
    }).pipe(Effect.mapError(toFailure))

  const copyFiles = (folder: Effect.Effect<LocatedSkill | undefined, SkillStorageError>) =>
    Effect.gen(function*() {
      if (workspace === undefined) return ""
      const located = yield* Effect.orElseSucceed(folder, () => undefined)
      if (located === undefined) return ""
      const copied = yield* Effect.result(copySkillToWorkspace(workspace, located))
      return copied._tag === "Success"
        ? `\n\n${filesNote(located.name)}`
        : `\n\n(Couldn't copy this skill's files into your workspace: ${copied.failure.message})`
    })

  const listTool: AgentTool = {
    name: "skills_list",
    description: "List your skills and the shared library skills you can use (name + description). Use skill_view(name) to load full content.",
    parameters: jsonSchemaOf(ListParams),
    needsApproval: false,
    activity: "Checking skills",
    title: () => "Checked skills",
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(ListParams, withoutNulls(raw))
        const category = params.category?.trim() ?? ""
        const own = yield* Effect.mapError(store.list(botId), toFailure)
        const ownNames = new Set(own.map((skill) => skill.name))
        const shared = library === undefined || assigned.size === 0
          ? []
          : (yield* Effect.mapError(library.list, toFailure)).filter((skill) => assigned.has(skill.name) && !ownNames.has(skill.name))
        const all = [
          ...own.map((skill) => ({ ...skill, mark: "" })),
          ...shared.map((skill) => ({ ...skill, category: skill.category ?? "", mark: " (library)" }))
        ]
        const skills = category.length > 0 ? all.filter((skill) => skill.category === category) : all
        if (skills.length === 0) {
          return category.length > 0 && all.length > 0
            ? `No skills in category "${category}".`
            : "You don't have any skills yet. Create one with skill_manage(action='create')."
        }
        const lines = skills.map((skill) =>
          `- ${skill.category.length > 0 ? `${skill.category}/` : ""}${skill.name}${skill.mark}: ${skill.description}`
        )
        const note = shared.length > 0 ? "\nSkills marked (library) are shared with other bots." : ""
        return `${lines.join("\n")}\n\nUse skill_view(name) to see full content and linked files.${note}`
      })
  }

  const viewTool: AgentTool = {
    name: "skill_view",
    description:
      "Skills allow for loading information about specific tasks and workflows, as well as scripts and templates. " +
      "Load a skill's full content or access its linked files (references, templates, scripts). " +
      "First call returns SKILL.md content plus a list of linked files, and copies the skill's files into your workspace " +
      `at ${skillFilesDir}/<name>/ so you can run its scripts. To read a linked file, call again with the file_path parameter.`,
    parameters: jsonSchemaOf(ViewParams),
    needsApproval: false,
    activity: "Checking skills",
    title: (params) => {
      const name = nameOf(params)
      const file = argsOf(params).file_path
      const detail = Predicate.isString(file) && file.length > 0 ? `${name}/${shorten(file, 60)}` : name
      return detail.length > 0 ? `Viewed skill ${detail}` : "Viewed a skill"
    },
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(ViewParams, withoutNulls(raw))
        const name = params.name.trim()
        const filePath = params.file_path?.trim() ?? ""
        const shared = yield* libraryFor(name)
        if (filePath.length > 0) {
          const content = shared === undefined
            ? yield* Effect.mapError(store.readFile(botId, name, filePath), toFailure)
            : new TextDecoder().decode(yield* Effect.mapError(shared.readFile(name, filePath), toFailure))
          if (content.includes("\u0000")) return `${filePath} is a binary file (${content.length} bytes).`
          return content.length > 0 ? content : "(empty file)"
        }
        const skill = shared === undefined
          ? yield* Effect.mapError(store.get(botId, name), toFailure)
          : yield* Effect.mapError(shared.get(name), toFailure)
        yield* Effect.ignore(shared === undefined ? store.recordView(botId, name) : shared.recordView(name))
        const note = shared === undefined
          ? ""
          : `\n\n(This is a shared library skill: other bots use it too, so keep changes to it true for all of them.)`
        if (skill.files.length === 0) return `${skill.content}${note}`
        const copied = yield* copyFiles(shared === undefined ? store.folderOf(botId, name) : shared.folderOf(name))
        return `${skill.content}\n\n---\nLinked files (load with skill_view(name='${name}', file_path='...')):\n` +
          skill.files.map((file) => `- ${file}`).join("\n") + copied + note
      })
  }

  const manage = (params: ManageParams): Effect.Effect<string, ToolFailure> => {
    const name = params.name.trim()
    const quoted = `"${name}"`
    switch (params.action) {
      case "create":
        return Effect.gen(function*() {
          const content = yield* required(params.content, "content", "create")
          if (library !== undefined && assigned.has(name) && (yield* Effect.mapError(library.folderOf(name), toFailure)) !== undefined) {
            return yield* new ToolFailure({ message: `A library skill named ${name} is assigned to you; patch that one instead.` })
          }
          yield* Effect.mapError(store.create(botId, { name, content, category: params.category }, "agent"), toFailure)
          return `Created skill ${quoted}. ${done}`
        })
      case "edit":
        return Effect.gen(function*() {
          const content = yield* required(params.content, "content", "edit")
          const shared = yield* libraryFor(name)
          if (shared !== undefined) {
            yield* Effect.mapError(shared.replaceContent(name, content), toFailure)
            return `Updated library skill ${quoted} (full rewrite). ${sharedNote} ${done}`
          }
          yield* Effect.mapError(store.replaceContent(botId, name, content, "agent"), toFailure)
          return `Updated skill ${quoted} (full rewrite). ${done}`
        })
      case "patch":
        return Effect.gen(function*() {
          const shared = yield* libraryFor(name)
          if (params.old_string === undefined && params.new_string === undefined && params.content !== undefined) {
            if (shared !== undefined) {
              yield* Effect.mapError(shared.replaceContent(name, params.content), toFailure)
              return `Updated library skill ${quoted} (full rewrite). ${sharedNote} ${done}`
            }
            yield* Effect.mapError(store.replaceContent(botId, name, params.content, "agent"), toFailure)
            return `Updated skill ${quoted} (full rewrite). ${done}`
          }
          const oldString = yield* required(params.old_string, "old_string", "patch")
          const newString = yield* required(params.new_string, "new_string", "patch")
          const patch = { old_string: oldString, new_string: newString, replace_all: params.replace_all, file_path: params.file_path }
          const count = yield* Effect.mapError(shared === undefined ? store.patch(botId, name, patch) : shared.patch(name, patch), toFailure)
          const target = params.file_path ?? "SKILL.md"
          const replacements = `${count} replacement${count === 1 ? "" : "s"}`
          return shared === undefined
            ? `Updated ${target} in skill ${quoted} (${replacements}). ${done}`
            : `Updated ${target} in library skill ${quoted} (${replacements}). ${sharedNote} ${done}`
        })
      case "delete":
        return Effect.gen(function*() {
          if ((yield* libraryFor(name)) !== undefined) {
            return yield* new ToolFailure({ message: "Only the person can delete library skills." })
          }
          yield* Effect.mapError(store.remove(botId, name), toFailure)
          return `Deleted skill ${quoted}. ${done}`
        })
      case "write_file":
        return Effect.gen(function*() {
          const path = yield* required(params.file_path, "file_path", "write_file")
          const content = yield* required(params.file_content, "file_content", "write_file")
          const shared = yield* libraryFor(name)
          if (shared !== undefined) {
            yield* Effect.mapError(shared.writeFile(name, path, content), toFailure)
            return `Wrote ${path} in library skill ${quoted}. ${sharedNote} ${done}`
          }
          yield* Effect.mapError(store.writeFile(botId, name, path, content), toFailure)
          return `Wrote ${path} in skill ${quoted}. ${done}`
        })
      case "remove_file":
        return Effect.gen(function*() {
          const path = yield* required(params.file_path, "file_path", "remove_file")
          const shared = yield* libraryFor(name)
          if (shared !== undefined) {
            yield* Effect.mapError(shared.removeFile(name, path), toFailure)
            return `Removed ${path} from library skill ${quoted}. ${sharedNote} ${done}`
          }
          yield* Effect.mapError(store.removeFile(botId, name, path), toFailure)
          return `Removed ${path} from skill ${quoted}. ${done}`
        })
    }
  }

  const manageTool: AgentTool = {
    name: "skill_manage",
    description:
      "Create, update, or delete skills — your procedural memory for recurring task types. Actions: " +
      "create (full SKILL.md: YAML frontmatter with name and description, then a markdown body; optional category), " +
      "patch (targeted old_string/new_string fix — preferred; add file_path to fix a supporting file), " +
      "edit (content REPLACES the whole SKILL.md; read it with skill_view first), " +
      "write_file/remove_file (supporting files under references/, templates/, scripts/ or assets/), " +
      "delete (archives the skill). " +
      "Skills marked (library) are shared: you can patch, edit and write files in them (every bot using them gets the change), " +
      "but not delete them, and new skills always go to your own. " +
      "Keep the description a self-contained trigger of at most 60 characters: 'Use when <trigger>. <one-line behavior>.' " +
      "Write lessons, not logs: imperative rule + why, no dates or incident narration, one rule per lesson, " +
      "references/ named by topic (extend before adding). Never put secrets such as API keys in a skill.",
    parameters: jsonSchemaOf(ManageParams),
    needsApproval: false,
    activity: "Saving a skill",
    title: manageTitle,
    run: (raw) => Effect.flatMap(decodeParams(ManageParams, withoutNulls(raw)), manage)
  }

  return [listTool, viewTool, manageTool]
}
