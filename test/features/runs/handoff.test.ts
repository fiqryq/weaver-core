import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AppConfig } from "../../../src/config/Config.ts"
import { BotRepo } from "../../../src/features/bots/BotRepo.ts"
import { type Message, messageText, type ToolResultPart } from "../../../src/features/conversations/Conversation.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { IntegrationRepo } from "../../../src/features/integrations/IntegrationRepo.ts"
import { McpError } from "../../../src/features/integrations/McpHub.ts"
import { CoreMemory } from "../../../src/features/learning/memory/CoreMemory.ts"
import { KnowledgeBase } from "../../../src/features/memory/KnowledgeBase.ts"
import { SelfReview } from "../../../src/features/learning/review/SelfReview.ts"
import { LibraryStore } from "../../../src/features/learning/library/LibraryStore.ts"
import { SkillStore } from "../../../src/features/learning/skills/SkillStore.ts"
import { Settings } from "../../../src/features/profile/Settings.ts"
import { LanguageModelFactory, ProviderRegistry } from "../../../src/features/providers/ProviderRegistry.ts"
import { AgentRunner } from "../../../src/features/runs/AgentRunner.ts"
import { AgentRunnerLive } from "../../../src/features/runs/AgentRunnerLive.ts"
import { Approvals } from "../../../src/features/runs/Approvals.ts"
import type { RunEvent } from "../../../src/features/runs/Events.ts"
import { RunEvents } from "../../../src/features/runs/RunEvents.ts"
import { Toolbox } from "../../../src/features/runs/Toolbox.ts"
import { DatabaseTest } from "../../../src/platform/db/Database.ts"
import { BotUsers } from "../../../src/platform/os/BotUsers.ts"
import { Camofox } from "../../../src/tools/builtin/Camofox.ts"
import { type FakeMemory, fakeMemory } from "../../support/fakeMemory.ts"
import {
  callTool,
  createBot,
  createConversation,
  type ModelCall,
  say,
  scriptedModel,
  send,
  tempDir,
  testLayer,
  withProviderKey
} from "../../support/layers.ts"

const nameOf = (call: ModelCall) => /Your name is ([^.]+)\./.exec(call.prompt)?.[1]
const afterTool = (call: ModelCall) => call.prompt.includes("\"role\":\"tool\"")
const systemOf = (call: ModelCall) => (JSON.parse(call.prompt) as Array<{ content: unknown }>)[0]!.content as string
const userTurns = (call: ModelCall) =>
  (JSON.parse(call.prompt) as Array<{ role: string; content: unknown }>)
    .filter((turn) => turn.role === "user")
    .map((turn) =>
      Array.isArray(turn.content)
        ? turn.content.map((part: { text?: string }) => part.text ?? "").join("")
        : String(turn.content)
    )
const callsBy = (calls: ReadonlyArray<ModelCall>, name: string) => calls.filter((call) => nameOf(call) === name)

const askBo = { bot: "bo", request: "Write a tagline", context: "For a coffee shop" }
const asked = "[Ada]: Write a tagline\n\nContext from Ada:\nFor a coffee shop"

/** Ada asks Bo with ask_bot and then thanks him; Bo answers with `bo`. */
const teamModel = (bo: (call: ModelCall) => ReturnType<typeof say> = () => say("Fresh beans, warm hearts.")) =>
  scriptedModel((call) =>
    nameOf(call) === "Bo"
      ? bo(call)
      : afterTool(call)
      ? say("Bo came up with a tagline.")
      : callTool("ask_bot", askBo, `ask-${call.index}`)
  )

/** Bo runs a command (which needs approval in ask mode), then answers. */
const commandFirst = (call: ModelCall) =>
  afterTool(call) ? say("Ran it.") : callTool("run_command", { command: "echo from-bo" }, `bo-${call.index}`)

