import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { BotRepo } from "../../../src/features/bots/BotRepo.ts"
import type { MessagePart } from "../../../src/features/conversations/Conversation.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { SelfReview } from "../../../src/features/learning/review/SelfReview.ts"
import { Toolbox } from "../../../src/features/runs/Toolbox.ts"
import { DatabaseTest } from "../../../src/platform/db/Database.ts"
import init from "../../../src/platform/db/migrations/0001_init.ts"
import { migrations } from "../../../src/platform/db/migrations/index.ts"
import { sanitizeQuery, sessionSearchTool } from "../../../src/tools/learning/SessionSearch.ts"
import { createBot, createConversation, say, scriptedModel, sendAndWait, testLayer, withProviderKey } from "../../support/layers.ts"

const TestLayer = Layer.mergeAll(BotRepo.layer, ConversationRepo.layer).pipe(Layer.provideMerge(DatabaseTest))

const text = (value: string): Array<MessagePart> => [{ type: "text", text: value }]

const indexed = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ text: string }>`SELECT text FROM message_search ORDER BY rowid`
  return rows.map((row) => row.text)
})

const matches = (query: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ rowid: number }>`SELECT rowid FROM message_search WHERE message_search MATCH ${query}`
    return rows.length
  })

/** Two bots, three conversations: Ada has "Deploys" and "Current", Bo has "Secrets". */
const world = Effect.gen(function*() {
  const bots = yield* BotRepo
  const conversations = yield* ConversationRepo
  const ada = yield* bots.create({ name: "Ada", tools: [] })
  const bo = yield* bots.create({ name: "Bo", tools: [] })
  const deploys = yield* conversations.create({ title: "Deploys", botIds: [ada.id] })
  const current = yield* conversations.create({ title: "Current", botIds: [ada.id] })
  const secrets = yield* conversations.create({ title: "Secrets", botIds: [bo.id] })
  const groceries = yield* conversations.create({ title: "Groceries", botIds: [ada.id, bo.id] })

  const say = (conversationId: string, role: "user" | "assistant", value: string) =>
    conversations.insertMessage({
      conversationId,
      role,
      ...(role === "assistant" ? { botId: ada.id, senderName: "Ada" } : {}),
      parts: text(value)
    })
  const filler = []
  for (let i = 0; i < 6; i++) filler.push(yield* say(deploys.id, i % 2 === 0 ? "user" : "assistant", `Filler message ${i}`))
  const hit = yield* say(deploys.id, "user", "We deploy the kubernetes cluster with helm on Fridays, and kubernetes upgrades on Mondays.")
  for (let i = 6; i < 12; i++) filler.push(yield* say(deploys.id, i % 2 === 0 ? "user" : "assistant", `Filler message ${i}`))
  yield* say(current.id, "user", "kubernetes again, in the current chat")
  yield* say(secrets.id, "user", "Bo's private kubernetes notes")
  const groceryHit = yield* say(groceries.id, "assistant", "Buy milk, eggs, bread, apples and coffee; the kubernetes meetup next week has snacks for everyone.")

  const sql = yield* SqlClient.SqlClient
  const tool = (currentConversationId = current.id, botId = ada.id) =>
    sessionSearchTool({ sql, botId, currentConversationId })
  return { ada, bo, deploys, current, secrets, groceries, hit, groceryHit, filler, tool }
})

