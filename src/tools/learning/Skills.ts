import { Effect, Predicate, Schema } from "effect"
import type { SkillExists, SkillInvalid, SkillNotFound, SkillStorageError, SkillStore } from "../../features/learning/skills/SkillStore.ts"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"

const done = "This update is complete — don't repeat it."

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
      "write_file, remove_file, and optionally patch: path RELATIVE to the skill's own folder, e.g. 'references/api.md' — no leading slash; the first folder is references/, templates/, scripts/ or assets/. patch defaults to SKILL.md."
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

/** The bot's own skills: listing, loading and maintaining them. */
export const skillTools = (options: { readonly store: SkillStore["Service"]; readonly botId: string }): Array<AgentTool> => {
  const { botId, store } = options

  const listTool: AgentTool = {
    name: "skills_list",
    description: "List your skills (name + description). Use skill_view(name) to load full content.",
    parameters: jsonSchemaOf(ListParams),
    needsApproval: false,
    activity: "Checking skills",
    title: () => "Checked skills",
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(ListParams, withoutNulls(raw))
        const category = params.category?.trim() ?? ""
        const all = yield* Effect.mapError(store.list(botId), toFailure)
        const skills = category.length > 0 ? all.filter((skill) => skill.category === category) : all
        if (skills.length === 0) {
          return category.length > 0 && all.length > 0
            ? `No skills in category "${category}".`
            : "You don't have any skills yet. Create one with skill_manage(action='create')."
        }
        const lines = skills.map((skill) =>
          `- ${skill.category.length > 0 ? `${skill.category}/` : ""}${skill.name}: ${skill.description}`
        )
        return `${lines.join("\n")}\n\nUse skill_view(name) to see full content and linked files.`
      })
  }

  const viewTool: AgentTool = {
    name: "skill_view",
    description:
      "Skills allow for loading information about specific tasks and workflows, as well as scripts and templates. " +
      "Load a skill's full content or access its linked files (references, templates, scripts). " +
      "First call returns SKILL.md content plus a list of linked files. To access those, call again with the file_path parameter.",
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
        if (filePath.length > 0) {
          const content = yield* Effect.mapError(store.readFile(botId, name, filePath), toFailure)
          if (content.includes("\u0000")) return `${filePath} is a binary file (${content.length} bytes).`
          return content.length > 0 ? content : "(empty file)"
        }
        const skill = yield* Effect.mapError(store.get(botId, name), toFailure)
        yield* Effect.ignore(store.recordView(botId, name))
        if (skill.files.length === 0) return skill.content
        return `${skill.content}\n\n---\nLinked files (load with skill_view(name='${name}', file_path='...')):\n` +
          skill.files.map((file) => `- ${file}`).join("\n")
      })
  }

  const manage = (params: ManageParams): Effect.Effect<string, ToolFailure> => {
    const name = params.name.trim()
    const quoted = `"${name}"`
    switch (params.action) {
      case "create":
        return Effect.gen(function*() {
          const content = yield* required(params.content, "content", "create")
          yield* Effect.mapError(store.create(botId, { name, content, category: params.category }, "agent"), toFailure)
          return `Created skill ${quoted}. ${done}`
        })
      case "edit":
        return Effect.gen(function*() {
          const content = yield* required(params.content, "content", "edit")
          yield* Effect.mapError(store.replaceContent(botId, name, content, "agent"), toFailure)
          return `Updated skill ${quoted} (full rewrite). ${done}`
        })
      case "patch":
        return Effect.gen(function*() {
          if (params.old_string === undefined && params.new_string === undefined && params.content !== undefined) {
            yield* Effect.mapError(store.replaceContent(botId, name, params.content, "agent"), toFailure)
            return `Updated skill ${quoted} (full rewrite). ${done}`
          }
          const oldString = yield* required(params.old_string, "old_string", "patch")
          const newString = yield* required(params.new_string, "new_string", "patch")
          const count = yield* Effect.mapError(
            store.patch(botId, name, {
              old_string: oldString,
              new_string: newString,
              replace_all: params.replace_all,
              file_path: params.file_path
            }),
            toFailure
          )
          const target = params.file_path ?? "SKILL.md"
          return `Updated ${target} in skill ${quoted} (${count} replacement${count === 1 ? "" : "s"}). ${done}`
        })
      case "delete":
        return Effect.as(Effect.mapError(store.remove(botId, name), toFailure), `Deleted skill ${quoted}. ${done}`)
      case "write_file":
        return Effect.gen(function*() {
          const path = yield* required(params.file_path, "file_path", "write_file")
          const content = yield* required(params.file_content, "file_content", "write_file")
          yield* Effect.mapError(store.writeFile(botId, name, path, content), toFailure)
          return `Wrote ${path} in skill ${quoted}. ${done}`
        })
      case "remove_file":
        return Effect.gen(function*() {
          const path = yield* required(params.file_path, "file_path", "remove_file")
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
