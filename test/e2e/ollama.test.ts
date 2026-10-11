import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Stream } from "effect"
import { AppConfig } from "../../src/config/Config.ts"
import { messageText } from "../../src/features/conversations/Conversation.ts"
import { ConversationRepo } from "../../src/features/conversations/ConversationRepo.ts"
import { SelfReview } from "../../src/features/learning/review/SelfReview.ts"
import { RunEvents } from "../../src/features/runs/RunEvents.ts"
import { createBot, createConversation, send } from "../support/layers.ts"
import { realModelLayer, useEndpoint } from "../support/realModel.ts"

/**
 * Real replies from a local Ollama model. Opt in with `WEAVER_E2E_OLLAMA=1`; `WEAVER_E2E_MODEL`
 * (default qwen2.5:3b) needs tool support, `WEAVER_E2E_TEXT_MODEL` (default llama3:latest) must not have it.
 */
const enabled = process.env.WEAVER_E2E_OLLAMA === "1"
const baseUrl = process.env.WEAVER_E2E_OLLAMA_URL ?? "http://127.0.0.1:11434/v1"
const model = process.env.WEAVER_E2E_MODEL ?? "qwen2.5:3b"
const textModel = process.env.WEAVER_E2E_TEXT_MODEL ?? "llama3:latest"
const timeout = 300_000
/** Small models now and then answer without the tools they were asked to use. */
const toolTest = { timeout, retry: 1 }

/** Like `sendAndWait`, with room for a cold model to load. */
const sendAndWait = (conversationId: string, text: string) =>
  Effect.gen(function*() {
    const fiber = yield* (yield* RunEvents).subscribe(conversationId).pipe(
      Stream.takeUntil((event) => event.type === "run-finished"),
      Stream.runCollect,
      Effect.timeout(Duration.millis(timeout)),
      Effect.forkChild
    )
    yield* Effect.sleep(Duration.millis(20))
    yield* send(conversationId, text)
    return yield* Fiber.join(fiber)
  })

const replyTo = (text: string, tools: ReadonlyArray<"files" | "skills">, modelName = model) =>
  Effect.gen(function*() {
    yield* useEndpoint(baseUrl, modelName, "")
    const bot = yield* createBot({
      name: "Ada",
      tools: [...tools],
      maxSteps: 6,
      systemPrompt: "You are a careful assistant. Use your tools to do what you're asked, then answer in one short sentence."
    })
    const conversation = yield* createConversation([bot.id])
    const events = yield* sendAndWait(conversation.id, text)
    const messages = yield* (yield* ConversationRepo).messages(conversation.id)
    return { bot, conversation, events, reply: messages.at(-1)! }
  })

describe.skipIf(!enabled)(`Ollama (${model})`, () => {
  it.live("replies after writing and reading a file with tools", () =>
    Effect.gen(function*() {
      const { bot, events, reply } = yield* replyTo(
        "Create a file named hello.txt containing exactly: hi from weaver. Then read hello.txt back and tell me what it says.",
        ["files"]
      )
      expect(events.some((event) => event.type === "error")).toBe(false)
      expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "done" })
      expect(reply).toMatchObject({ role: "assistant", status: "done", error: null, providerId: "custom", model })
      const calls = reply.parts.flatMap((part) => (part.type === "tool-call" ? [part] : []))
      const results = reply.parts.flatMap((part) => (part.type === "tool-result" ? [part] : []))
      expect(calls.length).toBeGreaterThan(0)
      expect(results.map((result) => result.id)).toEqual(calls.map((call) => call.id))
      expect(calls.map((call) => call.name)).toContain("write_file")
      expect(messageText(reply.parts).length).toBeGreaterThan(0)
      expect(reply.promptTokens).toBeGreaterThan(0)
      const workspace = join((yield* AppConfig).dataDir, "bots", bot.id, "workspace")
      expect(existsSync(join(workspace, "hello.txt"))).toBe(true)
    }).pipe(Effect.provide(realModelLayer())), toolTest)

  it.live("runs a self-review of a reply that used tools", () =>
    Effect.gen(function*() {
      const { bot, conversation, reply } = yield* replyTo(
        "List the files in your workspace, then create notes.md with a one-line todo list.",
        ["files", "skills"]
      )
      expect(reply.status).toBe("done")
      expect(reply.parts.some((part) => part.type === "tool-call")).toBe(true)

      const learned = yield* (yield* SelfReview).review({
        bot,
        conversationId: conversation.id,
        messageId: reply.id,
        kinds: new Set(["skills"])
      }).pipe(Effect.timeout(timeout))
      expect(Array.isArray(learned)).toBe(true)
      const reviewed = yield* (yield* ConversationRepo).getMessage(reply.id)
      expect(reviewed!.parts.filter((part) => part.type === "learned").map((part) => part.text)).toEqual(learned)
    }).pipe(Effect.provide(realModelLayer())), toolTest)

  it.live(`falls back to a plain reply on a model without tool support (${textModel})`, () =>
    Effect.gen(function*() {
      const { events, reply } = yield* replyTo("Say hello in five words or fewer.", ["files"], textModel)
      expect(events.some((event) => event.type === "error")).toBe(false)
      expect(reply).toMatchObject({ status: "done", error: null })
      expect(reply.parts.some((part) => part.type === "tool-call")).toBe(false)
      expect(messageText(reply.parts).length).toBeGreaterThan(0)
    }).pipe(Effect.provide(realModelLayer())), timeout)
})
