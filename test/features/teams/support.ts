import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { Layer, Option } from "effect"
import { HttpRouter } from "effect/http"
import { AppConfig, type AppConfigShape } from "../../../src/config/Config.ts"
import type { BotCreate } from "../../../src/features/bots/Bot.ts"
import { BotRepo } from "../../../src/features/bots/BotRepo.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { IntegrationOAuth } from "../../../src/features/integrations/IntegrationOAuth.ts"
import { IntegrationRepo } from "../../../src/features/integrations/IntegrationRepo.ts"
import { LibraryStore } from "../../../src/features/learning/library/LibraryStore.ts"
import { SkillSources } from "../../../src/features/learning/library/SkillSources.ts"
import { CoreMemory } from "../../../src/features/learning/memory/CoreMemory.ts"
import { SelfReview } from "../../../src/features/learning/review/SelfReview.ts"
import { SkillStore } from "../../../src/features/learning/skills/SkillStore.ts"
import { KnowledgeBase } from "../../../src/features/memory/KnowledgeBase.ts"
import { Settings } from "../../../src/features/profile/Settings.ts"
import { type LanguageModelFactory, ProviderRegistry } from "../../../src/features/providers/ProviderRegistry.ts"
import { AgentRunnerLive } from "../../../src/features/runs/AgentRunnerLive.ts"
import { Approvals } from "../../../src/features/runs/Approvals.ts"
import type { RunEvent } from "../../../src/features/runs/Events.ts"
import { RunEvents } from "../../../src/features/runs/RunEvents.ts"
import { Toolbox } from "../../../src/features/runs/Toolbox.ts"
import { TeamRepo } from "../../../src/features/teams/TeamRepo.ts"
import { TeamSessions } from "../../../src/features/teams/TeamSessions.ts"
import { AppRoutes } from "../../../src/main.ts"
import { DatabaseTest } from "../../../src/platform/db/Database.ts"
import { BotUsers } from "../../../src/platform/os/BotUsers.ts"
import { Camofox } from "../../../src/tools/builtin/Camofox.ts"
import type { FakeMemory } from "../../support/fakeMemory.ts"
import { type ModelCall, type Script, scriptedModel, tempDir, testLayer } from "../../support/layers.ts"

export const nameOf = (call: ModelCall) => /Your name is ([^.]+)\./.exec(call.prompt)?.[1]
export const afterTool = (call: ModelCall) => call.prompt.includes("\"role\":\"tool\"")
export const systemOf = (call: ModelCall) => (JSON.parse(call.prompt) as Array<{ content: unknown }>)[0]!.content as string
export const userTurns = (call: ModelCall) =>
  (JSON.parse(call.prompt) as Array<{ role: string; content: unknown }>)
    .filter((turn) => turn.role === "user")
    .map((turn) =>
      Array.isArray(turn.content)
        ? turn.content.map((part: { text?: string }) => part.text ?? "").join("")
        : String(turn.content)
    )
export const lastUserTurn = (call: ModelCall) => userTurns(call).at(-1) ?? ""

/** Which kind of reply a model call is for, from its system prompt. */
export const kindOf = (call: ModelCall): "private" | "session" | "lead" | "member" | "chat" => {
  const system = systemOf(call)
  if (system.includes("## Team session")) return system.includes("a subgroup of") ? "lead" : "session"
  if (system.includes("You manage team")) return "private"
  if (system.includes("## Your team\nYou're ")) return "member"
  return "chat"
}

/** Replies with each step in turn, repeating the last one. */
export const steps = <A>(list: ReadonlyArray<A>) => {
  let index = 0
  return () => list[Math.min(index++, list.length - 1)]!
}

/** Every service with Basic Memory behind a fake hub. */
const memoryServices = (memory: FakeMemory, model: Layer.Layer<LanguageModelFactory>, config: Partial<AppConfigShape>) =>
  TeamSessions.layer.pipe(
    Layer.provideMerge(AgentRunnerLive),
    Layer.provideMerge(SelfReview.layer),
    Layer.provideMerge(Toolbox.layer),
    Layer.provideMerge(KnowledgeBase.layer),
    Layer.provideMerge(CoreMemory.layer),
    Layer.provideMerge(Layer.mergeAll(LibraryStore.layer, SkillSources.layer)),
    Layer.provideMerge(Layer.mergeAll(SkillStore.layer, IntegrationOAuth.layer)),
    Layer.provideMerge(Layer.mergeAll(memory.layer, RunEvents.layer, Approvals.layer, BotUsers.layer, Camofox.layer)),
    Layer.provideMerge(ProviderRegistry.layer),
    Layer.provideMerge(Layer.mergeAll(BotRepo.layer, ConversationRepo.layer, IntegrationRepo.layer, Settings.layer, TeamRepo.layer)),
    Layer.provideMerge(model),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(AppConfig.layerTest({
      dataDir: tempDir(),
      memory: Option.some({ url: "http://memory.test/mcp", token: "", project: "weaver-test" }),
      browserCommand: [],
      reviewSkillInterval: 0,
      reviewMemoryInterval: 0,
      coreMemoryCondenseAt: 0,
      ...config
    }))
  )

