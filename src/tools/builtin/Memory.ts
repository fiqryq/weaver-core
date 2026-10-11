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
/** Longest Core Memory excerpt added to a system prompt. */
export const coreLimit = 4000
export const coreCacheMillis = 60_000

export const memoryInstructions = (botName: string): string =>
  `You have long-term memory: a Basic Memory knowledge base of Markdown notes shared by all of the user's bots, ` +
  `so what you save is there for the other bots and what they saved is there for you. ` +
  `Before answering anything that may depend on earlier conversations, the user's preferences, people, or projects, search memory first. ` +
  `When you learn something durable (a preference, a fact about the user, a decision, a project detail), save it with write_note in the "${memoryFolder}" directory, ` +
  `or update the existing note with edit_note instead of creating a duplicate. Keep notes short and factual, and don't save secrets such as passwords or API keys. ` +
  `Record who learned what: a note you write ends with the observation "- [source] ${botName}", and a fact you add to an existing note ends with "(via ${botName})".\n\n` +
  `The note "${coreTitle}" (identifier "${corePermalink}") is the shared core memory: the most important facts about the user, their projects and team rules. ` +
  `Every bot reads it at the start of each reply. Add to it only facts that are truly durable and important, with edit_note (operation "append"), ` +
  `one line each, like "- [fact] The user prefers short answers (via ${botName})". Don't remove or rewrite what's there unless the user asks. ` +
  `Don't describe these tool calls to the user; just use what you find.`

export const corePrompt = (text: string): string => `${coreTitle}, shared by all of the user's bots:\n"""\n${text}\n"""`

export const coreExcerpt = (markdown: string): string | undefined => {
  const trimmed = markdown.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > coreLimit ? `${trimmed.slice(0, coreLimit)}\n… (truncated)` : trimmed
}

/** Pins every call to the shared project so bots can't drift into separate knowledge bases. */
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