describe("message_search index", () => {
  it.effect("backfills existing messages when the migration runs", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_init": init }) })
      yield* sql`INSERT INTO conversations ${sql.insert({ id: "c1", title: "Old", created_at: "2026-01-01", updated_at: "2026-01-01" })}`
      const insert = (id: string, status: string, parts: unknown) =>
        sql`INSERT INTO messages ${
          sql.insert({ id, conversation_id: "c1", role: "user", parts: JSON.stringify(parts), status, created_at: "2026-01-01" })
        }`
      yield* insert("m1", "done", [{ type: "text", text: "Old deployment notes" }, { type: "tool-call", id: "x", name: "y", title: "", params: {} }, { type: "text", text: "second part" }])
      yield* insert("m2", "streaming", [{ type: "text", text: "never finished" }])
      yield* insert("m3", "done", [{ type: "tool-result", id: "x", name: "y", output: "tool output only", isFailure: false }])
      const insertRaw = (id: string, parts: string) =>
        sql`INSERT INTO messages ${
          sql.insert({ id, conversation_id: "c1", role: "user", parts, status: "done", created_at: "2026-01-01" })
        }`
      yield* insertRaw("m4", "not json")
      yield* insertRaw("m5", JSON.stringify(["plain string", 7, null]))
      yield* insertRaw("m6", JSON.stringify({ type: "text", text: "an object" }))

      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
      expect(yield* indexed).toEqual(["Old deployment notes\n\nsecond part"])
      expect(yield* matches("note")).toBe(1)

      yield* sql`UPDATE messages SET parts = ${"{broken"} WHERE id = 'm1'`
      yield* insertRaw("m7", "[{]")
      yield* sql`UPDATE messages SET parts = ${JSON.stringify([{ type: "text", text: "fixed later" }])} WHERE id = 'm4'`
      expect(yield* indexed).toEqual(["fixed later"])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))

  it.effect("follows inserts, finished replies, edits and deletes", () =>
    Effect.gen(function*() {
      const bots = yield* BotRepo
      const conversations = yield* ConversationRepo
      const bot = yield* bots.create({ name: "Ada", tools: [] })
      const conversation = yield* conversations.create({ title: "", botIds: [bot.id] })

      const user = yield* conversations.insertMessage({ conversationId: conversation.id, role: "user", parts: text("Plan the migration") })
      expect(yield* indexed).toEqual(["Plan the migration"])

      const reply = yield* conversations.insertMessage({ conversationId: conversation.id, role: "assistant", status: "streaming" })
      yield* conversations.updateMessage(reply.id, { parts: text("Draft so far") })
      expect(yield* matches("draft")).toBe(0)

      yield* conversations.updateMessage(reply.id, { parts: text("Final answer about databases"), status: "done" })
      expect(yield* matches("databases")).toBe(1)

      yield* conversations.updateMessage(reply.id, { parts: [...text("Rewritten about queues"), { type: "learned", text: "Created skill \"x\"" }] })
      expect(yield* matches("databases")).toBe(0)
      expect(yield* matches("queues")).toBe(1)
      expect(yield* matches("skill")).toBe(0)

      yield* conversations.deleteMessages([user.id])
      expect(yield* matches("migration")).toBe(0)

      yield* conversations.remove(conversation.id)
      expect(yield* indexed).toEqual([])

      const other = yield* conversations.create({ title: "", botIds: [bot.id] })
      yield* conversations.insertMessage({ conversationId: other.id, role: "user", parts: text("Removed with the bot") })
      expect(yield* matches("removed")).toBe(1)
      yield* bots.remove(bot.id)
      expect(yield* indexed).toEqual([])
    }).pipe(Effect.provide(TestLayer)))
})