// deno-lint-ignore no-explicit-any
type Json = any

export interface Client {
  readonly request: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Json }>
  readonly model: ReturnType<typeof scriptedModel>
  /** Every event from `/v1/events` since the client was made. */
  readonly events: Array<RunEvent>
  readonly dispose: () => Promise<void>
}

/** The whole HTTP API in process with a scripted model, listening to `/v1/events`. */
export const makeClient = async (
  script: Script,
  options: { readonly config?: Partial<AppConfigShape>; readonly memory?: FakeMemory } = {}
): Promise<Client> => {
  const model = scriptedModel(script)
  const config = { reviewSkillInterval: 0, reviewMemoryInterval: 0, ...options.config }
  const services = options.memory === undefined
    ? testLayer(model.layer, tempDir(), config)
    : memoryServices(options.memory, model.layer, config)
  const web = HttpRouter.toWebHandler(
    AppRoutes.pipe(Layer.provide(services), Layer.provide(BunHttpServer.layerHttpServices)),
    { disableLogger: true }
  )
  const headers = (body: unknown) => ({
    authorization: "Bearer test-token",
    ...(body !== undefined ? { "content-type": "application/json" } : {})
  })
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await web.handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: headers(body),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    )
    const text = await response.text()
    return { status: response.status, json: text.length > 0 ? JSON.parse(text) : undefined }
  }

  const events: Array<RunEvent> = []
  const response = await web.handler(new Request("http://localhost/v1/events", { headers: headers(undefined) }))
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = block.split("\n").find((line) => line.startsWith("data: "))
        if (data !== undefined) events.push(JSON.parse(data.slice(6)) as RunEvent)
      }
    }
  })()
  await new Promise((resolve) => setTimeout(resolve, 20))

  return {
    request,
    model,
    events,
    dispose: async () => {
      await reader.cancel().catch(() => undefined)
      await pump
      await web.dispose()
    }
  }
}

export const waitFor = async <A>(check: () => Promise<A | undefined | false> | A | undefined | false, millis = 8_000) => {
  const deadline = Date.now() + millis
  for (;;) {
    const result = await check()
    if (result !== undefined && result !== false) return result
    if (Date.now() > deadline) throw new Error("Timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A message as one line: text, reports as `kind:title:text`, tool calls and results by name. */
export const show = (message: { parts: Array<Record<string, unknown>> }): string =>
  message.parts.map((part) => {
    switch (part.type) {
      case "text":
        return String(part.text)
      case "report":
        return `${String(part.kind)}:${String(part.title)}:${String(part.text)}`
      case "tool-call":
        return `call:${String(part.name)}`
      case "tool-result":
        return `result:${String(part.name)}`
      default:
        return ""
    }
  }).filter((line) => line.length > 0).join(" | ")

export const bot = (client: Client, name: string, extra: Partial<BotCreate> = {}) =>
  client.request("POST", "/v1/bots", { name, tools: [], approvalMode: "auto", ...extra }).then((response) => response.json)

/** Max manages DELTA with Ann (Android) and Wes (web). */
export const delta = async (client: Client, ann: Partial<BotCreate> = {}, max: Partial<BotCreate> = {}) => {
  await client.request("PUT", "/v1/providers/deepseek", { apiKey: "sk-test" })
  const maxBot = await bot(client, "Max", max)
  const annBot = await bot(client, "Ann", ann)
  const wesBot = await bot(client, "Wes")
  const team = (await client.request("POST", "/v1/teams", {
    name: "DELTA",
    purpose: "Mobile and web apps",
    managerBotId: maxBot.id,
    members: [{ botId: annBot.id, role: "Android developer" }, { botId: wesBot.id, role: "Web developer" }]
  })).json
  return { max: maxBot, ann: annBot, wes: wesBot, team }
}

export const messagesOf = async (client: Client, conversationId: string): Promise<Array<Json>> =>
  (await client.request("GET", `/v1/conversations/${conversationId}/messages`)).json

export const teamOf = async (client: Client, teamId: string): Promise<Json> =>
  (await client.request("GET", `/v1/teams/${teamId}`)).json

/** Sends in the private chat and waits for the manager's reply there to finish. */
export const instruct = async (client: Client, team: Json, text: string) => {
  const sent = await client.request("POST", `/v1/conversations/${team.privateConversationId}/messages`, { text })
  if (sent.status !== 200) throw new Error(`Send failed: ${JSON.stringify(sent.json)}`)
  return waitFor(async () => {
    const reply = (await messagesOf(client, team.privateConversationId)).find((m) =>
      m.role === "assistant" && m.seq > sent.json.message.seq && !m.parts.some((part: Json) => part.type === "report")
    )
    return reply !== undefined && reply.status !== "streaming" ? reply : undefined
  })
}

export const reportsIn = async (client: Client, conversationId: string, kind: string) =>
  (await messagesOf(client, conversationId)).flatMap((m) => m.parts.filter((p: Json) => p.type === "report" && p.kind === kind))
