import { createHash } from "node:crypto"
import { Cause, Clock, Context, Duration, Effect, FiberSet, Layer, Option, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { AppConfig } from "../../config/Config.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import { newId, nowIso } from "../../platform/lib/util.ts"
import { botMemoryProject, memoryServerConfig, noteWriteError, pinProject } from "../../tools/builtin/Memory.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import { McpHub } from "../integrations/McpHub.ts"
import { CoreMemory } from "../learning/memory/CoreMemory.ts"
import {
  createdProject,
  directoryPage,
  type NoteFile,
  noteDirectory,
  type NoteListing,
  noteFile,
  observationPage,
  type Page,
  projectListing,
  projectsFolder,
  projectSlug,
  relationPage
} from "./basicMemory.ts"
import { buildGraph } from "./graph.ts"
import {
  MemoryGraph,
  MemoryNoteNotFound,
  MemoryProject,
  MemoryProjectNotFound,
  MemoryProjects,
  MemoryUnavailable,
  MemoryVersionNotFound,
  NoteHistory,
  NoteVersion,
  NoteVersionContent
} from "./Memory.ts"

/** Older versions past this many per note are dropped. */
export const maxVersionsPerNote = 50
/** Pages of 200 notes or 1000 search rows read at most, so a huge project can't stall the server. */
const maxPages = 50
const projectsCacheMillis = 60_000
const graphCacheMillis = 30_000
const readConcurrency = 4
const longestProjectName = 60

interface VersionRow {
  readonly id: string
  readonly project: string
  readonly permalink: string
  readonly title: string
  readonly file_path: string
  readonly size: number
  readonly checksum: string
  readonly source: string
  readonly restored_from: string | null
  readonly created_at: string
}

const toVersion = (row: VersionRow) =>
  new NoteVersion({
    id: row.id,
    project: row.project,
    permalink: row.permalink,
    title: row.title,
    filePath: row.file_path,
    size: row.size,
    checksum: row.checksum,
    source: row.source,
    restoredFrom: row.restored_from,
    createdAt: row.created_at
  })

const checksumOf = (content: string): string => createHash("sha256").update(content).digest("hex")

/** The note a `write_note` or `edit_note` call changes, as `read_note` finds it. */
export const writeTarget = (tool: string, params: Record<string, unknown>): string | undefined => {
  if (tool === "edit_note") return typeof params.identifier === "string" ? params.identifier : undefined
  if (tool !== "write_note" || typeof params.title !== "string") return undefined
  const directory = typeof params.directory === "string" ? params.directory.replace(/^\/+|\/+$/g, "") : ""
  return directory.length > 0 ? `${directory}/${params.title}` : params.title
}

/**
 * The person's view of Basic Memory: its projects, a summary of each project's knowledge graph, and
 * every version of a note. Basic Memory keeps no history of its own, so Weaver saves a note's text
 * before and after a bot changes it, when its history is opened, and on a timer that notices edits
 * made anywhere else.
 */
export class KnowledgeBase extends Context.Service<KnowledgeBase, {
  readonly projects: Effect.Effect<MemoryProjects, MemoryUnavailable>
  createProject(name: string): Effect.Effect<MemoryProject, MemoryUnavailable | BadRequest | Conflict>
  /** Stops Basic Memory tracking the project; its notes stay in their folder. */
  removeProject(name: string): Effect.Effect<void, MemoryUnavailable | MemoryProjectNotFound | BadRequest>
  /** The project's graph, cached for half a minute unless `refresh`. Empty `project` is the shared one. */
  graph(project: string, refresh?: boolean): Effect.Effect<MemoryGraph, MemoryUnavailable>
  history(project: string, identifier: string): Effect.Effect<NoteHistory, MemoryUnavailable | MemoryNoteNotFound>
  version(id: string): Effect.Effect<NoteVersionContent, MemoryVersionNotFound>
  /** Puts the version's text back as the note's current text, saving what it replaces first. */
  restore(id: string, source: string): Effect.Effect<NoteVersion, MemoryUnavailable | MemoryVersionNotFound>
  /** Saves the note's current text as a version if it changed. Never fails. */
  capture(project: string, identifier: string, source: string): Effect.Effect<void>
  /** Like `capture`, without waiting for it. */
  captureLater(project: string, identifier: string, source: string): Effect.Effect<void>
  /** Saves a version of every note in the project that changed since its last one; returns how many. */
  sweep(project: string): Effect.Effect<number, MemoryUnavailable>
}>()("weaver/KnowledgeBase") {
  static readonly layer = Layer.effect(
    KnowledgeBase,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const hub = yield* McpHub
      const sql = yield* SqlClient.SqlClient
      const bots = yield* BotRepo
      const coreMemory = yield* CoreMemory
      const background = yield* FiberSet.make<void, never>()
      const recording = Semaphore.makeUnsafe(1)
      const graphs = new Map<string, { readonly at: number; readonly graph: MemoryGraph }>()
      const memory = Option.getOrUndefined(config.memory)

      const unavailable = (message: string) => new MemoryUnavailable({ message })

      /** Calls a Basic Memory tool, pinned to `project` when given; a tool error fails with its text. */
      const call = (name: string, args: Record<string, unknown>, project?: string) =>
        memory === undefined
          ? Effect.fail(unavailable("Memory isn't set up on the agent server (WEAVER_MEMORY_URL)."))
          : hub.call(memoryServerConfig(memory), name, project === undefined ? args : pinProject(args, project)).pipe(
            Effect.mapError((error) => unavailable(error.message)),
            Effect.flatMap((result) => (result.isError ? Effect.fail(unavailable(result.text.slice(0, 500))) : Effect.succeed(result.text)))
          )

      const unexpected = (tool: string, output: string) =>
        unavailable(`Basic Memory's ${tool} answered in an unexpected format: ${output.slice(0, 200)}`)

      let listed: { readonly at: number; readonly value: NonNullable<ReturnType<typeof projectListing>> } | undefined
      const listing = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        if (listed !== undefined && now - listed.at < projectsCacheMillis) return listed.value
        const output = yield* call("list_memory_projects", { output_format: "json" })
        const value = projectListing(output)
        if (value === undefined) return yield* unexpected("list_memory_projects", output)
        listed = { at: now, value }
        return value
      })
      const forgetListing = Effect.sync(() => {
        listed = undefined
      })

      const sharedName = (defaultProject: string | undefined) => memory?.project || defaultProject || ""

      /** A project name for storage: empty means the shared project. */
      const resolve = (project: string) =>
        project.trim().length > 0
          ? Effect.succeed(project.trim())
          : Effect.map(listing, (value) => sharedName(value.defaultProject))

      /** Forgets Core Memory for the project, which bots of the shared project cache under an empty name. */
      const invalidateCore = (project: string) =>
        Effect.gen(function*() {
          yield* coreMemory.invalidate(project)
          if (project === sharedName(listed?.value.defaultProject)) yield* coreMemory.invalidate("")
        })

      const collect = <A>(tool: string, fetch: (page: number) => Effect.Effect<string, MemoryUnavailable>, decode: (output: string) => Page<A> | undefined) =>
        Effect.gen(function*() {
          const items: Array<A> = []
          for (let page = 1; page <= maxPages; page++) {
            const output = yield* fetch(page)
            const decoded = decode(output)
            if (decoded === undefined) return yield* unexpected(tool, output)
            items.push(...decoded.items)
            if (!decoded.hasMore || decoded.items.length === 0) break
          }
          return items
        })

      const listNotes = (project: string) =>
        collect(
          "list_directory",
          (page) =>
            call("list_directory", { dir_name: "/", depth: 10, file_name_glob: "*.md", page, page_size: 200, output_format: "json" }, project),
          directoryPage
        )

      const searchAll = <A>(project: string, type: "observation" | "relation", decode: (output: string) => Page<A> | undefined) =>
        collect(
          "search_notes",
          (page) => call("search_notes", { entity_types: [type], page, page_size: 1000, output_format: "json" }, project),
          decode
        )

      const noteCount = (project: string) =>
        call("list_directory", { dir_name: "/", depth: 10, file_name_glob: "*.md", page_size: 1, output_format: "json" }, project).pipe(
          Effect.map((output) => directoryPage(output)?.total ?? null),
          Effect.orElseSucceed(() => null)
        )

      const projects = Effect.gen(function*() {
        const { projects, defaultProject } = yield* listing
        const shared = sharedName(defaultProject)
        const all = yield* bots.list
        const counts = yield* Effect.forEach(projects, (project) => noteCount(project.name), { concurrency: readConcurrency })
        return new MemoryProjects({
          shared,
          projects: projects.map((project, index) =>
            new MemoryProject({
              name: project.name,
              path: project.path,
              isDefault: project.isDefault,
              isShared: project.name === shared,
              botIds: all
                .filter((bot) => bot.tools.includes("memory") && botMemoryProject(bot, shared) === project.name)
                .map((bot) => bot.id),
              notes: counts[index] ?? null
            })
          )
        })
      })

      const createProject = Effect.fn("KnowledgeBase.createProject")(function*(rawName: string) {
        const name = rawName.trim()
        const slug = projectSlug(name)
        if (name.length === 0 || slug.length === 0) return yield* new BadRequest({ message: "Give the project a name with letters or numbers." })
        if (name.length > longestProjectName) {
          return yield* new BadRequest({ message: `Keep the name under ${longestProjectName} characters.` })
        }
        const { projects, defaultProject } = yield* listing
        if (projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) {
          return yield* new Conflict({ message: `There's already a project called ${name}.` })
        }
        const anchor = projects.find((project) => project.name === sharedName(defaultProject)) ?? projects.find((project) => project.isDefault)
        const folder = config.memoryProjectsDir || (anchor === undefined || anchor.path.length === 0 ? undefined : projectsFolder(anchor.path))
        if (folder === undefined) {
          return yield* new BadRequest({ message: "Couldn't tell where Basic Memory keeps its notes. Set WEAVER_MEMORY_PROJECTS_DIR." })
        }
        if (memory === undefined) return yield* unavailable("Memory isn't set up on the agent server (WEAVER_MEMORY_URL).")
        const result = yield* hub.call(memoryServerConfig(memory), "create_memory_project", {
          project_name: name,
          project_path: `${folder}/${slug}`,
          output_format: "json"
        }).pipe(Effect.mapError((error) => unavailable(error.message)))
        yield* forgetListing
        if (result.isError) return yield* new BadRequest({ message: result.text.slice(0, 500) })
        const created = createdProject(result.text)
        if (created === undefined) return yield* unexpected("create_memory_project", result.text)
        return new MemoryProject({ ...created, isShared: false, botIds: [], notes: 0 })
      })

      const removeProject = Effect.fn("KnowledgeBase.removeProject")(function*(name: string) {
        const { projects, defaultProject } = yield* listing
        const project = projects.find((candidate) => candidate.name === name)
        if (project === undefined) return yield* new MemoryProjectNotFound({ name })
        if (project.name === sharedName(defaultProject)) {
          return yield* new BadRequest({ message: `${name} is the shared project every bot uses by default, so it can't be removed.` })
        }
        if (project.isDefault) return yield* new BadRequest({ message: `${name} is Basic Memory's default project, so it can't be removed.` })
        const users = (yield* bots.list).filter((bot) => bot.memoryProject.trim() === name)
        if (users.length > 0) {
          return yield* new BadRequest({
            message: `${users.map((bot) => bot.name).join(", ")} ${users.length === 1 ? "uses" : "use"} ${name}. Move ${
              users.length === 1 ? "it" : "them"
            } to another project first.`
          })
        }
        yield* call("delete_project", { project_name: name, delete_notes: false }).pipe(Effect.ensuring(forgetListing))
        graphs.delete(name)
      })

      const graph = (project: string, refresh = false) =>
        Effect.gen(function*() {
          const name = yield* resolve(project)
          const now = yield* Clock.currentTimeMillis
          const cached = graphs.get(name)
          if (!refresh && cached !== undefined && now - cached.at < graphCacheMillis) return cached.graph
          const [notes, observations, relations] = yield* Effect.all([
            listNotes(name),
            searchAll(name, "observation", observationPage),
            searchAll(name, "relation", relationPage)
          ], { concurrency: "unbounded" })
          const built = buildGraph({ project: name, notes, observations, relations, generatedAt: new Date(now).toISOString() })
          graphs.set(name, { at: now, graph: built })
          return built
        })

      // MARK: History

      const readFile = (project: string, identifier: string) =>
        call("read_note", { identifier, output_format: "json", include_frontmatter: true }, project).pipe(Effect.map(noteFile))

      const versionColumns = sql`id, project, permalink, title, file_path, length(CAST(content AS BLOB)) AS size,
        checksum, source, restored_from, created_at`

      const latest = (project: string, permalink: string) =>
        sql<{ readonly id: string; readonly checksum: string; readonly note_updated_at: string }>`
          SELECT id, checksum, note_updated_at FROM memory_versions
          WHERE project = ${project} AND permalink = ${permalink}
          ORDER BY created_at DESC, rowid DESC LIMIT 1`.pipe(Effect.map((rows) => rows[0]), Effect.orDie)

      /** Saves `file` unless it matches the newest version. Returns the version that now matches the note. */
      const record = (project: string, file: NoteFile, options: {
        readonly source: string
        readonly updatedAt?: string
        readonly restoredFrom?: string
      }) =>
        recording.withPermit(Effect.gen(function*() {
          const checksum = checksumOf(file.content)
          const last = yield* latest(project, file.permalink)
          if (last !== undefined && last.checksum === checksum) {
            if (options.updatedAt !== undefined && options.updatedAt !== last.note_updated_at) {
              yield* sql`UPDATE memory_versions SET note_updated_at = ${options.updatedAt} WHERE id = ${last.id}`.pipe(Effect.orDie)
            }
            return { id: last.id, created: false }
          }
          const id = newId()
          yield* sql`INSERT INTO memory_versions ${
            sql.insert({
              id,
              project,
              permalink: file.permalink,
              title: file.title,
              file_path: file.filePath,
              content: file.content,
              checksum,
              source: options.source,
              restored_from: options.restoredFrom ?? null,
              note_updated_at: options.updatedAt ?? "",
              created_at: yield* nowIso
            })
          }`.pipe(Effect.orDie)
          yield* sql`
            DELETE FROM memory_versions WHERE project = ${project} AND permalink = ${file.permalink} AND id NOT IN (
              SELECT id FROM memory_versions WHERE project = ${project} AND permalink = ${file.permalink}
              ORDER BY created_at DESC, rowid DESC LIMIT ${maxVersionsPerNote}
            )`.pipe(Effect.orDie)
          return { id, created: true }
        }))

      const capture = (project: string, identifier: string, source: string) =>
        Effect.gen(function*() {
          const name = yield* resolve(project)
          const file = yield* readFile(name, identifier)
          if (file !== undefined) yield* record(name, file, { source })
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logDebug(`Couldn't save a version of ${identifier}`, cause)
          )
        )

      const sweep = Effect.fn("KnowledgeBase.sweep")(function*(project: string) {
        const name = yield* resolve(project)
        const notes = yield* listNotes(name)
        const known = new Map(
          (yield* sql<{ readonly permalink: string; readonly note_updated_at: string }>`
            SELECT permalink, note_updated_at, max(rowid) FROM memory_versions WHERE project = ${name} GROUP BY permalink`.pipe(
            Effect.orDie
          )).map((row) => [row.permalink, row.note_updated_at])
        )
        const changed = notes.filter((note: NoteListing) => known.get(note.permalink) !== note.updatedAt)
        const saved = yield* Effect.forEach(changed, (note) =>
          readFile(name, note.permalink).pipe(
            Effect.flatMap((file) =>
              file === undefined
                ? Effect.succeed(false)
                : Effect.map(record(name, file, { source: "", updatedAt: note.updatedAt }), (result) => result.created)
            ),
            Effect.orElseSucceed(() => false)
          ), { concurrency: readConcurrency })
        return saved.filter(Boolean).length
      })

      const history = Effect.fn("KnowledgeBase.history")(function*(project: string, identifier: string) {
        const name = yield* resolve(project)
        const file = yield* readFile(name, identifier)
        if (file === undefined) return yield* new MemoryNoteNotFound({ identifier })
        yield* record(name, file, { source: "" })
        const rows = yield* sql<VersionRow>`
          SELECT ${versionColumns} FROM memory_versions
          WHERE project = ${name} AND permalink = ${file.permalink}
          ORDER BY created_at DESC, rowid DESC`.pipe(Effect.orDie)
        return new NoteHistory({
          project: name,
          permalink: file.permalink,
          title: file.title,
          filePath: file.filePath,
          versions: rows.map(toVersion)
        })
      })

      const versionRow = (id: string) =>
        Effect.gen(function*() {
          const rows = yield* sql<VersionRow & { readonly content: string }>`
            SELECT ${versionColumns}, content FROM memory_versions WHERE id = ${id}`.pipe(Effect.orDie)
          const row = rows[0]
          return row === undefined ? yield* new MemoryVersionNotFound({ id }) : row
        })

      const version = (id: string) =>
        Effect.map(versionRow(id), (row) => new NoteVersionContent({ version: toVersion(row), content: row.content }))

      const restore = Effect.fn("KnowledgeBase.restore")(function*(id: string, source: string) {
        const row = yield* versionRow(id)
        const current = yield* readFile(row.project, row.permalink)
        if (current !== undefined) {
          yield* record(row.project, current, { source: "" })
          if (checksumOf(current.content) === row.checksum) return toVersion(row)
        }
        const output = yield* call("write_note", {
          title: current?.title ?? row.title,
          directory: noteDirectory(current?.filePath ?? row.file_path),
          content: row.content,
          overwrite: true,
          output_format: "json"
        }, row.project)
        const error = noteWriteError(output)
        if (error !== undefined) return yield* unavailable(`Couldn't restore ${row.title}: ${error}`)
        yield* invalidateCore(row.project)
        graphs.delete(row.project)
        const restored = yield* readFile(row.project, row.permalink)
        if (restored === undefined) return yield* unavailable(`${row.title} disappeared while it was being restored.`)
        const saved = yield* record(row.project, restored, { source, restoredFrom: row.id })
        return toVersion((yield* versionRow(saved.id)))
      })

      const captureLater = (project: string, identifier: string, source: string) =>
        Effect.asVoid(FiberSet.run(background, capture(project, identifier, source)))

      if (memory !== undefined && config.memoryHistoryMinutes > 0) {
        const sweepAll = Effect.gen(function*() {
          const { projects } = yield* listing
          for (const project of projects) {
            const saved = yield* sweep(project.name)
            if (saved > 0) yield* Effect.logDebug(`Saved ${saved} changed note${saved === 1 ? "" : "s"} in ${project.name}`)
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logDebug("Checking memory notes for changes failed", cause)
          )
        )
        yield* FiberSet.run(background, Effect.forever(Effect.andThen(Effect.sleep(Duration.minutes(config.memoryHistoryMinutes)), sweepAll)))
      }

      return KnowledgeBase.of({
        projects,
        createProject,
        removeProject,
        graph,
        history,
        version,
        restore,
        capture,
        captureLater,
        sweep: (project) =>
          Effect.tap(sweep(project), (saved) => (saved > 0 ? invalidateCore(project) : Effect.void))
      })
    })
  )
}