const team = (bo: { tools?: Array<"shell">; approvalMode?: "ask" | "auto" } = {}) =>
  Effect.gen(function*() {
    yield* withProviderKey
    const botRepo = yield* BotRepo
    const ada = yield* createBot({ name: "Ada" })
    const boBot = yield* createBot({
      name: "Bo",
      label: "Copywriter",
      systemPrompt: "You write punchy marketing copy.\nKeep it short.",
      teammateIds: [ada.id],
      ...bo
    })
    const adaWithTeam = yield* botRepo.update(ada.id, { teammateIds: [boBot.id] })
    const chat = yield* createConversation([ada.id])
    return { ada: adaWithTeam, bo: boBot, chat }
  })

/** Collects every conversation's events until the predicate matches; start it before triggering the run. */
const collectAll = (until: (event: RunEvent) => boolean) =>
  Effect.gen(function*() {
    const events = yield* RunEvents
    const fiber = yield* events.subscribe().pipe(
      Stream.takeUntil(until),
      Stream.runCollect,
      Effect.timeout(Duration.seconds(10)),
      Effect.forkChild({ startImmediately: true })
    )
    yield* Effect.sleep(Duration.millis(20))
    return fiber
  })

const finished = (conversationId: string) => (event: RunEvent) =>
  event.type === "run-finished" && event.conversationId === conversationId

const sendAndWaitAll = (conversationId: string, text: string) =>
  Effect.gen(function*() {
    const fiber = yield* collectAll(finished(conversationId))
    yield* send(conversationId, text)
    return yield* Fiber.join(fiber)
  })

const messagesOf = (conversationId: string) =>
  Effect.gen(function*() {
    return yield* (yield* ConversationRepo).messages(conversationId)
  })

const handoffs = Effect.gen(function*() {
  return (yield* (yield* ConversationRepo).list).filter((conversation) => conversation.kind === "handoff")
})

const resultOf = (message: Message) => message.parts.find((part) => part.type === "tool-result") as ToolResultPart

