import { Predicate, Schema } from "effect"
import type { McpServerConfig } from "../../features/integrations/McpHub.ts"

/** Tools bots may call. Deleting or moving notes and managing projects stay with the person. */
export const allowedMemoryTools: ReadonlySet<string> = new Set([
  "search_notes",
  "read_note",
  "write_note",
  "edit_note",
  "build_context",
  "recent_activity"
])

export const memoryFolder = "weaver"
export const coreTitle = "Core Memory"
export const corePermalink = "weaver/core-memory"
/** Where Core Memory's previous text is saved before it's condensed. */
export const coreHistoryFolder = "weaver/core-memory-history"
/** Longest Core Memory excerpt added to a system prompt. */
export const coreLimit = 4000
/** How much of the start of an over-long Core Memory the excerpt keeps; the rest of the budget goes to the newest lines. */
export const coreHeadLimit = 1000
export const coreCacheMillis = 60_000

/**
 * The instructions for a bot with memory. `project` names the bot's own project when it doesn't use
 * the shared one, so it knows its notes are kept apart.
 */
export const memoryInstructions = (botName: string, project?: string): string =>
  (project === undefined
    ? `You have long-term memory: a Basic Memory knowledge base of Markdown notes shared by all of the user's bots, ` +
      `so what you save is there for the other bots and what they saved is there for you. `
    : `You have long-term memory: the "${project}" project of the user's Basic Memory knowledge base, Markdown notes ` +
      `kept apart from the shared project and used only by the bots the user put in this project. `) +
  `Before answering anything that may depend on earlier conversations, the user's preferences, people, or projects, search memory first. ` +
  `When you learn something durable (a preference, a fact about the user, a decision, a project detail), save it with write_note in the "${memoryFolder}" directory, ` +
  `or update the existing note with edit_note instead of creating a duplicate. Keep notes short and factual, and don't save secrets such as passwords or API keys. ` +
  `Record who learned what: a note you write ends with the observation "- [source] ${botName}", and a fact you add to an existing note ends with "(via ${botName})".\n\n` +
  `The note "${coreTitle}" (identifier "${corePermalink}") is the shared core memory: the most important facts about the user, their projects and team rules. ` +
  `Every bot reads it at the start of each reply. Add to it only facts that are truly durable and important, with edit_note (operation "append"), ` +
  `one short line each, like "- [fact] The user prefers short answers (via ${botName})"; anything that isn't needed on every reply belongs in a regular note instead. ` +
  `Don't remove or rewrite what's there unless the user asks. It's condensed from time to time (duplicates merged, outdated facts dropped), ` +
  `and older copies are kept in "${coreHistoryFolder}"; those aren't current. ` +
  `Don't describe these tool calls to the user; just use what you find.`

export const corePrompt = (text: string, project?: string): string =>
  `${coreTitle}, shared by ${project === undefined ? "all of the user's bots" : `the bots in the "${project}" project`}:\n"""\n${text}\n"""`

/**
 * Core Memory for the prompt. Facts are appended, so an over-long note keeps its opening lines
 * (identity and standing rules) and its newest lines, dropping whole lines from the middle.
 */
export const coreExcerpt = (markdown: string): string | undefined => {
  const trimmed = markdown.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length <= coreLimit) return trimmed
  const lines = trimmed.split("\n")
  let head = 0
  let headLength = 0
  while (head < lines.length && headLength + lines[head]!.length + 1 <= coreHeadLimit) headLength += lines[head++]!.length + 1
  let tail = lines.length
  let tailLength = 0
  while (tail > head && headLength + tailLength + lines[tail - 1]!.length + 1 <= coreLimit) tailLength += lines[--tail]!.length + 1
  if (head === 0 && tail === lines.length) return `${trimmed.slice(0, coreLimit)}\n… (truncated)`
  const omitted = lines.slice(head, tail).join("\n").length
  return [
    ...lines.slice(0, head),
    `… (${omitted} characters of older facts omitted — ${coreTitle} is being condensed)`,
    ...lines.slice(tail)
  ].join("\n")
}

/** The project a bot's memory lives in: its own when it has one, otherwise the shared one (empty is the server's default). */
export const botMemoryProject = (bot: { readonly memoryProject: string }, shared: string): string => {
  const own = bot.memoryProject.trim()
  return own.length > 0 ? own : shared
}

/** Pins every call to the bot's project so it can't drift into other knowledge bases. */
export const pinProject = (args: Record<string, unknown>, project: string): Record<string, unknown> => {
  const { project: _p, project_id: _pi, projects: _ps, workspace: _w, search_all_projects: _s, ...rest } = args
  return project.length > 0 ? { ...rest, project } : rest
}

/** Adds a `- [source] <bot>` observation to a new note unless the bot already did. */
export const attribute = (args: Record<string, unknown>, botName: string): Record<string, unknown> => {
  const content = args.content
  if (botName.length === 0 || !Predicate.isString(content) || content.includes("[source]")) return args
  const separator = content.endsWith("\n") ? "\n" : "\n\n"
  return { ...args, content: `${content}${separator}- [source] ${botName}` }
}

export const memoryActivity = (name: string): string =>
  name === "write_note" || name === "edit_note" ? "Saving to memory" : "Checking memory"

export const memoryTitle = (name: string) => (params: unknown): string => {
  const args = Predicate.isObject(params) ? params as Record<string, unknown> : {}
  const detail = [args.query, args.title, args.identifier, args.url].find(Predicate.isString)
  const verb = name === "write_note"
    ? "Saved to memory"
    : name === "edit_note"
    ? "Updated memory"
    : name === "search_notes"
    ? "Searched memory"
    : "Checked memory"
  return detail === undefined ? verb : `${verb}: ${detail.slice(0, 60)}`
}

export const memoryServerConfig = (memory: { url: string; token: string }): McpServerConfig => ({
  key: `builtin:memory:${memory.url}`,
  name: "Memory",
  transport: "http",
  command: "",
  args: [],
  env: {},
  url: memory.url,
  headers: memory.token.length > 0 ? { Authorization: `Bearer ${memory.token}` } : {}
})

const ReadNoteJson = Schema.fromJsonString(Schema.Struct({
  content: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Unknown)
}))

/** Pulls the Markdown out of `read_note`'s JSON output; undefined when the note is missing. */
export const noteContent = (text: string): string | undefined => {
  try {
    const decoded = Schema.decodeUnknownSync(ReadNoteJson)(text)
    return decoded.error === undefined ? decoded.content : undefined
  } catch {
    return undefined
  }
}

const NoteWriteJson = Schema.fromJsonString(Schema.Struct({ error: Schema.optional(Schema.Unknown) }))

/** Why a `write_note` or `edit_note` call with JSON output didn't change the note; undefined when it did. */
export const noteWriteError = (text: string): string | undefined => {
  try {
    const { error } = Schema.decodeUnknownSync(NoteWriteJson)(text)
    return error === undefined || error === null ? undefined : String(error)
  } catch {
    return `unexpected answer: ${text.slice(0, 200)}`
  }
}
