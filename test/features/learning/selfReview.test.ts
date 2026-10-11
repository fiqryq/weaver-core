import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Stream } from "effect"
import { LanguageModel, type Response } from "effect/ai"
import { AppConfig, type AppConfigShape } from "../../../src/config/Config.ts"
import type { Bot, BotCreate } from "../../../src/features/bots/Bot.ts"
import { BotRepo } from "../../../src/features/bots/BotRepo.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { type AfterReply, learnedText, reviewGuard, SelfReview } from "../../../src/features/learning/review/SelfReview.ts"
import { SkillStore } from "../../../src/features/learning/skills/SkillStore.ts"
import { Settings } from "../../../src/features/profile/Settings.ts"
import { LanguageModelFactory, ProviderRegistry } from "../../../src/features/providers/ProviderRegistry.ts"
import { AgentRunner } from "../../../src/features/runs/AgentRunner.ts"
import { AgentRunnerLive } from "../../../src/features/runs/AgentRunnerLive.ts"
import { Approvals } from "../../../src/features/runs/Approvals.ts"
import { RunEvents } from "../../../src/features/runs/RunEvents.ts"
import { type BotTools, Toolbox } from "../../../src/features/runs/Toolbox.ts"
import { DatabaseTest } from "../../../src/platform/db/Database.ts"
import { type AgentTool, ToolFailure } from "../../../src/tools/AgentTool.ts"
import { skillTools } from "../../../src/tools/learning/Skills.ts"