describe("ask_bot", () => {
  it.live("hands a request to a teammate and returns the answer to the asking bot", () => {
    const model = teamModel()
    return Effect.gen(function*() {
      const { ada, bo, chat } = yield* team()
      const events = yield* sendAndWaitAll(chat.id, "We need a tagline")

      const [handoff] = yield* handoffs
      expect(handoff).toMatchObject({ kind: "handoff", requesterBotId: ada.id, botIds: [ada.id, bo.id], title: "Ada → Bo" })
      const handoffMessages = yield* messagesOf(handoff!.id)
      expect(handoffMessages.map((m) => [m.role, m.botId, m.senderName, m.status, messageText(m.parts)])).toEqual([
        ["user", ada.id, "Ada", "done", "Write a tagline\n\nContext from Ada:\nFor a coffee shop"],
        ["assistant", bo.id, "Bo", "done", "Fresh beans, warm hearts."]
      ])

      const reply = (yield* messagesOf(chat.id)).at(-1)!
      expect(reply.status).toBe("done")
      expect(reply.parts[0]).toMatchObject({ type: "tool-call", name: "ask_bot", title: "Asked Bo: Write a tagline" })
      expect(resultOf(reply)).toEqual({
        type: "tool-result",
        id: "ask-0",
        name: "ask_bot",
        output: "Bo replied:\n\nFresh beans, warm hearts.",
        isFailure: false,
        handoffConversationId: handoff!.id
      })
      expect(messageText(reply.parts)).toBe("Bo came up with a tagline.")

      const [adaFirst, adaSecond] = callsBy(model.calls, "Ada")
      expect(adaFirst!.tools).toContain("ask_bot")
      expect(systemOf(adaFirst!)).toContain(
        "## Your teammates\n- Bo (Copywriter): You write punchy marketing copy. Keep it short.\n\n" +
          "When part of a request fits a teammate's strengths, ask them with ask_bot instead of guessing."
      )
      expect(adaSecond!.prompt).toContain("Bo replied:")

      const [boCall] = callsBy(model.calls, "Bo")
      expect(boCall!.tools).not.toContain("ask_bot")
      expect(systemOf(boCall!)).toContain("You're helping your teammate Ada, another bot, not the person.")
      expect(systemOf(boCall!)).not.toContain("group chat")
      expect(systemOf(boCall!)).not.toContain("Your teammates")
      expect(userTurns(boCall!)).toEqual([asked])

      const onHandoff = events.filter((event) => "conversationId" in event && event.conversationId === handoff!.id)
      expect(onHandoff[0]).toMatchObject({ type: "message-created", message: { role: "user", botId: ada.id } })
      expect(onHandoff[1]).toMatchObject({ type: "run-started" })
      expect(onHandoff.some((event) => event.type === "text-delta")).toBe(true)
      expect(onHandoff.at(-1)).toMatchObject({ type: "run-finished", status: "done" })
      const activity = events.flatMap((event) =>
        event.type === "activity" && event.conversationId === chat.id ? [event.text] : []
      )
      expect(activity).toContain("Asking a teammate")
      expect(activity).toContain("Waiting for Bo")
      expect(yield* (yield* AgentRunner).isRunning(handoff!.id)).toBe(false)
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("reuses the pair's conversation, so the teammate sees the earlier requests and answers", () => {
    let answers = 0
    const model = teamModel(() => say(`Answer ${++answers}`))
    return Effect.gen(function*() {
      const { chat } = yield* team()
      yield* sendAndWaitAll(chat.id, "First")
      yield* sendAndWaitAll(chat.id, "Second")

      const all = yield* handoffs
      expect(all).toHaveLength(1)
      const replies = (yield* messagesOf(chat.id)).filter((m) => m.role === "assistant")
      expect(replies.map((m) => resultOf(m).handoffConversationId)).toEqual([all[0]!.id, all[0]!.id])
      expect(resultOf(replies[1]!).output).toBe("Bo replied:\n\nAnswer 2")
      expect((yield* messagesOf(all[0]!.id)).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])

      const second = callsBy(model.calls, "Bo")[1]!
      const turns = JSON.parse(second.prompt) as Array<{ role: string }>
      expect(turns.map((turn) => turn.role)).toEqual(["system", "user", "assistant", "user"])
      expect(second.prompt).toContain("Answer 1")
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("isn't offered without teammates, and lists the teammates when the name is wrong", () => {
    const model = scriptedModel((call) =>
      afterTool(call) ? say("Okay.") : callTool("ask_bot", { bot: "Zed", request: "Help" }, `ask-${call.index}`)
    )
    return Effect.gen(function*() {
      yield* withProviderKey
      const loner = yield* createBot({ name: "Cy" })
      const lonely = yield* createConversation([loner.id])
      yield* sendAndWaitAll(lonely.id, "Hi")
      expect(model.calls[0]!.tools).not.toContain("ask_bot")
      expect(systemOf(model.calls[0]!)).not.toContain("Your teammates")

      const { chat } = yield* team()
      yield* sendAndWaitAll(chat.id, "Ask Zed")
      const result = resultOf((yield* messagesOf(chat.id)).at(-1)!)
      expect(result).toMatchObject({ isFailure: true, output: "Zed isn't one of your teammates. You can ask: Bo." })
      expect(result.handoffConversationId).toBeUndefined()
      expect(yield* handoffs).toHaveLength(0)
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("cancelling the asking run cancels the teammate's reply", () => {
    const model = teamModel(commandFirst)
    return Effect.gen(function*() {
      const { chat } = yield* team({ tools: ["shell"], approvalMode: "ask" })
      const requested = yield* collectAll((event) => event.type === "approval-requested")
      const done = yield* collectAll(finished(chat.id))
      yield* send(chat.id, "Ask Bo")
      const request = (yield* Fiber.join(requested)).at(-1)!
      const handoffId = request.type === "approval-requested" ? request.conversationId : ""
      const runner = yield* AgentRunner
      expect(yield* runner.isRunning(handoffId)).toBe(true)

      yield* runner.cancelConversation(chat.id)
      const events = yield* Fiber.join(done)
      expect(events.find(finished(handoffId))).toMatchObject({ status: "cancelled" })
      expect(events.at(-1)).toMatchObject({ status: "cancelled" })
      expect(yield* runner.isRunning(handoffId)).toBe(false)
      const teammate = (yield* messagesOf(handoffId)).at(-1)!
      expect(teammate.status).toBe("cancelled")
      expect(teammate.parts[0]).toMatchObject({ approval: "denied" })
      expect((yield* messagesOf(chat.id)).at(-1)!.status).toBe("cancelled")
      expect(yield* (yield* Approvals).pending).toHaveLength(0)
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("waits while the teammate asks the person for approval, and says so in the asking chat", () => {
    const model = teamModel(commandFirst)
    return Effect.gen(function*() {
      const { chat } = yield* team({ tools: ["shell"], approvalMode: "ask" })
      const waiting = yield* collectAll((event) =>
        event.type === "activity" && event.conversationId === chat.id && event.text.startsWith("Waiting for your approval")
      )
      const requested = yield* collectAll((event) => event.type === "approval-requested")
      const done = yield* collectAll(finished(chat.id))
      yield* send(chat.id, "Ask Bo")
      expect((yield* Fiber.join(waiting)).at(-1)).toMatchObject({ text: "Waiting for your approval in Ada → Bo" })
      const request = (yield* Fiber.join(requested)).at(-1)!
      if (request.type !== "approval-requested") throw new Error("expected an approval request")
      expect((yield* handoffs)[0]!.id).toBe(request.conversationId)

      expect(yield* (yield* Approvals).resolve(request.approvalId, true)).toBe(true)
      const events = yield* Fiber.join(done)
      const activity = events.flatMap((event) =>
        event.type === "activity" && event.conversationId === chat.id ? [event.text] : []
      )
      expect(activity.slice(activity.indexOf("Waiting for your approval in Ada → Bo"))).toEqual([
        "Waiting for your approval in Ada → Bo",
        "Waiting for Bo",
        "",
        ""
      ])
      const reply = (yield* messagesOf(chat.id)).at(-1)!
      expect(resultOf(reply)).toMatchObject({ isFailure: false, output: "Bo replied:\n\nRan it." })
      const teammate = (yield* messagesOf(request.conversationId)).at(-1)!
      expect(teammate.parts[0]).toMatchObject({ approval: "approved" })
      expect((teammate.parts[1] as ToolResultPart).output).toContain("from-bo")
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("stopping the teammate (its conversation or the bot) fails the ask and the asking bot carries on", () => {
    const model = teamModel(commandFirst)
    return Effect.gen(function*() {
      const { bo, chat } = yield* team({ tools: ["shell"], approvalMode: "ask" })
      const runner = yield* AgentRunner
      for (const stop of [(id: string) => runner.cancelConversation(id), () => runner.cancelBot(bo.id)]) {
        const requested = yield* collectAll((event) => event.type === "approval-requested")
        const done = yield* collectAll(finished(chat.id))
        yield* send(chat.id, "Ask Bo")
        const request = (yield* Fiber.join(requested)).at(-1)!
        if (request.type !== "approval-requested") throw new Error("expected an approval request")
        yield* stop(request.conversationId)
        expect((yield* Fiber.join(done)).at(-1)).toMatchObject({ status: "done" })

        const reply = (yield* messagesOf(chat.id)).at(-1)!
        expect(reply.status).toBe("done")
        expect(resultOf(reply)).toMatchObject({
          isFailure: true,
          output: "Bo's reply was stopped before it finished.",
          handoffConversationId: request.conversationId
        })
        expect((yield* messagesOf(request.conversationId)).at(-1)!.status).toBe("cancelled")
      }
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("asks from two chats at once take turns instead of interrupting each other", () => {
    const model = teamModel(commandFirst)
    return Effect.gen(function*() {
      const { ada, chat } = yield* team({ tools: ["shell"], approvalMode: "ask" })
      const other = yield* createConversation([ada.id])
      const approvals = yield* Approvals
      const firstRequested = yield* collectAll((event) => event.type === "approval-requested")
      const done = new Set<string>()
      const bothDone = yield* collectAll((event) => {
        if (event.type === "run-finished" && [chat.id, other.id].includes(event.conversationId)) done.add(event.conversationId)
        return done.size === 2
      })
      yield* send(chat.id, "Ask Bo")
      yield* Fiber.join(firstRequested)
      const secondRequested = yield* collectAll((event) => event.type === "approval-requested")
      yield* send(other.id, "Ask Bo too")
      yield* Effect.sleep(Duration.millis(100))

      const [handoff] = yield* handoffs
      expect((yield* messagesOf(handoff!.id)).map((m) => [m.role, m.status])).toEqual([
        ["user", "done"],
        ["assistant", "streaming"]
      ])
      const [first] = yield* approvals.pending
      yield* approvals.resolve(first!, true)
      yield* Fiber.join(secondRequested)
      const [second] = yield* approvals.pending
      yield* approvals.resolve(second!, true)
      yield* Fiber.join(bothDone)

      expect(yield* handoffs).toHaveLength(1)
      expect((yield* messagesOf(handoff!.id)).map((m) => [m.role, m.status])).toEqual([
        ["user", "done"],
        ["assistant", "done"],
        ["user", "done"],
        ["assistant", "done"]
      ])
      for (const id of [chat.id, other.id]) {
        expect(resultOf((yield* messagesOf(id)).at(-1)!)).toMatchObject({ isFailure: false, output: "Bo replied:\n\nRan it." })
      }
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.effect("gives up on a teammate that doesn't finish within the time limit", () => {
    const model = teamModel(commandFirst)
    return Effect.gen(function*() {
      const { chat } = yield* team({ tools: ["shell"], approvalMode: "ask" })
      const approvals = yield* Approvals
      const runner = yield* AgentRunner
      yield* send(chat.id, "Ask Bo")
      for (let i = 0; i < 1000 && (yield* approvals.pending).length === 0; i++) yield* TestClock.adjust(Duration.millis(10))
      expect(yield* approvals.pending).toHaveLength(1)

      yield* TestClock.adjust(Duration.minutes(14))
      expect(yield* runner.isRunning(chat.id)).toBe(true)
      yield* TestClock.adjust(Duration.minutes(1))
      for (let i = 0; i < 1000 && (yield* runner.isRunning(chat.id)); i++) yield* TestClock.adjust(Duration.millis(10))

      const reply = (yield* messagesOf(chat.id)).at(-1)!
      expect(reply.status).toBe("done")
      const [handoff] = yield* handoffs
      expect(resultOf(reply)).toMatchObject({
        isFailure: true,
        output: "Bo didn't finish within 15 minutes.",
        handoffConversationId: handoff!.id
      })
      expect((yield* messagesOf(handoff!.id)).at(-1)!.status).toBe("cancelled")
      expect(yield* approvals.pending).toHaveLength(0)
    }).pipe(Effect.provide(testLayer(model.layer)))
  })
})

const memoryLayer = (memory: FakeMemory, model: Layer.Layer<LanguageModelFactory>) =>
  AgentRunnerLive.pipe(
    Layer.provideMerge(SelfReview.layer),
    Layer.provideMerge(Toolbox.layer),
    Layer.provideMerge(KnowledgeBase.layer),
    Layer.provideMerge(CoreMemory.layer),
    Layer.provideMerge(LibraryStore.layer),
    Layer.provideMerge(SkillStore.layer),
    Layer.provideMerge(Layer.mergeAll(memory.layer, RunEvents.layer, Approvals.layer, BotUsers.layer, Camofox.layer)),
    Layer.provideMerge(ProviderRegistry.layer),
    Layer.provideMerge(Layer.mergeAll(BotRepo.layer, ConversationRepo.layer, IntegrationRepo.layer, Settings.layer)),
    Layer.provideMerge(model),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(AppConfig.layerTest({
      dataDir: tempDir(),
      memory: Option.some({ url: "http://memory.test/mcp", token: "", project: "weaver-test" }),
      browserCommand: [],
      reviewSkillInterval: 0,
      reviewMemoryInterval: 0,
      coreMemoryCondenseAt: 0
    }))
  )

const writes = (memory: FakeMemory) => memory.calls.filter((call) => call.name === "write_note")

const waitForWrite = (memory: FakeMemory) =>
  Effect.gen(function*() {
    for (let i = 0; i < 100 && writes(memory).length === 0; i++) yield* Effect.sleep(Duration.millis(10))
  })

describe("handoff notes", () => {
  it.live("saves the request and answer to memory when either bot has memory", () => {
    const memory = fakeMemory()
    const model = teamModel()
    return Effect.gen(function*() {
      const { bo, chat } = yield* team()
      yield* (yield* BotRepo).update(bo.id, { tools: ["memory"] })
      yield* sendAndWaitAll(chat.id, "We need a tagline")
      yield* waitForWrite(memory)

      const [write] = writes(memory)
      expect(write!.args).toMatchObject({
        directory: "weaver/handoffs",
        tags: ["handoff"],
        project: "weaver-test",
        output_format: "json",
        content: "## Request\nWrite a tagline\n\n## Context\nFor a coffee shop\n\n## Answer\nFresh beans, warm hearts.\n\n" +
          "## Observations\n- [handoff] Ada asked Bo for help (via Weaver)\n\n" +
          "## Relations\n- requested_by [[Ada]]\n- answered_by [[Bo]]\n"
      })
      expect(write!.args.title).toMatch(/^Ada asked Bo: Write a tagline \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/)
      const search = memory.calls.find((call) => call.name === "search_notes")
      expect(search?.args.query).toBe("Write a tagline\n\nContext from Ada:\nFor a coffee shop")
    }).pipe(Effect.provide(memoryLayer(memory, model.layer)))
  })

  it.live("saves nothing when neither bot has memory", () => {
    const memory = fakeMemory()
    const model = teamModel()
    return Effect.gen(function*() {
      const { chat } = yield* team()
      yield* sendAndWaitAll(chat.id, "We need a tagline")
      yield* Effect.sleep(Duration.millis(100))
      expect(writes(memory)).toHaveLength(0)
      expect(resultOf((yield* messagesOf(chat.id)).at(-1)!).isFailure).toBe(false)
    }).pipe(Effect.provide(memoryLayer(memory, model.layer)))
  })

  it.live("a note that can't be saved doesn't affect the answer", () => {
    const memory = fakeMemory()
    memory.hooks.before = (call) =>
      call.name === "write_note" ? Effect.fail(new McpError({ server: "Memory", message: "memory is down" })) : Effect.void
    const model = teamModel()
    return Effect.gen(function*() {
      const { ada, chat } = yield* team()
      yield* (yield* BotRepo).update(ada.id, { tools: ["memory"] })
      yield* sendAndWaitAll(chat.id, "We need a tagline")
      yield* waitForWrite(memory)
      expect(writes(memory)).toHaveLength(1)
      const reply = (yield* messagesOf(chat.id)).at(-1)!
      expect(reply.status).toBe("done")
      expect(resultOf(reply)).toMatchObject({ isFailure: false, output: "Bo replied:\n\nFresh beans, warm hearts." })
    }).pipe(Effect.provide(memoryLayer(memory, model.layer)))
  })
})