describe("session_search", () => {
  it.effect("searches only the bot's other conversations, with a window around the top match", () =>
    Effect.gen(function*() {
      const w = yield* world
      const output = yield* w.tool().run({ query: "kubernetes" })
      expect(output).toContain("Found 2 conversations")
      expect(output).toContain("\"Deploys\"")
      expect(output).toContain("\"Groceries\"")
      expect(output).not.toContain("Secrets")
      expect(output).not.toContain("current chat")
      expect(output).toContain(`→ [message ${w.hit.id}]`)
      expect(output).toContain(`[message ${w.groceryHit.id}]`)
      // Top hit: three messages on each side, and how many more there are.
      expect(output).toContain("Filler message 3")
      expect(output).toContain("Filler message 8")
      expect(output).not.toContain("Filler message 2")
      expect(output).not.toContain("Filler message 9")
      expect(output).toContain("(3 earlier messages)")
      expect(output).toContain("(3 later messages)")

      const limited = yield* w.tool().run({ query: "kubernetes", limit: 1 })
      expect(limited).toContain("Found 1 conversation ")

      const fromBo = yield* w.tool(w.groceries.id, w.bo.id).run({ query: "kubernetes" })
      expect(fromBo).toContain("Secrets")
      expect(fromBo).not.toContain("Deploys")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("reads and scrolls a conversation, and lists recent ones", () =>
    Effect.gen(function*() {
      const w = yield* world
      const read = yield* w.tool().run({ conversation_id: w.deploys.id })
      expect(read).toContain("\"Deploys\"")
      expect(read).toContain("13 messages")
      expect(read).toContain("Filler message 0")
      expect(read).toContain("Filler message 11")

      const scrolled = yield* w.tool().run({ conversation_id: w.deploys.id, around_message_id: w.hit.id, window: 1 })
      expect(scrolled).toContain("Filler message 5")
      expect(scrolled).toContain("Filler message 6")
      expect(scrolled).not.toContain("Filler message 4")
      expect(scrolled).toContain("(5 earlier messages)")

      const first = yield* w.tool().run({ conversation_id: w.deploys.id, around_message_id: w.filler[0]!.id, window: 2 })
      expect(first).toContain("(start of the conversation)")

      const recent = yield* w.tool().run({})
      expect(recent).toContain("\"Deploys\"")
      expect(recent).toContain("\"Groceries\"")
      expect(recent).not.toContain("\"Current\"")
      expect(recent).not.toContain("\"Secrets\"")

      const current = yield* Effect.flip(w.tool().run({ conversation_id: w.current.id }))
      expect(current.message).toContain("already in your context")
      const foreign = yield* Effect.flip(w.tool().run({ conversation_id: w.secrets.id }))
      expect(foreign.message).toContain("no earlier conversation")
      const wrongMessage = yield* Effect.flip(w.tool().run({ conversation_id: w.deploys.id, around_message_id: w.groceryHit.id }))
      expect(wrongMessage.message).toContain("isn't in conversation")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("handles FTS5 syntax: operators, phrases, prefixes and bad input", () =>
    Effect.gen(function*() {
      const w = yield* world
      expect(yield* w.tool().run({ query: "helm OR milk" })).toContain("Found 2 conversations")
      expect(yield* w.tool().run({ query: "\"kubernetes cluster\"" })).toContain("Found 1 conversation ")
      expect(yield* w.tool().run({ query: "kubernetes NOT milk" })).toContain("Found 1 conversation ")
      expect(yield* w.tool().run({ query: "kube*" })).toContain("Found 2 conversations")
      expect(yield* w.tool().run({ query: "deploy" })).toContain("Deploys")

      const none = yield* w.tool().run({ query: "zebra" })
      expect(none).toContain("No matching conversations")
      expect(none).toContain("OR")

      expect(yield* w.tool().run({ query: "kubernetes ((cluster: \"helm" })).toContain("Deploys")
      const broken = yield* Effect.flip(w.tool().run({ query: "helm AND AND milk" }))
      expect(broken.message).toContain("Couldn't parse the search query")
      const empty = yield* Effect.flip(w.tool().run({ query: "(( ))" }))
      expect(empty.message).toContain("no searchable words")
    }).pipe(Effect.provide(TestLayer)))

  it("sanitizes queries for FTS5", () => {
    expect(sanitizeQuery("chat-send v2.1 \"exact phrase\" (x)")).toBe("\"chat-send\" \"v2.1\" \"exact phrase\"  x")
    expect(sanitizeQuery("TODO: fix it")).toBe("TODO  fix it")
    expect(sanitizeQuery("OR deploy AND")).toBe("deploy")
    expect(sanitizeQuery("**deploy** *x")).toBe("deploy* x")
    expect(sanitizeQuery("unbalanced \"quote")).toBe("unbalanced  quote")
    expect(sanitizeQuery("\"cost $&\" foo")).toBe("\"cost $&\" foo")
    expect(sanitizeQuery("\"a $1 $$\" \"b $`\"")).toBe("\"a $1 $$\" \"b $`\"")
  })
})

describe("session search wiring", () => {
  it.live("gives learning bots session_search for other chats and tells them about it", () => {
    const model = scriptedModel(() => say("ok"))
    return Effect.gen(function*() {
      yield* withProviderKey
      const toolbox = yield* Toolbox
      const learner = yield* createBot({ name: "Ada", tools: ["skills"] })
      const plain = yield* createBot({ name: "Bo", tools: [] })
      const conversation = yield* createConversation([learner.id])

      const names = (tools: ReadonlyArray<{ name: string }>) => tools.map((tool) => tool.name)
      expect(names((yield* toolbox.forBot(learner, { conversationId: conversation.id })).tools)).toContain("session_search")
      expect(names((yield* toolbox.forBot(learner)).tools)).not.toContain("session_search")
      expect(names((yield* toolbox.forBot(plain, { conversationId: conversation.id })).tools)).not.toContain("session_search")

      yield* sendAndWait(conversation.id, "Hi")
      expect(model.calls[0]!.prompt).toContain("use session_search to recall it")
      expect(Option.isSome(yield* Effect.serviceOption(SelfReview))).toBe(true)
    }).pipe(Effect.provide(testLayer(model.layer)))
  })
})
