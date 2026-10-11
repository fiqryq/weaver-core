import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"

export const sessionSearchGuidance =
  "When the user references something from a past conversation or you suspect relevant cross-session context exists, " +
  "use session_search to recall it before asking them to repeat themselves."

/** Longest message text shown in results. */
const messageLimit = 2000
/** FTS rows ranked before keeping the best one per conversation. */
const scanLimit = 300
const maxQueryLength = 2048
/** Messages on each side of the top result's match. */
const hitWindow = 3
/** Conversations up to this long are read whole; longer ones show their start and end. */
const readHead = 20
const readTail = 10

const Params = Schema.Struct({
  query: Schema.optional(Schema.String).annotate({
    description: "Search query. Keywords, phrases, or boolean expressions to find in past conversations. " +
      "Omit to list recent conversations. Ignored when conversation_id is set."
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max conversations to return (default 3, max 10; when listing, default 10, max 20). " +
      "Bump to 5–10 when the topic likely spans several conversations and you want to pick the right one to read."
  }),
  conversation_id: Schema.optional(Schema.String).annotate({
    description: "Read inside one conversation (a conversation_id from an earlier result). " +
      "Alone it reads the conversation; with around_message_id it shows a window around that message."
  }),
  around_message_id: Schema.optional(Schema.String).annotate({
    description: "Message id to center the window on — a match's message id, or any id from an earlier window."
  }),
  window: Schema.optional(Schema.Number).annotate({
    description: "Messages to show on each side of around_message_id (1–20, default 5)."
  })
})

const description =
  "Recall past conversations: search or read your earlier conversations with the user (full-text search), or " +
  "scroll inside one. Three shapes, picked by args: `query` = discovery (top matching conversations, the top " +
  "result with the messages around the match); `conversation_id` (+ optional `around_message_id`, `window`) = " +
  "read a conversation or scroll around a message; no args = list recent conversations. Results are the actual " +
  "messages. Searches conversation history ONLY — when the user gave a direct source (URL, file, live system), " +
  "inspect that first; never conclude 'not found' from history alone. Use for questions about past conversations: " +
  "'what did we do about X', 'where did we leave Y'. The current conversation is already in your context and is " +
  "not searched."

const noMatchHint =
  "FTS5 ANDs all terms by default — broaden with OR (`alpha OR beta`), exact-match with quoted phrases, " +
  "exclude with NOT, or prefix-match with `deploy*`."

/**
 * Makes free text safe for FTS5 MATCH: keeps balanced quoted phrases and `*` prefixes, turns other
 * punctuation the grammar rejects into spaces, drops dangling operators and quotes dotted or
 * hyphenated terms so they match as phrases (`chat-send`, `v2.1`).
 */
export const sanitizeQuery = (query: string): string => {
  const quoted: Array<string> = []
  let text = query.slice(0, maxQueryLength).replace(/\u0000/g, " ").replace(/"[^"]*"/g, (phrase) => {
    quoted.push(phrase)
    return `\u0000${quoted.length - 1}\u0000`
  })
  text = text.replace(/[^\p{L}\p{N}\p{M}_\s*.\-\u0000]/gu, " ")
  text = text.replace(/(?<![\p{L}\p{N}_])[.\-]+|[.\-]+(?![\p{L}\p{N}_])/gu, " ")
  text = text.replace(/\*+/g, "*").replace(/(^|[^\p{L}\p{N}_])\*/gu, "$1")
  text = text.trim().replace(/^(AND|OR|NOT)(\s+|$)/, "")
  text = text.trim().replace(/(^|\s+)(AND|OR|NOT)$/, "")
  text = text.replace(/[\p{L}\p{N}_]+(?:[.\-][\p{L}\p{N}_]+)+/gu, (term) => `"${term}"`)
  quoted.forEach((phrase, index) => {
    text = text.replace(`\u0000${index}\u0000`, () => phrase)
  })
  return text.trim()
}

interface MessageRow {
  readonly seq: number
  readonly id: string
  readonly conversation_id: string
  readonly role: string
  readonly sender_name: string
  readonly parts: string
  readonly created_at: string
}

interface ConversationRow {
  readonly id: string
  readonly title: string
  readonly updated_at: string
}

const textOf = (parts: string): string => {
  try {
    const decoded: unknown = JSON.parse(parts)
    if (!Array.isArray(decoded)) return ""
    return decoded
      .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("\n\n")
      .trim()
  } catch {
    return ""
  }
}

