import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AiError, LanguageModel, type Response } from "effect/ai"
import { AppConfig, type AppConfigShape } from "../../../src/config/Config.ts"
import { BotRepo } from "../../../src/features/bots/BotRepo.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { McpError } from "../../../src/features/integrations/McpHub.ts"
import { LibraryStore } from "../../../src/features/learning/library/LibraryStore.ts"
import { CoreMemory } from "../../../src/features/learning/memory/CoreMemory.ts"
import { backupTitle, condensedBody, condenseRejection } from "../../../src/features/learning/memory/condense.ts"
import { SelfReview } from "../../../src/features/learning/review/SelfReview.ts"
import { SkillStore } from "../../../src/features/learning/skills/SkillStore.ts"
import { Settings } from "../../../src/features/profile/Settings.ts"
import { LanguageModelFactory, ProviderRegistry } from "../../../src/features/providers/ProviderRegistry.ts"
import { AgentRunnerLive } from "../../../src/features/runs/AgentRunnerLive.ts"
import { Approvals } from "../../../src/features/runs/Approvals.ts"
import { RunEvents } from "../../../src/features/runs/RunEvents.ts"
import { Toolbox } from "../../../src/features/runs/Toolbox.ts"
import { DatabaseTest } from "../../../src/platform/db/Database.ts"
import { corePermalink } from "../../../src/tools/builtin/Memory.ts"
import { type FakeMemory, fakeMemory } from "../../support/fakeMemory.ts"
import { sendAndWait } from "../../support/layers.ts"

const threshold = 600
const historyFolder = "weaver/core-memory-history"
const usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } }

const fact = (i: number, bot: string) => `- [fact] The user's project number ${i} is built with Bun and Effect (via ${bot})`
const original = [
  "# Core Memory",
  "Always answer in English.",
  ...Array.from({ length: 7 }, (_, i) => fact(i, "Ada")),
  ...Array.from({ length: 7 }, (_, i) => fact(i, "Bo"))
].join("\n")
const condensed = [
  "# Core Memory",
  "Always answer in English.",
  ...Array.from({ length: 7 }, (_, i) => fact(i, "Ada, Bo"))
].join("\n")

/** Replies stream "Hi"; condensing (generateText) answers with `answer`. */
const condenseModel = (answer: (prompt: string) => Effect.Effect<string, AiError.AiError>) => {
  const prompts: Array<string> = []
  const layer = Layer.succeed(
    LanguageModelFactory,
    LanguageModelFactory.of({
      make: () =>
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: (options) =>
              Effect.suspend(() => {
                const prompt = JSON.stringify(options.prompt.content)
                prompts.push(prompt)
                return answer(prompt)
              }).pipe(Effect.map((text): Array<Response.PartEncoded> => [{ type: "text", text }, { type: "finish", reason: "stop", usage }])),
            streamText: () =>
              Stream.fromIterable<Response.StreamPartEncoded>([
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "Hi" },
                { type: "text-end", id: "t" },
                { type: "finish", reason: "stop", usage }
              ])
          })
        )
    })
  )
  return { prompts, layer }
}

const modelError = AiError.make({
  module: "OpenAiClient",
  method: "createResponse",
  reason: new AiError.InternalProviderError({ description: "upstream exploded" })
})

const toolbox = Layer.succeed(
  Toolbox,
  Toolbox.of({
    forBot: () =>
      Effect.succeed({
        tools: [],
        workspace: "/tmp/weaver-test-workspace",
        memoryEnabled: false,
        memoryProject: undefined,
        coreMemory: undefined,
        recall: [],
        skills: [],
        integrations: [],
        unavailable: []
      })
  })
)

const testLayer = (memory: FakeMemory, model: Layer.Layer<LanguageModelFactory>, config: Partial<AppConfigShape> = {}) =>
  AgentRunnerLive.pipe(
    Layer.provideMerge(SelfReview.layer),
    Layer.provideMerge(Layer.mergeAll(toolbox, CoreMemory.layer, Approvals.layer, LibraryStore.layer)),
    Layer.provideMerge(Layer.mergeAll(ProviderRegistry.layer, SkillStore.layer, memory.layer)),
    Layer.provideMerge(RunEvents.layer),
    Layer.provideMerge(Layer.mergeAll(BotRepo.layer, ConversationRepo.layer, Settings.layer)),
    Layer.provideMerge(model),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(AppConfig.layerTest({
      dataDir: mkdtempSync(join(tmpdir(), "weaver-core-memory-")),
      memory: Option.some({ url: "http://memory.test/mcp", token: "", project: "weaver-test" }),
      browserCommand: [],
      coreMemoryCondenseAt: threshold,
      reviewSkillInterval: 0,
      reviewMemoryInterval: 0,
      ...config
    }))
  )