const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: Use when testing.\n---\n\n${body}`

interface ModelCall {
  readonly index: number
  readonly prompt: string
  readonly tools: ReadonlyArray<string>
}

const usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } }

/** Replies stream from `reply`; reviews (generateText) come from `review`, which may wait. */
const fakeModel = (script: {
  readonly reply?: (call: ModelCall) => ReadonlyArray<Response.StreamPartEncoded>
  readonly review?: (call: ModelCall) => Effect.Effect<ReadonlyArray<Response.PartEncoded>>
}) => {
  const replies: Array<ModelCall> = []
  const reviews: Array<ModelCall> = []
  const record = (calls: Array<ModelCall>, options: LanguageModel.ProviderOptions): ModelCall => {
    const call = {
      index: calls.length,
      prompt: JSON.stringify(options.prompt.content),
      tools: options.tools.map((tool) => tool.name)
    }
    calls.push(call)
    return call
  }
  const layer = Layer.succeed(
    LanguageModelFactory,
    LanguageModelFactory.of({
      make: () =>
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: (options) =>
              Effect.suspend(() => {
                const call = record(reviews, options)
                return script.review === undefined ? Effect.succeed([...answer("Nothing to save.")]) : script.review(call)
              }).pipe(Effect.map((parts) => [...parts])),
            streamText: (options) =>
              Stream.suspend(() => Stream.fromIterable(script.reply?.(record(replies, options)) ?? sayStream("Hi")))
          })
        )
    })
  )
  return { replies, reviews, layer }
}

const answer = (text: string): ReadonlyArray<Response.PartEncoded> => [
  { type: "text", text },
  { type: "finish", reason: "stop", usage }
]

const toolCalls = (...calls: ReadonlyArray<[name: string, params: unknown]>): ReadonlyArray<Response.PartEncoded> => [
  ...calls.map(([name, params], index): Response.PartEncoded => ({ type: "tool-call", id: `c${index}-${name}`, name, params })),
  { type: "finish", reason: "tool-calls", usage }
]

const sayStream = (text: string): ReadonlyArray<Response.StreamPartEncoded> => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", reason: "stop", usage }
]

const callStream = (name: string, params: unknown): ReadonlyArray<Response.StreamPartEncoded> => [
  { type: "tool-call", id: `call-${name}`, name, params },
  { type: "finish", reason: "tool-calls", usage }
]

/** Tools named like the real skill and memory tools, recording every call that reached them. */
const fakeTools = () => {
  const ran: Array<{ name: string; params: Record<string, unknown> }> = []
  const skills = new Map<string, string>([["deploy-checks", "# Deploy checks\n1. Run the tests."]])
  const tool = (name: string, run: (params: Record<string, unknown>) => Effect.Effect<string, ToolFailure>, needsApproval = false): AgentTool => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    needsApproval,
    activity: name,
    title: () => name,
    run: (raw) => {
      const params = (raw ?? {}) as Record<string, unknown>
      ran.push({ name, params })
      return run(params)
    }
  })
  const fail = (message: string) => Effect.fail(new ToolFailure({ message }))
  const tools = [
    tool("skills_list", () => Effect.succeed([...skills.keys()].join("\n"))),
    tool("skill_view", (p) => {
      const content = skills.get(String(p.name))
      return content === undefined ? fail(`No skill named ${String(p.name)}`) : Effect.succeed(content)
    }),
    tool("skill_manage", (p) => {
      const name = String(p.name)
      if (p.action === "create") {
        skills.set(name, String(p.content ?? ""))
        return Effect.succeed(`Created ${name}`)
      }
      if (!skills.has(name)) return fail(`No skill named ${name}`)
      if (p.action === "delete") skills.delete(name)
      return Effect.succeed(`${String(p.action)} ${name}`)
    }),
    tool("read_file", () => Effect.succeed("file")),
    tool("search_notes", () => Effect.succeed("[]")),
    tool("read_note", () => Effect.succeed("{}")),
    tool("write_note", (p) => Effect.succeed(`Wrote ${String(p.title)}`)),
    tool("edit_note", (p) => Effect.succeed(`Edited ${String(p.identifier)}`)),
    tool("run_command", () => Effect.succeed("ran")),
    tool("ask_first", () => Effect.succeed("asked"), true)
  ]
  return { ran, skills, tools }
}

/** A fixed tool list, or one built per bot from the real skill store. */
type TestTools = ReadonlyArray<AgentTool> | ((store: SkillStore["Service"], botId: string) => ReadonlyArray<AgentTool>)

const toolboxLayer = (tools: TestTools) =>
  Layer.effect(
    Toolbox,
    Effect.gen(function*() {
      const store = yield* SkillStore
      return Toolbox.of({
        forBot: (bot) =>
          Effect.succeed({
            tools: typeof tools === "function" ? tools(store, bot.id) : tools,
            workspace: "/tmp/weaver-test-workspace",
            memoryEnabled: false,
            coreMemory: undefined,
            skills: [],
            integrations: [],
            unavailable: []
          } as BotTools)
      })
    })
  )

const baseLayer = (
  model: Layer.Layer<LanguageModelFactory>,
  tools: TestTools,
  config: Partial<AppConfigShape>
) =>
  Layer.mergeAll(toolboxLayer(tools), ProviderRegistry.layer, Approvals.layer).pipe(
    Layer.provideMerge(SkillStore.layer),
    Layer.provideMerge(RunEvents.layer),
    Layer.provideMerge(Layer.mergeAll(BotRepo.layer, ConversationRepo.layer, Settings.layer)),
    Layer.provideMerge(model),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(AppConfig.layerTest({
      dataDir: mkdtempSync(join(tmpdir(), "weaver-review-")),
      memory: Option.some({ url: "http://memory.test/mcp", token: "", project: "" }),
      browserCommand: [],
      ...config
    }))
  )

const reviewLayer = (
  model: Layer.Layer<LanguageModelFactory>,
  tools: TestTools,
  config: Partial<AppConfigShape> = {}
) => SelfReview.layer.pipe(Layer.provideMerge(baseLayer(model, tools, config)))

const setup = (input: Partial<BotCreate> = {}) =>
  Effect.gen(function*() {
    yield* (yield* ProviderRegistry).update("deepseek", { apiKey: "sk-test" })
    const bot = yield* (yield* BotRepo).create({ name: "Ada", tools: ["skills"], approvalMode: "auto", ...input })
    const conversations = yield* ConversationRepo
    const conversation = yield* conversations.create({ title: "Deploys", botIds: [bot.id] })
    yield* conversations.insertMessage({
      conversationId: conversation.id,
      role: "user",
      parts: [{ type: "text", text: "Deploy the site, and always run the smoke test first." }]
    })
    const message = yield* conversations.insertMessage({
      conversationId: conversation.id,
      role: "assistant",
      botId: bot.id,
      senderName: bot.name,
      parts: [{ type: "text", text: "Deployed after the smoke test passed." }]
    })
    const reply = (patch: Partial<AfterReply> = {}): AfterReply => ({
      bot,
      conversationId: conversation.id,
      messageId: message.id,
      toolSteps: 0,
      usedSkillManage: false,
      usedMemoryWrite: false,
      ...patch
    })
    return { bot, conversation, message, reply }
  })

/** Waits for the bot's background review to finish. */
const settle = (bot: Bot) =>
  Effect.gen(function*() {
    const selfReview = yield* SelfReview
    yield* Effect.sleep(Duration.millis(5))
    while (yield* selfReview.isReviewing(bot.id)) yield* Effect.sleep(Duration.millis(5))
  }).pipe(Effect.timeout(Duration.seconds(5)))

describe("SelfReview counters", () => {
  it.live("starts a skill review once enough tool steps add up, then starts counting again", () => {
    const model = fakeModel({})
    const { tools } = fakeTools()
    return Effect.gen(function*() {
      const { bot, reply } = yield* setup()
      const selfReview = yield* SelfReview

      yield* selfReview.afterReply(reply({ toolSteps: 2 }))
      yield* settle(bot)
      expect(model.reviews).toHaveLength(0)

      yield* selfReview.afterReply(reply({ toolSteps: 1 }))
      yield* settle(bot)
      expect(model.reviews).toHaveLength(1)
      const call = model.reviews[0]!
      expect(call.prompt).toContain("update your skill library")
      expect(call.prompt).toContain("You can only call skill management tools.")
      expect(call.prompt).toContain("Deployed after the smoke test passed.")
      expect(call.tools).toContain("skill_manage")

      yield* selfReview.afterReply(reply({ toolSteps: 2 }))
      yield* settle(bot)
      expect(model.reviews).toHaveLength(1)
    }).pipe(Effect.provide(reviewLayer(model.layer, tools, { reviewSkillInterval: 3, reviewMemoryInterval: 0 })))
  })

  it.live("resets the skill counter when the bot managed its skills itself", () => {
    const model = fakeModel({})
    const { tools } = fakeTools()
    return Effect.gen(function*() {
      const { bot, reply } = yield* setup()
      const selfReview = yield* SelfReview
      yield* selfReview.afterReply(reply({ toolSteps: 2 }))
      yield* selfReview.afterReply(reply({ toolSteps: 2, usedSkillManage: true }))
      yield* selfReview.afterReply(reply({ toolSteps: 2 }))
      yield* settle(bot)
      expect(model.reviews).toHaveLength(0)
    }).pipe(Effect.provide(reviewLayer(model.layer, tools, { reviewSkillInterval: 3, reviewMemoryInterval: 0 })))
  })

  it.live("reviews memory every few replies, resets on the bot's own memory writes, and needs memory on", () => {
    const model = fakeModel({})
    const { tools } = fakeTools()
    return Effect.gen(function*() {
      const { bot, reply } = yield* setup({ tools: ["memory"] })
      const selfReview = yield* SelfReview

      yield* selfReview.afterReply(reply())
      yield* selfReview.afterReply(reply({ usedMemoryWrite: true }))
      yield* selfReview.afterReply(reply())
      yield* settle(bot)
      expect(model.reviews).toHaveLength(0)

      yield* selfReview.afterReply(reply())
      yield* settle(bot)
      expect(model.reviews).toHaveLength(1)
      const call = model.reviews[0]!
      expect(call.prompt).toContain("consider saving to memory")
      expect(call.prompt).toContain("You can only call memory management tools.")
      expect(call.tools).toContain("write_note")

      const { bot: plain, reply: plainReply } = yield* setup({ name: "Bo", tools: [] })
      for (let i = 0; i < 4; i++) yield* selfReview.afterReply(plainReply({ toolSteps: 5 }))
      yield* settle(plain)
      expect(model.reviews).toHaveLength(1)
    }).pipe(Effect.provide(reviewLayer(model.layer, tools, { reviewSkillInterval: 1, reviewMemoryInterval: 2 })))
  })

  it.live("doesn't review memory when Basic Memory isn't configured", () => {
    const model = fakeModel({})
    const { tools } = fakeTools()
    return Effect.gen(function*() {
      const { bot, reply } = yield* setup({ tools: ["memory"] })
      const selfReview = yield* SelfReview
      for (let i = 0; i < 3; i++) yield* selfReview.afterReply(reply())
      yield* settle(bot)
      expect(model.reviews).toHaveLength(0)
    }).pipe(Effect.provide(reviewLayer(model.layer, tools, { reviewMemoryInterval: 1, memory: Option.none() })))
  })

  it.live("runs one review per bot at a time", () => {
    const { tools } = fakeTools()
    const gate = Deferred.makeUnsafe<void>()
    const model = fakeModel({ review: () => Effect.as(Deferred.await(gate), answer("Nothing to save.")) })
    return Effect.gen(function*() {
      const { bot, reply } = yield* setup()
      const selfReview = yield* SelfReview
      yield* selfReview.afterReply(reply({ toolSteps: 1 }))
      yield* Effect.sleep(Duration.millis(20))
      expect(yield* selfReview.isReviewing(bot.id)).toBe(true)
      yield* selfReview.afterReply(reply({ toolSteps: 1 }))
      yield* Deferred.succeed(gate, undefined)
      yield* settle(bot)
      expect(model.reviews).toHaveLength(1)

      yield* selfReview.afterReply(reply({ toolSteps: 1 }))
      yield* settle(bot)
      expect(model.reviews).toHaveLength(2)
    }).pipe(Effect.provide(reviewLayer(model.layer, tools, { reviewSkillInterval: 1, reviewMemoryInterval: 0 })))
  })

  it.live("keeps a review due while another one runs, and starts it after the next reply", () => {
    const { tools } = fakeTools()
    const gate = Deferred.makeUnsafe<void>()
    const model = fakeModel({
      review: (call) => call.index === 0 ? Effect.as(Deferred.await(gate), answer("Nothing to save.")) : Effect.succeed(answer("Ok."))
    })
    return Effect.gen(function*() {
      const { bot, reply } = yield* setup()
      const selfReview = yield* SelfReview
      yield* selfReview.afterReply(reply({ toolSteps: 2 }))
      yield* Effect.sleep(Duration.millis(20))
      yield* selfReview.afterReply(reply({ toolSteps: 2 }))
      yield* Deferred.succeed(gate, undefined)
      yield* settle(bot)
      expect(model.reviews).toHaveLength(1)

      yield* selfReview.afterReply(reply({ toolSteps: 0 }))
      yield* settle(bot)
      expect(model.reviews).toHaveLength(2)
    }).pipe(Effect.provide(reviewLayer(model.layer, tools, { reviewSkillInterval: 2, reviewMemoryInterval: 0 })))
  })

  it.live("cancel stops a running review and ignores the deleted bot's later replies", () => {
    const { tools } = fakeTools()
    const model = fakeModel({ review: () => Effect.as(Effect.never, answer("Nothing to save.")) })
    return Effect.gen(function*() {
      const { bot, reply } = yield* setup()
      const selfReview = yield* SelfReview
      yield* selfReview.afterReply(reply({ toolSteps: 1 }))
      yield* Effect.sleep(Duration.millis(20))
      expect(yield* selfReview.isReviewing(bot.id)).toBe(true)

      yield* selfReview.cancel(bot.id)
      expect(yield* selfReview.isReviewing(bot.id)).toBe(false)
      yield* selfReview.afterReply(reply({ toolSteps: 5 }))
      yield* Effect.sleep(Duration.millis(20))
      expect(yield* selfReview.isReviewing(bot.id)).toBe(false)
      expect(model.reviews).toHaveLength(1)
    }).pipe(Effect.provide(reviewLayer(model.layer, tools, { reviewSkillInterval: 1, reviewMemoryInterval: 0 })))
  })

  it.live("logs and swallows a failing review", () => {
    const { tools } = fakeTools()
    const model = fakeModel({ review: () => Effect.die("boom") })
    return Effect.gen(function*() {
      const { bot, reply } = yield* setup()
      const selfReview = yield* SelfReview
      yield* selfReview.afterReply(reply({ toolSteps: 1 }))
      yield* settle(bot)
      expect(model.reviews).toHaveLength(1)
      expect(yield* selfReview.isReviewing(bot.id)).toBe(false)
    }).pipe(Effect.provide(reviewLayer(model.layer, tools, { reviewSkillInterval: 1, reviewMemoryInterval: 0 })))
  })
})

describe("SelfReview.review", () => {
  it.live("enforces the guards and records what it learned on the message", () => {
    const fake = fakeTools()
    const model = fakeModel({
      review: (call) =>
        Effect.succeed(
          call.index === 0
            ? toolCalls(
              ["skill_manage", { action: "delete", name: "deploy-checks" }],
              ["skill_manage", { action: "remove_file", name: "deploy-checks", file_path: "references/a.md" }],
              ["skill_manage", { action: "patch", name: "deploy-checks", old_string: "1.", new_string: "1. Smoke test." }],
              ["edit_note", { identifier: "weaver/core-memory", operation: "replace_section", content: "x" }],
              ["run_command", { command: "rm -rf /" }],
              ["ask_first", {}]
            )
            : call.index === 1
            ? toolCalls(["skill_view", { name: "deploy-checks" }])
            : call.index === 2
            ? toolCalls(
              ["skill_manage", { action: "patch", name: "deploy-checks", old_string: "1.", new_string: "1. Smoke test." }],
              ["skill_manage", { action: "create", name: "release-notes", content: "# Release notes" }],
              ["skill_manage", { action: "write_file", name: "release-notes", file_path: "references/format.md", file_content: "x" }],
              ["write_note", { title: "Deploy targets", folder: "weaver", content: "- [fact] prod is fly.io" }],
              ["edit_note", { identifier: "weaver/core-memory", operation: "append", content: "- [fact] smoke test first" }]
            )
            : answer("Saved what matters.")
        )
    })
    return Effect.gen(function*() {
      const { bot, conversation, message } = yield* setup({ tools: ["skills", "memory"] })
      const selfReview = yield* SelfReview
      const events = yield* RunEvents
      const done = yield* events.subscribe(conversation.id).pipe(
        Stream.filter((event) => event.type === "message-done"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.sleep(Duration.millis(20))

      const learned = yield* selfReview.review({
        bot,
        conversationId: conversation.id,
        messageId: message.id,
        kinds: new Set(["skills", "memory"])
      })

      expect(model.reviews).toHaveLength(4)
      expect(model.reviews[0]!.prompt).toContain("update two things")
      const refusals = model.reviews[1]!.prompt
      expect(refusals).toContain("can't delete skills")
      expect(refusals).toContain("Read-before-write")
      expect(refusals).toContain("only supports operation \\\"append\\\"")
      expect(refusals).toContain("denied non-allowlisted tool: run_command")
      expect(refusals).toContain("denied non-allowlisted tool: ask_first")

      expect(fake.ran.map((call) => [call.name, call.params.action ?? call.params.operation ?? ""])).toEqual([
        ["skill_view", ""],
        ["skill_manage", "patch"],
        ["skill_manage", "create"],
        ["skill_manage", "write_file"],
        ["write_note", ""],
        ["edit_note", "append"]
      ])
      expect(fake.skills.has("deploy-checks")).toBe(true)

      expect(learned).toEqual([
        "Updated skill \"deploy-checks\"",
        "Created skill \"release-notes\"",
        "Updated skill \"release-notes\"",
        "Saved to memory: Deploy targets",
        "Added to Core Memory"
      ])
      const stored = yield* (yield* ConversationRepo).getMessage(message.id)
      expect(stored!.parts.filter((part) => part.type === "learned").map((part) => (part as { text: string }).text))
        .toEqual(learned)
      const published = yield* Fiber.join(done)
      expect(published[0]).toMatchObject({ type: "message-done", message: { id: message.id } })
      if (published[0]?.type === "message-done") {
        expect(published[0].message.parts.at(-1)).toEqual({ type: "learned", text: "Added to Core Memory" })
      }
    }).pipe(Effect.provide(reviewLayer(model.layer, fake.tools)))
  })

  it.live("leaves the message alone when nothing was saved, and skips kinds without tools", () => {
    const model = fakeModel({})
    return Effect.gen(function*() {
      const { bot, conversation, message } = yield* setup({ tools: ["skills", "memory"] })
      const selfReview = yield* SelfReview
      const input = { bot, conversationId: conversation.id, messageId: message.id }
      expect(yield* selfReview.review({ ...input, kinds: new Set(["skills", "memory"]) })).toEqual([])
      expect(model.reviews).toHaveLength(0)
      const stored = yield* (yield* ConversationRepo).getMessage(message.id)
      expect(stored!.parts.map((part) => part.type)).toEqual(["text"])
    }).pipe(Effect.provide(reviewLayer(model.layer, [])))
  })

  it.live("keeps a memory review away from skills and never overwrites notes", () => {
    const fake = fakeTools()
    const model = fakeModel({
      review: (call) =>
        Effect.succeed(
          call.index === 0
            ? toolCalls(
              ["skill_manage", { action: "create", name: "sneaky", content: "# x" }],
              ["skills_list", {}],
              ["write_note", { title: "Replace", folder: "weaver", content: "x", overwrite: true }],
              ["write_note", { title: "Fresh", folder: "weaver", content: "- [fact] y" }]
            )
            : answer("Saved.")
        )
    })
    return Effect.gen(function*() {
      const { bot, conversation, message } = yield* setup({ tools: ["skills", "memory"] })
      const learned = yield* (yield* SelfReview).review({
        bot,
        conversationId: conversation.id,
        messageId: message.id,
        kinds: new Set(["memory"])
      })
      const results = model.reviews[1]!.prompt
      expect(results).toContain("denied non-allowlisted tool: skill_manage")
      expect(results).toContain("denied non-allowlisted tool: skills_list")
      expect(results).not.toContain("skill_manage (create")
      expect(results).toContain("write_note can't overwrite")
      expect(fake.ran.map((call) => call.name)).toEqual(["write_note"])
      expect(fake.ran[0]!.params).toMatchObject({ title: "Fresh", overwrite: false })
      expect(fake.skills.has("sneaky")).toBe(false)
      expect(learned).toEqual(["Saved to memory: Fresh"])
    }).pipe(Effect.provide(reviewLayer(model.layer, fake.tools)))
  })

  it.live("refuses writes when SKILL.md changed since it was viewed, and file views don't count as reading it", () => {
    let store: SkillStore["Service"] | undefined
    let botId = ""
    const model = fakeModel({
      review: (call) => {
        const patch = toolCalls(["skill_manage", { action: "patch", name: "deploy", old_string: "1. Run the tests.", new_string: "1. Run the smoke test." }])
        switch (call.index) {
          case 0:
            return Effect.succeed(toolCalls(["skill_view", { name: "deploy" }]))
          case 1:
            return Effect.as(
              Effect.orDie(store!.replaceContent(botId, "deploy", skillMd("deploy", "1. Run the tests.\n2. Edited by the user.\n"), "user")),
              patch
            )
          case 2:
            return Effect.succeed(toolCalls(["skill_view", { name: "deploy", file_path: "references/hosts.md" }]))
          case 3:
            return Effect.succeed(patch)
          case 4:
            return Effect.succeed(toolCalls(["skill_view", { name: "deploy" }]))
          case 5:
            return Effect.succeed(patch)
          default:
            return Effect.succeed(answer("Done."))
        }
      }
    })
    return Effect.gen(function*() {
      const { bot, conversation, message } = yield* setup()
      store = yield* SkillStore
      botId = bot.id
      yield* store.create(bot.id, { name: "deploy", content: skillMd("deploy", "1. Run the tests.\n") }, "agent")
      yield* store.writeFile(bot.id, "deploy", "references/hosts.md", "web-1\n")

      const learned = yield* (yield* SelfReview).review({
        bot,
        conversationId: conversation.id,
        messageId: message.id,
        kinds: new Set(["skills"])
      })
      expect(model.reviews[2]!.prompt).toContain("changed after you viewed it")
      expect(model.reviews[4]!.prompt).toContain("Read-before-write: call skill_view(name=")
      expect(learned).toEqual(["Updated skill \"deploy\""])
      const content = (yield* store.get(bot.id, "deploy")).content
      expect(content).toContain("1. Run the smoke test.")
      expect(content).toContain("2. Edited by the user.")
    }).pipe(Effect.provide(reviewLayer(model.layer, (store, botId) => skillTools({ store, botId }))))
  })

  it.live("can only patch a skill the user wrote, and the original is archived", () => {
    const model = fakeModel({
      review: (call) =>
        Effect.succeed(
          call.index === 0
            ? toolCalls(["skill_view", { name: "notes" }])
            : call.index === 1
            ? toolCalls(
              ["skill_manage", { action: "edit", name: "notes", content: skillMd("notes", "Rewritten.\n") }],
              ["skill_manage", { action: "patch", name: "notes", content: skillMd("notes", "Rewritten.\n") }],
              ["skill_manage", { action: "patch", name: "notes", old_string: "Keep it short.", new_string: "Keep it very short." }]
            )
            : answer("Done.")
        )
    })
    return Effect.gen(function*() {
      const { bot, conversation, message } = yield* setup()
      const store = yield* SkillStore
      const original = skillMd("notes", "Keep it short.\n")
      yield* store.create(bot.id, { name: "notes", content: original }, "user")

      yield* (yield* SelfReview).review({ bot, conversationId: conversation.id, messageId: message.id, kinds: new Set(["skills"]) })
      const refusals = model.reviews[2]!.prompt
      expect(refusals.match(/was written by the user/g)).toHaveLength(2)
      const saved = yield* store.get(bot.id, "notes")
      expect(saved.content).toContain("Keep it very short.")
      expect(saved.createdBy).toBe("user")
      const archive = join((yield* AppConfig).dataDir, "bots", bot.id, "skills", ".archive")
      const archived = readdirSync(archive)
      expect(archived).toHaveLength(1)
      expect(archived[0]).toMatch(/^notes-/)
      expect(readFileSync(join(archive, archived[0]!, "SKILL.md"), "utf8")).toBe(original)
    }).pipe(Effect.provide(reviewLayer(model.layer, (store, botId) => skillTools({ store, botId }))))
  })

  it.live("shows the reviewed reply's tool calls in the review prompt", () => {
    const fake = fakeTools()
    const model = fakeModel({})
    return Effect.gen(function*() {
      const { bot, conversation } = yield* setup()
      const conversations = yield* ConversationRepo
      const message = yield* conversations.insertMessage({
        conversationId: conversation.id,
        role: "assistant",
        botId: bot.id,
        senderName: bot.name,
        parts: [
          { type: "tool-call", id: "c1", name: "skill_view", title: "Viewed skill", params: { name: "deploy-checks" } },
          { type: "tool-result", id: "c1", name: "skill_view", output: "x".repeat(5000), isFailure: false },
          { type: "tool-call", id: "c2", name: "run_command", title: "Ran", params: { command: "deploy" } },
          { type: "tool-result", id: "c2", name: "run_command", output: "exit 1", isFailure: true },
          { type: "text", text: "Deployed." }
        ]
      })
      yield* (yield* SelfReview).review({ bot, conversationId: conversation.id, messageId: message.id, kinds: new Set(["skills"]) })
      const prompt = model.reviews[0]!.prompt
      expect(prompt).toContain("The tool calls you made in the reply under review")
      expect(prompt).toContain("1. skill_view {\\\"name\\\":\\\"deploy-checks\\\"}")
      expect(prompt).toContain("truncated, 3500 more characters")
      expect(prompt).toContain("2. run_command {\\\"command\\\":\\\"deploy\\\"}\\nFailed:\\nexit 1")
    }).pipe(Effect.provide(reviewLayer(model.layer, fake.tools)))
  })

  it.live("reports a tool that crashes as a failed call and keeps reviewing", () => {
    const fake = fakeTools()
    const crashing: AgentTool = { ...fake.tools.find((tool) => tool.name === "skills_list")!, run: () => Effect.die(new Error("disk on fire")) }
    const model = fakeModel({
      review: (call) => Effect.succeed(call.index === 0 ? toolCalls(["skills_list", {}]) : answer("Nothing to save."))
    })
    return Effect.gen(function*() {
      const { bot, conversation, message } = yield* setup()
      const learned = yield* (yield* SelfReview).review({
        bot,
        conversationId: conversation.id,
        messageId: message.id,
        kinds: new Set(["skills"])
      })
      expect(learned).toEqual([])
      expect(model.reviews[1]!.prompt).toContain("skills_list failed unexpectedly: disk on fire")
    }).pipe(Effect.provide(reviewLayer(model.layer, [crashing, ...fake.tools.filter((tool) => tool.name !== "skills_list")])))
  })

  it("guards and learned labels", () => {
    expect(reviewGuard("write_note", { title: "x" }, new Set())).toBeUndefined()
    expect(reviewGuard("write_note", { title: "x", overwrite: false }, new Set())).toBeUndefined()
    expect(reviewGuard("write_note", { title: "x", overwrite: true }, new Set())).toContain("can't overwrite")
    expect(reviewGuard("write_note", { title: "x", overwrite: "true" }, new Set())).toContain("can't overwrite")
    expect(reviewGuard("skill_manage", { action: "create", name: "new" }, new Set())).toBeUndefined()
    expect(reviewGuard("skill_manage", { action: "edit", name: "old" }, new Set())).toContain("skill_view")
    expect(reviewGuard("skill_manage", { action: "edit", name: "old" }, new Set(["old"]))).toBeUndefined()
    expect(reviewGuard("edit_note", { identifier: "x", operation: "append" }, new Set())).toBeUndefined()
    expect(reviewGuard("edit_note", { identifier: "x" }, new Set())).toContain("append")
    expect(reviewGuard("move_note", {}, new Set())).toContain("can't move")
    expect(learnedText("skill_view", { name: "x" })).toBeUndefined()
    expect(learnedText("edit_note", { identifier: "Core Memory", operation: "append" })).toBe("Added to Core Memory")
    expect(learnedText("edit_note", { identifier: "weaver/projects", operation: "append" })).toBe(
      "Updated memory: weaver/projects"
    )
  })
})

describe("AgentRunner and SelfReview", () => {
  const recordingReview = () => {
    const calls: Array<AfterReply> = []
    const layer = Layer.succeed(
      SelfReview,
      SelfReview.of({
        afterReply: (input) => Effect.sync(() => void calls.push(input)),
        review: () => Effect.succeed([]),
        isReviewing: () => Effect.succeed(false),
        cancel: () => Effect.void
      })
    )
    return { calls, layer }
  }

  const runnerLayer = (model: Layer.Layer<LanguageModelFactory>, tools: ReadonlyArray<AgentTool>, review: Layer.Layer<SelfReview>) =>
    AgentRunnerLive.pipe(Layer.provideMerge(review), Layer.provideMerge(baseLayer(model, tools, {})))

  const runUntilFinished = (conversationId: string, text: string) =>
    Effect.gen(function*() {
      const events = yield* RunEvents
      const finished = yield* events.subscribe(conversationId).pipe(
        Stream.takeUntil((event) => event.type === "run-finished"),
        Stream.runCollect,
        Effect.timeout(Duration.seconds(5)),
        Effect.forkChild
      )
      yield* Effect.sleep(Duration.millis(20))
      yield* (yield* ConversationRepo).insertMessage({ conversationId, role: "user", parts: [{ type: "text", text }] })
      yield* (yield* AgentRunner).start(conversationId)
      return yield* Fiber.join(finished)
    })

  it.live("reports tool steps and the bot's own skill and memory writes after a finished reply", () => {
    const fake = fakeTools()
    const review = recordingReview()
    const model = fakeModel({
      reply: (call) =>
        call.index === 0
          ? callStream("skill_manage", { action: "create", name: "x", content: "y" })
          : call.index === 1
          ? callStream("write_note", { title: "t", content: "c" })
          : sayStream("Done.")
    })
    return Effect.gen(function*() {
      const { bot, conversation } = yield* setup({ tools: ["skills", "memory"] })
      yield* runUntilFinished(conversation.id, "Go")
      expect(review.calls).toHaveLength(1)
      expect(review.calls[0]).toMatchObject({
        conversationId: conversation.id,
        toolSteps: 2,
        usedSkillManage: true,
        usedMemoryWrite: true
      })
      expect(review.calls[0]!.bot.id).toBe(bot.id)
    }).pipe(Effect.provide(runnerLayer(model.layer, fake.tools, review.layer)))
  })

  it.live("reports a tool that crashes as a failed call and finishes the reply", () => {
    const fake = fakeTools()
    const review = recordingReview()
    const crashing: AgentTool = { ...fake.tools.find((tool) => tool.name === "read_file")!, run: () => Effect.die(new Error("EEXIST")) }
    const model = fakeModel({ reply: (call) => call.index === 0 ? callStream("read_file", { path: "x" }) : sayStream("Recovered.") })
    return Effect.gen(function*() {
      const { conversation } = yield* setup()
      const events = yield* runUntilFinished(conversation.id, "Go")
      expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "done" })
      expect(events.find((event) => event.type === "tool-result")).toMatchObject({
        part: { name: "read_file", isFailure: true, output: "read_file failed unexpectedly: EEXIST" }
      })
      expect(model.replies[1]!.prompt).toContain("read_file failed unexpectedly: EEXIST")
      expect(review.calls).toHaveLength(1)
    }).pipe(Effect.provide(runnerLayer(model.layer, [crashing], review.layer)))
  })

  it.live("doesn't count failed replies", () => {
    const fake = fakeTools()
    const review = recordingReview()
    const model = fakeModel({ reply: () => [{ type: "error", error: "provider exploded" }] })
    return Effect.gen(function*() {
      const { conversation } = yield* setup()
      const events = yield* runUntilFinished(conversation.id, "Go")
      expect(events.some((event) => event.type === "message-done" && event.message.status === "error")).toBe(true)
      expect(review.calls).toHaveLength(0)
    }).pipe(Effect.provide(runnerLayer(model.layer, fake.tools, review.layer)))
  })

  it.live("doesn't count cancelled replies", () => {
    const fake = fakeTools()
    const review = recordingReview()
    const model = fakeModel({ reply: () => callStream("ask_first", {}) })
    return Effect.gen(function*() {
      const { conversation } = yield* setup()
      const runner = yield* AgentRunner
      const events = yield* RunEvents
      const requested = yield* events.subscribe(conversation.id).pipe(
        Stream.filter((event) => event.type === "approval-requested"),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout(Duration.seconds(5)),
        Effect.forkChild
      )
      const finished = yield* events.subscribe(conversation.id).pipe(
        Stream.takeUntil((event) => event.type === "run-finished"),
        Stream.runCollect,
        Effect.timeout(Duration.seconds(5)),
        Effect.forkChild
      )
      yield* Effect.sleep(Duration.millis(20))
      yield* (yield* ConversationRepo).insertMessage({
        conversationId: conversation.id,
        role: "user",
        parts: [{ type: "text", text: "Go" }]
      })
      yield* runner.start(conversation.id)
      yield* Fiber.join(requested)
      yield* runner.cancelConversation(conversation.id)
      expect((yield* Fiber.join(finished)).at(-1)).toMatchObject({ type: "run-finished", status: "cancelled" })
      expect(review.calls).toHaveLength(0)
    }).pipe(Effect.provide(runnerLayer(model.layer, fake.tools, review.layer)))
  })
})
