import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { newId, nowIso } from "../../platform/lib/util.ts"
import {
  Conversation,
  ConversationNotFound,
  Message,
  MessagePart,
  type MessageRole,
  type MessageStatus,
  MessageStatus as MessageStatusSchema
} from "./Conversation.ts"

interface ConversationRow {
  readonly id: string
  readonly title: string
  readonly created_at: string
  readonly updated_at: string
}

interface MessageRow {
  readonly seq: number
  readonly id: string
  readonly conversation_id: string
  readonly role: string
  readonly bot_id: string | null
  readonly sender_name: string
  readonly parts: string
  readonly reply_quote: string | null
  readonly hidden: number
  readonly status: string
  readonly error: string | null
  readonly provider_id: string | null
  readonly model: string | null
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly created_at: string
  readonly finished_at: string | null
}

const PartsJson = Schema.fromJsonString(Schema.Array(MessagePart))
const decodeParts = Schema.decodeUnknownSync(PartsJson)
const isStatus = Schema.is(MessageStatusSchema)

const messageFromRow = (row: MessageRow): Message =>
  new Message({
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role === "user" ? "user" : "assistant",
    botId: row.bot_id,
    senderName: row.sender_name,
    parts: (() => {
      try {
        return decodeParts(row.parts)
      } catch {
        return []
      }
    })(),
    replyQuote: row.reply_quote,
    hidden: row.hidden === 1,
    status: isStatus(row.status) ? row.status : "done",
    error: row.error,
    providerId: row.provider_id,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  })

const isFinished = (status: MessageStatus) => status !== "streaming"

export interface NewMessage {
  readonly conversationId: string
  readonly role: MessageRole
  readonly botId?: string | null
  readonly senderName?: string
  readonly parts?: ReadonlyArray<MessagePart>
  readonly replyQuote?: string | null
  readonly hidden?: boolean
  readonly status?: MessageStatus
  readonly providerId?: string | null
  readonly model?: string | null
}

export interface MessagePatch {
  readonly parts?: ReadonlyArray<MessagePart>
  readonly status?: MessageStatus
  readonly error?: string | null
  readonly promptTokens?: number
  readonly completionTokens?: number
}