const clamp = (value: number | undefined, fallback: number, low: number, high: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.min(Math.max(Math.trunc(value), low), high)

const formatMessage = (row: MessageRow, anchor?: string): string => {
  const sender = row.role === "user" ? row.sender_name || "User" : row.sender_name || "Bot"
  const text = textOf(row.parts)
  const body = text.length > messageLimit ? `${text.slice(0, messageLimit)}… (cut)` : text || "(no text)"
  const marker = row.id === anchor ? "→ " : ""
  return `${marker}[message ${row.id}] ${row.created_at} ${sender}: ${body}`
}

const formatConversation = (conversation: ConversationRow): string =>
  `"${conversation.title || "(untitled)"}" (conversation_id: ${conversation.id}, last active ${conversation.updated_at})`

/**
 * `session_search`: recall from the bot's earlier conversations. Read-only, no approval.
 *
 * - `sql`: the server's SQLite client (the `message_search` FTS5 table comes from migration 0002).
 * - `botId`: only conversations this bot takes part in are visible.
 * - `currentConversationId`: excluded, since it's already in the bot's context.
 */
export const sessionSearchTool = (options: {
  readonly sql: SqlClient.SqlClient
  readonly botId: string
  readonly currentConversationId: string
}): AgentTool => {
  const { sql, botId, currentConversationId } = options
  const failure = (message: string) => new ToolFailure({ message })

  const inScope = sql`
    SELECT conversation_id FROM conversation_bots
    WHERE bot_id = ${botId} AND conversation_id != ${currentConversationId}`

  const conversation = (id: string) =>
    Effect.gen(function*() {
      if (id === currentConversationId) {
        return yield* failure("That's the current conversation; it's already in your context.")
      }
      const rows = yield* sql<ConversationRow>`
        SELECT id, title, updated_at FROM conversations
        WHERE id = ${id} AND id IN (${inScope})`
      const row = rows[0]
      if (row === undefined) return yield* failure(`There's no earlier conversation of yours with id ${id}.`)
      return row
    })

  const messageColumns = sql`seq, id, conversation_id, role, sender_name, parts, created_at`

  const around = (conversationId: string, seq: number, size: number) =>
    Effect.gen(function*() {
      const before = yield* sql<MessageRow>`
        SELECT ${messageColumns} FROM messages
        WHERE conversation_id = ${conversationId} AND status != 'streaming' AND seq < ${seq}
        ORDER BY seq DESC LIMIT ${size}`
      const anchor = yield* sql<MessageRow>`SELECT ${messageColumns} FROM messages WHERE seq = ${seq}`
      const after = yield* sql<MessageRow>`
        SELECT ${messageColumns} FROM messages
        WHERE conversation_id = ${conversationId} AND status != 'streaming' AND seq > ${seq}
        ORDER BY seq LIMIT ${size}`
      const counts = yield* sql<{ before: number; after: number }>`
        SELECT
          (SELECT count(*) FROM messages WHERE conversation_id = ${conversationId} AND seq < ${seq}) AS before,
          (SELECT count(*) FROM messages WHERE conversation_id = ${conversationId} AND seq > ${seq}) AS after`
      return {
        messages: [...[...before].reverse(), ...anchor, ...after],
        earlier: Math.max((counts[0]?.before ?? 0) - before.length, 0),
        later: Math.max((counts[0]?.after ?? 0) - after.length, 0)
      }
    })

  const discover = (query: string, limit: number) =>
    Effect.gen(function*() {
      const match = sanitizeQuery(query)
      if (match.length === 0) return yield* failure(`The query has no searchable words. ${noMatchHint}`)
      const hits = yield* sql<{ seq: number; id: string; conversation_id: string; snippet: string }>`
        SELECT m.seq, m.id, m.conversation_id,
          snippet(message_search, 0, '**', '**', '…', 24) AS snippet
        FROM message_search JOIN messages m ON m.seq = message_search.rowid
        WHERE message_search MATCH ${match} AND m.conversation_id IN (${inScope})
        ORDER BY bm25(message_search) LIMIT ${scanLimit}`.pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(failure(`Couldn't parse the search query ${JSON.stringify(query)}. ${noMatchHint}`)))
      )
      const best = new Map<string, (typeof hits)[number]>()
      for (const hit of hits) {
        if (best.size >= limit) break
        if (!best.has(hit.conversation_id)) best.set(hit.conversation_id, hit)
      }
      if (best.size === 0) return `No matching conversations found for ${JSON.stringify(query)}. ${noMatchHint}`

      const sections: Array<string> = []
      let index = 0
      for (const hit of best.values()) {
        index++
        const info = yield* conversation(hit.conversation_id)
        if (index === 1) {
          const view = yield* around(hit.conversation_id, hit.seq, hitWindow)
          sections.push([
            `${index}. ${formatConversation(info)}`,
            ...(view.earlier > 0 ? [`   (${view.earlier} earlier messages)`] : []),
            ...view.messages.map((row) => `   ${formatMessage(row, hit.id)}`),
            ...(view.later > 0 ? [`   (${view.later} later messages)`] : [])
          ].join("\n"))
        } else {
          const rows = yield* sql<MessageRow>`SELECT ${messageColumns} FROM messages WHERE seq = ${hit.seq}`
          const row = rows[0]
          const sender = row === undefined ? "" : row.role === "user" ? row.sender_name || "User" : row.sender_name
          sections.push(
            `${index}. ${formatConversation(info)}\n   → [message ${hit.id}] ${row?.created_at ?? ""} ${sender}: ${
              hit.snippet.replace(/\s+/g, " ").trim()
            }`
          )
        }
      }
      return `Found ${best.size} conversation${best.size === 1 ? "" : "s"} matching ${JSON.stringify(query)} ` +
        `(→ marks the matching message):\n\n${sections.join("\n\n")}\n\n` +
        `To read more around a match, call session_search with conversation_id and around_message_id.`
    })

  const scroll = (conversationId: string, messageId: string, size: number) =>
    Effect.gen(function*() {
      const info = yield* conversation(conversationId)
      const anchor = yield* sql<{ seq: number }>`
        SELECT seq FROM messages WHERE id = ${messageId} AND conversation_id = ${conversationId}`
      if (anchor[0] === undefined) {
        return yield* failure(`Message ${messageId} isn't in conversation ${conversationId}.`)
      }
      const view = yield* around(conversationId, anchor[0].seq, size)
      return [
        formatConversation(info),
        ...(view.earlier > 0 ? [`(${view.earlier} earlier messages)`] : ["(start of the conversation)"]),
        ...view.messages.map((row) => formatMessage(row, messageId)),
        ...(view.later > 0 ? [`(${view.later} later messages)`] : ["(end of the conversation)"]),
        "",
        "Scroll forward with around_message_id set to the last message's id, backward with the first one's."
      ].join("\n")
    })

  const read = (conversationId: string) =>
    Effect.gen(function*() {
      const info = yield* conversation(conversationId)
      const rows = yield* sql<MessageRow>`
        SELECT ${messageColumns} FROM messages
        WHERE conversation_id = ${conversationId} AND status != 'streaming'
        ORDER BY seq`
      if (rows.length === 0) return `${formatConversation(info)}\n(no messages)`
      const truncated = rows.length > readHead + readTail
      const shown = truncated
        ? [
          ...rows.slice(0, readHead).map((row) => formatMessage(row)),
          `… (${rows.length - readHead - readTail} messages in between)`,
          ...rows.slice(-readTail).map((row) => formatMessage(row))
        ]
        : rows.map((row) => formatMessage(row))
      return [
        `${formatConversation(info)}, ${rows.length} messages:`,
        ...shown,
        ...(truncated ? ["", "Pass around_message_id (any id above) to scroll the middle."] : [])
      ].join("\n")
    })

  const browse = (limit: number) =>
    Effect.gen(function*() {
      const rows = yield* sql<ConversationRow & { message_count: number; preview: string | null }>`
        SELECT c.id, c.title, c.updated_at,
          (SELECT count(*) FROM messages WHERE conversation_id = c.id) AS message_count,
          (SELECT parts FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY seq LIMIT 1) AS preview
        FROM conversations c
        WHERE c.id IN (${inScope})
        ORDER BY c.updated_at DESC LIMIT ${limit}`
      if (rows.length === 0) return "You have no earlier conversations."
      const lines = rows.map((row) => {
        const preview = row.preview === null ? "" : shorten(textOf(row.preview), 120)
        return `- ${formatConversation(row)}, ${row.message_count} messages${preview ? ` — "${preview}"` : ""}`
      })
      return `Your ${rows.length} most recent conversations:\n${lines.join("\n")}\n\n` +
        `Pass a query to search, or conversation_id to read one.`
    })

  return {
    name: "session_search",
    description,
    parameters: jsonSchemaOf(Params),
    needsApproval: false,
    activity: "Looking through past conversations",
    title: (params) => {
      const query = (params as { query?: unknown } | null)?.query
      return typeof query === "string" && query.trim().length > 0
        ? `Searched past conversations: ${shorten(query, 60)}`
        : "Looked through past conversations"
    },
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(Params, raw)
        const conversationId = params.conversation_id?.trim()
        if (conversationId) {
          const anchor = params.around_message_id?.trim()
          return yield* anchor
            ? scroll(conversationId, anchor, clamp(params.window, 5, 1, 20))
            : read(conversationId)
        }
        const query = params.query?.trim()
        if (query) return yield* discover(query, clamp(params.limit, 3, 1, 10))
        return yield* browse(clamp(params.limit, 10, 1, 20))
      }).pipe(
        Effect.catchTag("SqlError", (error) => Effect.fail(failure(`Couldn't search conversations: ${error.message}`)))
      )
  }
}
