import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Fiber, Layer, Option, Stream } from "effect"
import { LanguageModel, type Response } from "effect/ai"
import { AppConfig } from "../../src/config/Config.ts"
import type { BotCreate } from "../../src/features/bots/Bot.ts"
import { BotRepo } from "../../src/features/bots/BotRepo.ts"
import { ConversationRepo } from "../../src/features/conversations/ConversationRepo.ts"
import { LanguageModelFactory, ProviderRegistry } from "../../src/features/providers/ProviderRegistry.ts"
import { AgentRunner } from "../../src/features/runs/AgentRunner.ts"
import type { RunEvent } from "../../src/features/runs/Events.ts"
import { RunEvents } from "../../src/features/runs/RunEvents.ts"
import { AppServices } from "../../src/main.ts"
import { DatabaseTest } from "../../src/platform/db/Database.ts"

export interface ModelCall {
  /** Index of this call among every call the model received. */
  readonly index: number
  readonly prompt: string
  readonly tools: ReadonlyArray<string>
}

/** One model round: given the call, the parts the provider streams back. */
export type Script = (call: ModelCall) => ReadonlyArray<Response.StreamPartEncoded>

const finish: Response.StreamPartEncoded = {
  type: "finish",
  reason: "stop",
  usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }
}

export const say = (text: string): ReadonlyArray<Response.StreamPartEncoded> => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  finish
]

export const callTool = (name: string, params: unknown, id = `call-${name}`): ReadonlyArray<Response.StreamPartEncoded> => [
  { type: "tool-call", id, name, params },
  { ...finish, reason: "tool-calls" }
]

/** A model that replies from a script and records every prompt and tool list it was given. */
export const scriptedModel = (script: Script) => {
  const calls: Array<ModelCall> = []
  const layer = Layer.succeed(
    LanguageModelFactory,
    LanguageModelFactory.of({
      make: () =>
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.die("generateText isn't used"),
            streamText: (options) =>
              Stream.suspend(() => {
                const call: ModelCall = {
                  index: calls.length,
                  prompt: JSON.stringify(options.prompt.content),
                  tools: options.tools.map((tool) => tool.name)
                }
                calls.push(call)
                return Stream.fromIterable(script(call))
              })
          })
        )
    })
  )
  return { calls, layer }
}

export const tempDir = () => mkdtempSync(join(tmpdir(), "weaver-test-"))

/** Every service the API uses, on an in-memory database, with the given model and data directory. */
export const testLayer = (model: Layer.Layer<LanguageModelFactory>, dataDir = tempDir()) =>
  AppServices.pipe(
    Layer.provideMerge(model),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(AppConfig.layerTest({ dataDir, memory: Option.none(), browserCommand: [] }))
  )

/** Saves an API key for the default provider so runs can reach the (scripted) model. */
export const withProviderKey = Effect.gen(function*() {
  const providers = yield* ProviderRegistry
  yield* providers.update("deepseek", { apiKey: "sk-test" })
})

export const createBot = (input: BotCreate) =>
  Effect.gen(function*() {
    const bots = yield* BotRepo
    return yield* bots.create({ tools: [], approvalMode: "auto", ...input })
  })

export const createConversation = (botIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const conversations = yield* ConversationRepo
    return yield* conversations.create({ title: "", botIds: [...botIds] })
  })

/** Collects a conversation's events until the predicate matches; start it before triggering the run. */
export const collectUntil = (conversationId: string, until: (event: RunEvent) => boolean) =>
  Effect.gen(function*() {
    const events = yield* RunEvents
    const fiber = yield* events.subscribe(conversationId).pipe(
      Stream.takeUntil(until),
      Stream.runCollect,
      Effect.timeout(Duration.seconds(10)),
      Effect.forkChild
    )
    // Give the subscription a moment to attach before anything is published.
    yield* Effect.sleep(Duration.millis(20))
    return fiber
  })

/** Posts a user message and starts the bots, like `POST /v1/conversations/:id/messages`. */
export const send = (conversationId: string, text: string) =>
  Effect.gen(function*() {
    const conversations = yield* ConversationRepo
    const runner = yield* AgentRunner
    yield* conversations.insertMessage({ conversationId, role: "user", parts: [{ type: "text", text }] })
    return yield* runner.start(conversationId)
  })

/** Sends a message and waits for the whole run to finish, returning its events. */
export const sendAndWait = (conversationId: string, text: string) =>
  Effect.gen(function*() {
    const fiber = yield* collectUntil(conversationId, (event) => event.type === "run-finished")
    yield* send(conversationId, text)
    return yield* Fiber.join(fiber)
  })