export class ConversationRepo extends Context.Service<ConversationRepo, {
  readonly list: Effect.Effect<ReadonlyArray<Conversation>>
  get(id: string): Effect.Effect<Conversation, ConversationNotFound>
  create(input: { title: string; botIds: ReadonlyArray<string> }): Effect.Effect<Conversation>
  update(id: string, input: { title?: string | undefined; botIds?: ReadonlyArray<string> | undefined }): Effect.Effect<
    Conversation,
    ConversationNotFound
  >
  remove(id: string): Effect.Effect<void, ConversationNotFound>
  messages(conversationId: string, after?: number): Effect.Effect<ReadonlyArray<Message>>
  getMessage(id: string): Effect.Effect<Message | undefined>
  insertMessage(input: NewMessage): Effect.Effect<Message>
  updateMessage(id: string, patch: MessagePatch): Effect.Effect<Message | undefined>
  deleteMessages(ids: ReadonlyArray<string>): Effect.Effect<void>
  /** Marks replies left streaming by a crash or restart as failed. */
  readonly markInterrupted: Effect.Effect<number>
}>()("weaver/ConversationRepo") {
  static readonly layer = Layer.effect(
    ConversationRepo,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const botIdsFor = (conversationId: string) =>
        sql<{ bot_id: string }>`
          SELECT bot_id FROM conversation_bots WHERE conversation_id = ${conversationId} ORDER BY position`.pipe(
          Effect.map((rows) => rows.map((row) => row.bot_id))
        )

      const toConversation = (row: ConversationRow) =>
        Effect.map(botIdsFor(row.id), (botIds) =>
          new Conversation({
            id: row.id,
            title: row.title,
            botIds,
            createdAt: row.created_at,
            updatedAt: row.updated_at
          }))

      const list = sql<ConversationRow>`SELECT * FROM conversations ORDER BY updated_at DESC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, toConversation)),
        Effect.orDie
      )

      const get = Effect.fn("ConversationRepo.get")(function*(id: string) {
        const rows = yield* sql<ConversationRow>`SELECT * FROM conversations WHERE id = ${id}`.pipe(Effect.orDie)
        const row = rows[0]
        if (row === undefined) return yield* new ConversationNotFound({ id })
        return yield* Effect.orDie(toConversation(row))
      })

      const setBots = (conversationId: string, botIds: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          yield* sql`DELETE FROM conversation_bots WHERE conversation_id = ${conversationId}`
          const unique = [...new Set(botIds)]
          if (unique.length > 0) {
            yield* sql`INSERT INTO conversation_bots ${
              sql.insert(unique.map((botId, position) => ({ conversation_id: conversationId, bot_id: botId, position })))
            }`
          }
        })

      const create = Effect.fn("ConversationRepo.create")(function*(input: {
        title: string
        botIds: ReadonlyArray<string>
      }) {
        const id = newId()
        const now = yield* nowIso
        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO conversations ${
            sql.insert({ id, title: input.title, created_at: now, updated_at: now })
          }`
          yield* setBots(id, input.botIds)
        })).pipe(Effect.orDie)
        return yield* Effect.orDie(get(id))
      })

      const update = Effect.fn("ConversationRepo.update")(function*(
        id: string,
        input: { title?: string | undefined; botIds?: ReadonlyArray<string> | undefined }
      ) {
        yield* get(id)
        const now = yield* nowIso
        yield* sql.withTransaction(Effect.gen(function*() {
          if (input.title !== undefined) {
            yield* sql`UPDATE conversations SET title = ${input.title}, updated_at = ${now} WHERE id = ${id}`
          }
          if (input.botIds !== undefined) yield* setBots(id, input.botIds)
        })).pipe(Effect.orDie)
        return yield* get(id)
      })

      const remove = Effect.fn("ConversationRepo.remove")(function*(id: string) {
        yield* get(id)
        yield* sql`DELETE FROM conversations WHERE id = ${id}`.pipe(Effect.orDie)
      })

      const messages = (conversationId: string, after?: number) =>
        sql<MessageRow>`
          SELECT * FROM messages
          WHERE conversation_id = ${conversationId} AND seq > ${after ?? 0}
          ORDER BY seq`.pipe(
          Effect.map((rows) => rows.map(messageFromRow)),
          Effect.orDie
        )

      const getMessage = (id: string) =>
        sql<MessageRow>`SELECT * FROM messages WHERE id = ${id}`.pipe(
          Effect.map((rows) => (rows[0] === undefined ? undefined : messageFromRow(rows[0]))),
          Effect.orDie
        )

      const insertMessage = Effect.fn("ConversationRepo.insertMessage")(function*(input: NewMessage) {
        const id = newId()
        const now = yield* nowIso
        const status = input.status ?? "done"
        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO messages ${
            sql.insert({
              id,
              conversation_id: input.conversationId,
              role: input.role,
              bot_id: input.botId ?? null,
              sender_name: input.senderName ?? "",
              parts: JSON.stringify(input.parts ?? []),
              reply_quote: input.replyQuote ?? null,
              hidden: input.hidden === true ? 1 : 0,
              status,
              provider_id: input.providerId ?? null,
              model: input.model ?? null,
              created_at: now,
              finished_at: input.role === "assistant" && isFinished(status) ? now : null
            })
          }`
          yield* sql`UPDATE conversations SET updated_at = ${now} WHERE id = ${input.conversationId}`
        })).pipe(Effect.orDie)
        const message = yield* getMessage(id)
        return message!
      })

      const updateMessage = Effect.fn("ConversationRepo.updateMessage")(function*(id: string, patch: MessagePatch) {
        const changes: Record<string, string | number | null> = {}
        if (patch.parts !== undefined) changes.parts = JSON.stringify(patch.parts)
        if (patch.status !== undefined) changes.status = patch.status
        if (patch.error !== undefined) changes.error = patch.error
        if (patch.promptTokens !== undefined) changes.prompt_tokens = patch.promptTokens
        if (patch.completionTokens !== undefined) changes.completion_tokens = patch.completionTokens
        if (Object.keys(changes).length > 0) {
          const now = yield* nowIso
          yield* sql.withTransaction(Effect.gen(function*() {
            yield* sql`UPDATE messages SET ${sql.update(changes)} WHERE id = ${id}`
            if (patch.status !== undefined && isFinished(patch.status)) {
              yield* sql`
                UPDATE messages SET finished_at = ${now}
                WHERE id = ${id} AND role = 'assistant' AND finished_at IS NULL`
            }
          })).pipe(Effect.orDie)
        }
        return yield* getMessage(id)
      })

      const deleteMessages = (ids: ReadonlyArray<string>) =>
        ids.length === 0
          ? Effect.void
          : sql`DELETE FROM messages WHERE ${sql.in("id", ids)}`.pipe(Effect.asVoid, Effect.orDie)

      const markInterrupted = Effect.flatMap(nowIso, (now) =>
        sql<{ id: string }>`
          UPDATE messages SET status = 'error', error = 'The server restarted before this reply finished.',
            finished_at = CASE WHEN role = 'assistant' THEN COALESCE(finished_at, ${now}) END
          WHERE status = 'streaming' RETURNING id`).pipe(
          Effect.map((rows) => rows.length),
          Effect.orDie
        )

      return ConversationRepo.of({
        list,
        get,
        create,
        update,
        remove,
        messages,
        getMessage,
        insertMessage,
        updateMessage,
        deleteMessages,
        markInterrupted
      })
    })
  )
}