const makeBot = (name = "Ada", tools: ReadonlyArray<"memory" | "skills"> = ["memory"]) =>
  Effect.gen(function*() {
    yield* (yield* ProviderRegistry).update("deepseek", { apiKey: "sk-test" })
    return yield* (yield* BotRepo).create({ name, tools: [...tools], approvalMode: "auto" })
  })

/** Lets background fibers run until the condition holds; works with the test clock too. */
const waitUntil = (condition: Effect.Effect<boolean>) =>
  Effect.gen(function*() {
    for (let i = 0; i < 1000; i++) {
      if (yield* condition) return
      yield* Effect.yieldNow
    }
    throw new Error("Timed out waiting")
  })

const idle = Effect.gen(function*() {
  const core = yield* CoreMemory
  yield* waitUntil(Effect.map(core.isCondensing, (busy) => !busy))
})

const writes = (memory: FakeMemory) => memory.calls.filter((call) => call.name !== "read_note")

describe("condensing helpers", () => {
  it("accepts a compact rewrite and strips a code fence around it", () => {
    expect(condenseRejection(original, condensed)).toBeUndefined()
    expect(condensedBody("```markdown\n# Core Memory\n- [fact] x (via A)\n```")).toBe("# Core Memory\n- [fact] x (via A)")
    expect(backupTitle(new Date(2026, 9, 11, 19, 5))).toBe("Core Memory before condensing 2026-10-11 19:05")
  })

  it("keeps hand-written lines that appear twice once", () => {
    const twice = `${original}\nAlways answer in English.`
    expect(condenseRejection(twice, condensed)).toBeUndefined()
  })
})

const rejections: ReadonlyArray<readonly [label: string, answer: string, reason: string]> = [
  ["the model returns nothing", "  ", "returned nothing"],
  ["the rewrite isn't shorter", `${original}\n- [fact] One more (via Ada)`, "isn't shorter"],
  ["the rewrite drops most facts", "# Core Memory\nAlways answer in English.\n- [fact] Bun (via Ada)", "dropped too much"],
  ["a hand-written line changed", condensed.replace("Always answer in English.", "Always reply in English."), "written by hand"],
  [
    "no fact lines are left",
    `# Core Memory\nAlways answer in English.\n${"The user builds several projects with Bun and Effect. ".repeat(5)}`,
    "no \"- [category] fact\" lines"
  ],
  ["it adds a secret", `${condensed}\n- [fact] api_key: "sk1234567890abcdefghijklmnop" (via Ada)`, "hardcoded_secret"]
]

