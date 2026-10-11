import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { messageText } from "../../../src/features/conversations/Conversation.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { AgentRunner } from "../../../src/features/runs/AgentRunner.ts"
import { Approvals } from "../../../src/features/runs/Approvals.ts"
import { RunEvents } from "../../../src/features/runs/RunEvents.ts"
import {
  callTool,
  collectUntil,
  createBot,
  createConversation,
  say,
  scriptedModel,
  send,
  sendAndWait,
  tempDir,
  testLayer,
  withProviderKey
} from "../../support/layers.ts"

const lastMessage = (conversationId: string) =>
  Effect.gen(function*() {
    const conversations = yield* ConversationRepo
    const messages = yield* conversations.messages(conversationId)
    return messages.at(-1)!
  })

describe("AgentRunner", () => {
  it.live("runs a tool, feeds the result back and finishes with text", () => {
    const dataDir = tempDir()
    const model = scriptedModel((call) =>
      call.index === 0 ? callTool("write_file", { path: "notes.txt", content: "hello" }) : say("Saved it.")
    )
    return Effect.gen(function*() {
      yield* withProviderKey
      const bot = yield* createBot({ name: "Ada", tools: ["files"] })
      const conversation = yield* createConversation([bot.id])
      const events = yield* sendAndWait(conversation.id, "Write hello to notes.txt")

      expect(model.calls).toHaveLength(2)
      expect(model.calls[0]!.tools).toContain("write_file")
      expect(model.calls[1]!.prompt).toContain("Wrote 5 characters")

      const message = yield* lastMessage(conversation.id)
      expect(message.status).toBe("done")
      expect(message.parts.map((part) => part.type)).toEqual(["tool-call", "tool-result", "text"])
      expect(messageText(message.parts)).toBe("Saved it.")
      expect(message.promptTokens).toBe(20)

      const written = yield* Effect.promise(() => readFile(join(dataDir, "bots", bot.id, "workspace", "notes.txt"), "utf8"))
      expect(written).toBe("hello")

      const types = events.map((event) => event.type)
      expect(types[0]).toBe("run-started")
      expect(types).toContain("tool-call")
      expect(types).toContain("tool-result")
      expect(types).toContain("text-delta")
      expect(types.at(-1)).toBe("run-finished")
    }).pipe(Effect.provide(testLayer(model.layer, dataDir)))
  })

  it.live("stops offering tools after the step limit", () => {
    const model = scriptedModel((call) => call.tools.length > 0 ? callTool("list_files", {}, `c${call.index}`) : say("Done looking."))
    return Effect.gen(function*() {
      yield* withProviderKey
      const bot = yield* createBot({ name: "Ada", tools: ["files"], maxSteps: 2 })
      const conversation = yield* createConversation([bot.id])
      yield* sendAndWait(conversation.id, "Look around")

      expect(model.calls.map((call) => call.tools.length > 0)).toEqual([true, true, false])
      const message = yield* lastMessage(conversation.id)
      expect(message.parts.filter((part) => part.type === "tool-result")).toHaveLength(2)
      expect(messageText(message.parts)).toBe("Done looking.")
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("lets every bot in a group reply in order, each seeing the earlier replies", () => {
    const model = scriptedModel((call) => say(call.index === 0 ? "I'm Ada." : "And I'm Bo."))
    return Effect.gen(function*() {
      yield* withProviderKey
      const ada = yield* createBot({ name: "Ada" })
      const bo = yield* createBot({ name: "Bo" })
      const conversation = yield* createConversation([ada.id, bo.id])
      yield* sendAndWait(conversation.id, "Introduce yourselves")

      const conversations = yield* ConversationRepo
      const messages = yield* conversations.messages(conversation.id)
      expect(messages.map((message) => message.senderName)).toEqual(["", "Ada", "Bo"])
      expect(model.calls[1]!.prompt).toContain("[Ada]: I'm Ada.")
      expect(model.calls[1]!.prompt).toContain("group chat with other bots: Ada")
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("pauses for approval and runs the command once approved", () => {
    const model = scriptedModel((call) => call.index === 0 ? callTool("run_command", { command: "echo approved-run" }) : say("Ran it."))
    return Effect.gen(function*() {
      yield* withProviderKey
      const bot = yield* createBot({ name: "Ada", tools: ["shell"], approvalMode: "ask" })
      const conversation = yield* createConversation([bot.id])
      const finished = yield* collectUntil(conversation.id, (event) => event.type === "run-finished")
      const requested = yield* collectUntil(conversation.id, (event) => event.type === "approval-requested")
      yield* send(conversation.id, "Run echo")

      const request = (yield* Fiber.join(requested)).at(-1)!
      if (request.type !== "approval-requested") throw new Error("expected an approval request")
      const waiting = yield* lastMessage(conversation.id)
      expect(waiting.parts.at(-1)).toMatchObject({ type: "tool-call", approval: "pending" })

      const approvals = yield* Approvals
      expect(yield* approvals.resolve(request.approvalId, true)).toBe(true)
      yield* Fiber.join(finished)

      const message = yield* lastMessage(conversation.id)
      expect(message.parts[0]).toMatchObject({ type: "tool-call", approval: "approved" })
      expect(message.parts[1]).toMatchObject({ type: "tool-result", isFailure: false })
      expect((message.parts[1] as { output: string }).output).toContain("approved-run")
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("tells the model when the user denies an action", () => {
    const model = scriptedModel((call) => call.index === 0 ? callTool("run_command", { command: "rm -rf /" }) : say("Okay, I won't."))
    return Effect.gen(function*() {
      yield* withProviderKey
      const bot = yield* createBot({ name: "Ada", tools: ["shell"], approvalMode: "ask" })
      const conversation = yield* createConversation([bot.id])
      const finished = yield* collectUntil(conversation.id, (event) => event.type === "run-finished")
      const requested = yield* collectUntil(conversation.id, (event) => event.type === "approval-requested")
      yield* send(conversation.id, "Clean up")

      const request = (yield* Fiber.join(requested)).at(-1)!
      if (request.type !== "approval-requested") throw new Error("expected an approval request")
      yield* (yield* Approvals).resolve(request.approvalId, false)
      yield* Fiber.join(finished)

      expect(model.calls[1]!.prompt).toContain("The user denied this action")
      const message = yield* lastMessage(conversation.id)
      expect(message.parts[0]).toMatchObject({ approval: "denied" })
      expect(message.parts[1]).toMatchObject({ isFailure: true })
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("cancelling while waiting for approval marks the reply cancelled", () => {
    const model = scriptedModel(() => callTool("run_command", { command: "echo never" }))
    return Effect.gen(function*() {
      yield* withProviderKey
      const bot = yield* createBot({ name: "Ada", tools: ["shell"], approvalMode: "ask" })
      const conversation = yield* createConversation([bot.id])
      const finished = yield* collectUntil(conversation.id, (event) => event.type === "run-finished")
      const requested = yield* collectUntil(conversation.id, (event) => event.type === "approval-requested")
      yield* send(conversation.id, "Run something")
      yield* Fiber.join(requested)

      const runner = yield* AgentRunner
      yield* runner.cancelConversation(conversation.id)
      const events = yield* Fiber.join(finished)
      expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "cancelled" })
      expect(yield* runner.isRunning(conversation.id)).toBe(false)

      const message = yield* lastMessage(conversation.id)
      expect(message.status).toBe("cancelled")
      expect(message.parts[0]).toMatchObject({ approval: "denied" })
      expect(yield* (yield* Approvals).pending).toHaveLength(0)
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("a new message finishes cancelling the current run before the next one starts", () => {
    const model = scriptedModel((call) => call.index === 0 ? callTool("run_command", { command: "echo never" }) : say("Second reply."))
    return Effect.gen(function*() {
      yield* withProviderKey
      const bot = yield* createBot({ name: "Ada", tools: ["shell"], approvalMode: "ask" })
      const conversation = yield* createConversation([bot.id])
      const collected = yield* collectUntil(
        conversation.id,
        (event) => event.type === "run-finished" && event.status === "done"
      )
      const requested = yield* collectUntil(conversation.id, (event) => event.type === "approval-requested")
      const firstRun = yield* send(conversation.id, "Run something")
      yield* Fiber.join(requested)
      const secondRun = yield* send(conversation.id, "Never mind, just answer")
      const events = yield* Fiber.join(collected)

      const index = (predicate: (event: (typeof events)[number]) => boolean) => events.findIndex(predicate)
      const firstFinished = index((event) => event.type === "run-finished" && event.runId === firstRun)
      const cancelledMessage = index((event) => event.type === "message-done" && event.message.status === "cancelled")
      const secondStarted = index((event) => event.type === "run-started" && event.runId === secondRun)
      expect(events[firstFinished]).toMatchObject({ status: "cancelled" })
      expect(cancelledMessage).toBeGreaterThan(-1)
      expect(cancelledMessage).toBeLessThan(secondStarted)
      expect(firstFinished).toBeLessThan(secondStarted)
      expect(events.slice(secondStarted).some((event) => "runId" in event && event.runId === firstRun)).toBe(false)
      expect(events.at(-1)).toMatchObject({ type: "run-finished", runId: secondRun, status: "done" })

      const conversations = yield* ConversationRepo
      const messages = yield* conversations.messages(conversation.id)
      expect(messages.map((message) => [message.role, message.status])).toEqual([
        ["user", "done"],
        ["assistant", "cancelled"],
        ["user", "done"],
        ["assistant", "done"]
      ])
      expect(messageText(messages.at(-1)!.parts)).toBe("Second reply.")
      expect(yield* (yield* Approvals).pending).toHaveLength(0)
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("reports a missing API key as a failed reply", () => {
    const model = scriptedModel(() => say("unreachable"))
    return Effect.gen(function*() {
      const bot = yield* createBot({ name: "Ada" })
      const conversation = yield* createConversation([bot.id])
      const events = yield* sendAndWait(conversation.id, "Hi")

      expect(model.calls).toHaveLength(0)
      expect(events.some((event) => event.type === "error")).toBe(true)
      const message = yield* lastMessage(conversation.id)
      expect(message.status).toBe("error")
      expect(message.error).toContain("API key")
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("streams text deltas to subscribers of every conversation", () => {
    const model = scriptedModel(() => say("Hello there"))
    return Effect.gen(function*() {
      yield* withProviderKey
      const bot = yield* createBot({ name: "Ada" })
      const conversation = yield* createConversation([bot.id])
      const events = yield* RunEvents
      const deltas = yield* events.subscribe().pipe(
        Stream.filter((event) => event.type === "text-delta"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.sleep("20 millis")
      yield* send(conversation.id, "Hi")
      expect(yield* Fiber.join(deltas)).toMatchObject([{ type: "text-delta", delta: "Hello there" }])
    }).pipe(Effect.provide(testLayer(model.layer)))
  })
})
