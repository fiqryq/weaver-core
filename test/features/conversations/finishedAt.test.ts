import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { AgentRunner } from "../../../src/features/runs/AgentRunner.ts"
import { DatabaseTest } from "../../../src/platform/db/Database.ts"
import init from "../../../src/platform/db/migrations/0001_init.ts"
import messageSearch from "../../../src/platform/db/migrations/0002_message_search.ts"
import { migrations } from "../../../src/platform/db/migrations/index.ts"
import {
  callTool,
  collectUntil,
  createBot,
  createConversation,
  say,
  scriptedModel,
  send,
  sendAndWait,
  testLayer,
  withProviderKey
} from "../../support/layers.ts"

const RepoLayer = ConversationRepo.layer.pipe(Layer.provideMerge(DatabaseTest))

const newConversation = Effect.flatMap(ConversationRepo, (conversations) => conversations.create({ title: "", botIds: [] }))

describe("Message.finishedAt", () => {
  it.effect("is set once a reply reaches done, error or cancelled, and only for replies", () =>
    Effect.gen(function*() {
      const conversations = yield* ConversationRepo
      const conversation = yield* newConversation
      const user = yield* conversations.insertMessage({ conversationId: conversation.id, role: "user" })
      expect(user.finishedAt).toBeNull()

      for (const status of ["done", "error", "cancelled"] as const) {
        const reply = yield* conversations.insertMessage({ conversationId: conversation.id, role: "assistant", status: "streaming" })
        expect(reply.finishedAt).toBeNull()
        const streaming = yield* conversations.updateMessage(reply.id, { parts: [{ type: "text", text: "Draft" }] })
        expect(streaming!.finishedAt).toBeNull()
        const finished = yield* conversations.updateMessage(reply.id, { status })
        expect(finished!.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        expect(finished!.finishedAt! >= reply.createdAt).toBe(true)
      }

      const inserted = yield* conversations.insertMessage({ conversationId: conversation.id, role: "assistant" })
      expect(inserted.finishedAt).toBe(inserted.createdAt)
    }).pipe(Effect.provide(RepoLayer)))

  it.effect("doesn't move when a finished reply is saved again, like a review adding learned parts", () =>
    Effect.gen(function*() {
      const conversations = yield* ConversationRepo
      const conversation = yield* newConversation
      const reply = yield* conversations.insertMessage({ conversationId: conversation.id, role: "assistant", status: "streaming" })
      const done = yield* conversations.updateMessage(reply.id, { parts: [{ type: "text", text: "Hi" }], status: "done" })
      yield* TestClock.adjust("1 minute")

      const reviewed = yield* conversations.updateMessage(reply.id, {
        parts: [...done!.parts, { type: "learned", text: "Added to Core Memory" }]
      })
      expect(reviewed!.parts.at(-1)).toEqual({ type: "learned", text: "Added to Core Memory" })
      expect(reviewed!.finishedAt).toBe(done!.finishedAt)

      const savedAgain = yield* conversations.updateMessage(reply.id, { status: "done" })
      expect(savedAgain!.finishedAt).toBe(done!.finishedAt)
    }).pipe(Effect.provide(RepoLayer)))

  it.effect("is set on replies a restart interrupted", () =>
    Effect.gen(function*() {
      const conversations = yield* ConversationRepo
      const conversation = yield* newConversation
      const reply = yield* conversations.insertMessage({ conversationId: conversation.id, role: "assistant", status: "streaming" })
      expect(yield* conversations.markInterrupted).toBe(1)
      const interrupted = yield* conversations.getMessage(reply.id)
      expect(interrupted!.status).toBe("error")
      expect(interrupted!.finishedAt).not.toBeNull()
    }).pipe(Effect.provide(RepoLayer)))

  it.effect("is backfilled from the creation time of replies that finished before the migration", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({ "0001_init": init, "0002_message_search": messageSearch })
      })
      yield* sql`INSERT INTO conversations ${sql.insert({ id: "c1", title: "Old", created_at: "2026-01-01", updated_at: "2026-01-01" })}`
      const insert = (id: string, role: string, status: string) =>
        sql`INSERT INTO messages ${
          sql.insert({ id, conversation_id: "c1", role, status, created_at: `2026-01-01T00:00:0${id.slice(1)}.000Z` })
        }`
      yield* insert("m1", "user", "done")
      yield* insert("m2", "assistant", "done")
      yield* insert("m3", "assistant", "error")
      yield* insert("m4", "assistant", "cancelled")
      yield* insert("m5", "assistant", "streaming")

      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
      const rows = yield* sql<{ id: string; finished_at: string | null }>`SELECT id, finished_at FROM messages ORDER BY id`
      expect(rows.map((row) => [row.id, row.finished_at])).toEqual([
        ["m1", null],
        ["m2", "2026-01-01T00:00:02.000Z"],
        ["m3", "2026-01-01T00:00:03.000Z"],
        ["m4", "2026-01-01T00:00:04.000Z"],
        ["m5", null]
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))

  it.live("travels with message-done for finished, failed and cancelled replies", () => {
    const model = scriptedModel((call) =>
      call.prompt.includes("Run something") ? callTool("run_command", { command: "echo never" }) : say("Hello")
    )
    return Effect.gen(function*() {
      const bot = yield* createBot({ name: "Ada", tools: ["shell"], approvalMode: "ask" })
      const conversation = yield* createConversation([bot.id])

      const failed = yield* sendAndWait(conversation.id, "No key yet")
      const failedDone = failed.find((event) => event.type === "message-done")
      if (failedDone?.type !== "message-done") throw new Error("expected message-done")
      expect(failedDone.message.status).toBe("error")
      expect(failedDone.message.finishedAt).not.toBeNull()

      yield* withProviderKey
      const done = yield* sendAndWait(conversation.id, "Hi")
      const doneEvent = done.find((event) => event.type === "message-done")
      if (doneEvent?.type !== "message-done") throw new Error("expected message-done")
      expect(doneEvent.message.status).toBe("done")
      expect(doneEvent.message.finishedAt).not.toBeNull()
      const created = done.find((event) => event.type === "message-created")
      if (created?.type !== "message-created") throw new Error("expected message-created")
      expect(created.message.finishedAt).toBeNull()

      const finished = yield* collectUntil(conversation.id, (event) => event.type === "run-finished")
      const requested = yield* collectUntil(conversation.id, (event) => event.type === "approval-requested")
      yield* send(conversation.id, "Run something")
      yield* Fiber.join(requested)
      yield* (yield* AgentRunner).cancelConversation(conversation.id)
      const cancelled = (yield* Fiber.join(finished)).find((event) => event.type === "message-done")
      if (cancelled?.type !== "message-done") throw new Error("expected message-done")
      expect(cancelled.message.status).toBe("cancelled")
      expect(cancelled.message.finishedAt).not.toBeNull()
    }).pipe(Effect.provide(testLayer(model.layer)))
  })
})