describe("CoreMemory.condense", () => {
  it.live("backs up the old text, replaces only what was condensed and refreshes the cached note", () => {
    const memory = fakeMemory({ [corePermalink]: original })
    const model = condenseModel(() => Effect.succeed(`\`\`\`\n${condensed}\n\`\`\``))
    return Effect.gen(function*() {
      const bot = yield* makeBot()
      const core = yield* CoreMemory
      expect(yield* core.text("weaver-test")).toBe(original)

      const result = yield* core.condense(bot)
      expect(result).toMatchObject({ before: original.length, after: condensed.length })
      expect(result!.backup).toMatch(/^Core Memory before condensing \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
      expect(model.prompts[0]).toContain("Always answer in English.")
      expect(model.prompts[0]).toContain(`under ${threshold * 0.6} characters`)

      expect(memory.calls.map((call) => call.name)).toEqual(["read_note", "read_note", "read_note", "write_note", "edit_note"])
      expect(memory.calls.every((call) => call.args.project === "weaver-test")).toBe(true)
      expect(memory.calls[3]!.args).toMatchObject({ title: result!.backup, directory: historyFolder, content: original })
      expect(memory.calls[4]!.args).toMatchObject({ identifier: corePermalink, operation: "find_replace", find_text: original })
      const backups = [...memory.notes].filter(([permalink]) => permalink.startsWith(`${historyFolder}/`))
      expect(backups.map(([, content]) => content)).toEqual([original])
      expect(memory.notes.get(corePermalink)).toBe(condensed)

      expect(yield* core.text("weaver-test")).toBe(condensed)
    }).pipe(Effect.provide(testLayer(memory, model.layer)))
  })

  for (const [label, answer, reason] of rejections) {
    it.live(`keeps Core Memory as it was when ${label}`, () => {
      const memory = fakeMemory({ [corePermalink]: original })
      const model = condenseModel(() => Effect.succeed(answer))
      return Effect.gen(function*() {
        const error = yield* Effect.flip((yield* CoreMemory).condense(yield* makeBot()))
        expect(error.message).toContain(reason)
        expect(writes(memory)).toEqual([])
        expect(memory.notes.get(corePermalink)).toBe(original)
      }).pipe(Effect.provide(testLayer(memory, model.layer)))
    })
  }

  it.live("keeps Core Memory as it was when the model fails", () => {
    const memory = fakeMemory({ [corePermalink]: original })
    const model = condenseModel(() => Effect.fail(modelError))
    return Effect.gen(function*() {
      const error = yield* Effect.flip((yield* CoreMemory).condense(yield* makeBot()))
      expect(error.message).toContain("the model failed")
      expect(writes(memory)).toEqual([])
    }).pipe(Effect.provide(testLayer(memory, model.layer)))
  })

  it.live("doesn't replace anything when the backup can't be saved", () => {
    const memory = fakeMemory({ [corePermalink]: original })
    memory.hooks.before = (call) =>
      call.name === "write_note" ? Effect.fail(new McpError({ server: "Memory", message: "disk full" })) : Effect.void
    const model = condenseModel(() => Effect.succeed(condensed))
    return Effect.gen(function*() {
      const error = yield* Effect.flip((yield* CoreMemory).condense(yield* makeBot()))
      expect(error.message).toContain("disk full")
      expect(memory.calls.map((call) => call.name)).not.toContain("edit_note")
      expect(memory.notes.get(corePermalink)).toBe(original)
    }).pipe(Effect.provide(testLayer(memory, model.layer)))
  })

  it.live("keeps facts a bot appended while condensing, after the condensed text", () => {
    const appended = "- [fact] The user moved to Bandung (via Cy)"
    const memory = fakeMemory({ [corePermalink]: original })
    const model = condenseModel(() =>
      Effect.sync(() => {
        memory.notes.set(corePermalink, `${memory.notes.get(corePermalink)}\n${appended}`)
        return condensed
      })
    )
    return Effect.gen(function*() {
      const result = yield* (yield* CoreMemory).condense(yield* makeBot())
      expect(memory.notes.get(corePermalink)).toBe(`${condensed}\n${appended}`)
      expect(result).toMatchObject({ before: original.length + appended.length + 1, after: condensed.length + appended.length + 1 })
      const backup = [...memory.notes].find(([permalink]) => permalink.startsWith(`${historyFolder}/`))
      expect(backup?.[1]).toBe(`${original}\n${appended}`)
    }).pipe(Effect.provide(testLayer(memory, model.layer)))
  })

  it.live("leaves Core Memory for the next attempt when it was rewritten while condensing", () => {
    const edited = original.replace("Always answer in English.", "Always answer in Indonesian.")
    const memory = fakeMemory({ [corePermalink]: original })
    const model = condenseModel(() =>
      Effect.sync(() => {
        memory.notes.set(corePermalink, edited)
        return condensed
      })
    )
    return Effect.gen(function*() {
      const error = yield* Effect.flip((yield* CoreMemory).condense(yield* makeBot()))
      expect(error.message).toContain("changed while being condensed")
      expect(writes(memory)).toEqual([])
      expect(memory.notes.get(corePermalink)).toBe(edited)
    }).pipe(Effect.provide(testLayer(memory, model.layer)))
  })
})

describe("CoreMemory in the background", () => {
  it.live("condenses after a reply once Core Memory is over the threshold, without holding up the reply", () => {
    const memory = fakeMemory({ [corePermalink]: condensed })
    const gate = Deferred.makeUnsafe<void>()
    const model = condenseModel(() => Effect.as(Deferred.await(gate), condensed))
    return Effect.gen(function*() {
      const bot = yield* makeBot()
      const conversation = yield* (yield* ConversationRepo).create({ title: "", botIds: [bot.id] })
      const core = yield* CoreMemory

      yield* sendAndWait(conversation.id, "Hello")
      yield* idle
      expect(model.prompts).toHaveLength(0)

      memory.notes.set(corePermalink, original)
      yield* core.invalidate("weaver-test")
      const events = yield* sendAndWait(conversation.id, "Hello again")
      expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "done" })
      yield* waitUntil(Effect.sync(() => model.prompts.length === 1))
      expect(yield* core.isCondensing).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* idle
      expect(memory.notes.get(corePermalink)).toBe(condensed)
    }).pipe(Effect.provide(testLayer(memory, model.layer)))
  })

  it.live("a failing model doesn't affect the reply", () => {
    const memory = fakeMemory({ [corePermalink]: original })
    const model = condenseModel(() => Effect.fail(modelError))
    return Effect.gen(function*() {
      const bot = yield* makeBot()
      const conversation = yield* (yield* ConversationRepo).create({ title: "", botIds: [bot.id] })
      const events = yield* sendAndWait(conversation.id, "Hello")
      yield* idle
      expect(model.prompts).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "done" })
      const done = events.find((event) => event.type === "message-done")
      expect(done).toMatchObject({ message: { status: "done", parts: [{ type: "text", text: "Hi" }] } })
      expect(memory.notes.get(corePermalink)).toBe(original)
    }).pipe(Effect.provide(testLayer(memory, model.layer)))
  })

  it.live("stays off at a threshold of 0, and for bots without memory", () => {
    const memory = fakeMemory({ [corePermalink]: original })
    const model = condenseModel(() => Effect.succeed(condensed))
    return Effect.gen(function*() {
      const core = yield* CoreMemory
      yield* core.condenseIfDue(yield* makeBot("Ada"))
      yield* idle
      const other = memory.calls.length
      yield* core.condenseIfDue(yield* makeBot("Bo", ["skills"]))
      yield* idle
      expect(memory.calls).toHaveLength(other)
      expect(model.prompts).toHaveLength(0)
    }).pipe(Effect.provide(testLayer(memory, model.layer, { coreMemoryCondenseAt: 0 })))
  })

  it.effect("condenses one at a time for all bots, then waits out the cooldown", () => {
    const memory = fakeMemory({ [corePermalink]: original })
    const gate = Deferred.makeUnsafe<void>()
    // Rejected (not shorter), so Core Memory stays long and stays due.
    const model = condenseModel(() => Effect.as(Deferred.await(gate), `${original}\n- [fact] x (via Ada)`))
    return Effect.gen(function*() {
      const core = yield* CoreMemory
      const ada = yield* makeBot("Ada")
      const bo = yield* makeBot("Bo")

      yield* core.condenseIfDue(ada)
      yield* waitUntil(Effect.sync(() => model.prompts.length === 1))
      yield* core.condenseIfDue(bo)
      yield* core.condenseIfDue(ada)
      yield* Deferred.succeed(gate, undefined)
      yield* idle
      expect(model.prompts).toHaveLength(1)

      yield* TestClock.adjust(Duration.minutes(29))
      yield* core.condenseIfDue(bo)
      yield* idle
      expect(model.prompts).toHaveLength(1)

      yield* TestClock.adjust(Duration.minutes(1))
      yield* core.condenseIfDue(bo)
      yield* waitUntil(Effect.sync(() => model.prompts.length === 2))
      yield* idle
      expect(memory.notes.get(corePermalink)).toBe(original)
    }).pipe(Effect.provide(testLayer(memory, model.layer)))
  })

  it.live("deleting the bot that started a condense stops it; deleting another bot doesn't", () => {
    const memory = fakeMemory({ [corePermalink]: original })
    const model = condenseModel(() => Effect.never)
    return Effect.gen(function*() {
      const core = yield* CoreMemory
      const selfReview = yield* SelfReview
      const ada = yield* makeBot("Ada")
      const bo = yield* makeBot("Bo")
      yield* selfReview.afterReply({
        bot: ada,
        conversationId: "c",
        messageId: "m",
        toolSteps: 0,
        usedSkillManage: false,
        usedMemoryWrite: false
      })
      yield* waitUntil(Effect.sync(() => model.prompts.length === 1))

      yield* selfReview.cancel(bo.id)
      expect(yield* core.isCondensing).toBe(true)
      yield* selfReview.cancel(ada.id)
      expect(yield* core.isCondensing).toBe(false)
      expect(writes(memory)).toEqual([])
      expect(memory.notes.get(corePermalink)).toBe(original)
    }).pipe(Effect.provide(testLayer(memory, model.layer)))
  })
})
