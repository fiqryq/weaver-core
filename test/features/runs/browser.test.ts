import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BunHttpServer } from "@effect/platform-bun"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import type { AppConfigShape } from "../../../src/config/Config.ts"
import { defaultTools } from "../../../src/features/bots/Bot.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { Profile } from "../../../src/features/profile/Profile.ts"
import { systemPrompt } from "../../../src/features/runs/PromptBuilder.ts"
import { Toolbox } from "../../../src/features/runs/Toolbox.ts"
import { AppRoutes } from "../../../src/main.ts"
import { type FakeCamofox, startFakeCamofox } from "../../support/fixtures/fakeCamofox.ts"
import {
  callTool,
  createBot,
  createConversation,
  say,
  scriptedModel,
  sendAndWait,
  testLayer,
  withProviderKey
} from "../../support/layers.ts"

const fixtures = join(import.meta.dirname, "..", "..", "support", "fixtures")
const googleSnapshot = readFileSync(join(fixtures, "google-snapshot.txt"), "utf8")
const echoMcp = join(fixtures, "echo-mcp.ts")
const down = "http://127.0.0.1:9"

const browserToolNames = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_back",
  "browser_links",
  "browser_screenshot",
  "browser_close"
]

let fake: FakeCamofox | undefined
let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  fake?.close()
  fake = undefined
  await dispose?.()
  dispose = undefined
})

const camofoxConfig = (options: Parameters<typeof startFakeCamofox>[0] = {}): Partial<AppConfigShape> => {
  fake = startFakeCamofox(options)
  return { browser: "camofox", camofoxUrl: fake.url }
}

const toolsFor = (tools: Parameters<typeof createBot>[0]["tools"], approvalMode: "auto" | "ask" | "off" = "auto") =>
  Effect.gen(function*() {
    const bot = yield* createBot({ name: "Ada", tools, approvalMode })
    return yield* (yield* Toolbox).forBot(bot, { conversationId: "chat" })
  })

const names = (botTools: { readonly tools: ReadonlyArray<{ readonly name: string }> }) => botTools.tools.map((tool) => tool.name)

const layerWith = (config: Partial<AppConfigShape>) => testLayer(scriptedModel(() => say("ok")).layer, undefined, config)

describe("browser and web tools in the toolbox", () => {
  it.live("gives camofox browser tools for `browser` and web tools for `web`, without approval", () =>
    Effect.gen(function*() {
      expect(names(yield* toolsFor(["web"]))).toEqual(["web_search", "web_fetch"])
      expect(names(yield* toolsFor(["browser"]))).toEqual(browserToolNames)
      const asking = yield* toolsFor(["browser", "web"], "ask")
      expect(names(asking)).toEqual(["web_search", "web_fetch", ...browserToolNames])
      expect(asking.tools.every((tool) => !tool.needsApproval)).toBe(true)
      expect(names(yield* toolsFor(["browser", "web"], "off"))).toHaveLength(12)
      expect(asking.unavailable).toEqual([])
      expect(fake!.requests.map((request) => request.path)).toEqual(["/health"])
    }).pipe(Effect.provide(layerWith(camofoxConfig()))))

  it.live("lists the browser as unavailable when camofox is down, and keeps the web tools", () =>
    Effect.gen(function*() {
      const botTools = yield* toolsFor(["browser", "web"])
      expect(names(botTools)).toEqual(["web_search", "web_fetch"])
      expect(botTools.unavailable).toEqual([`Browser (the browser service isn't running at ${down})`])
    }).pipe(Effect.provide(layerWith({ browser: "camofox", camofoxUrl: down }))))

  it.live("has no browser when it's off, but still the web tools", () =>
    Effect.gen(function*() {
      const botTools = yield* toolsFor(["browser", "web"])
      expect(names(botTools)).toEqual(["web_search", "web_fetch"])
      expect(botTools.unavailable).toEqual([])
    }).pipe(Effect.provide(layerWith({ browser: "off", browserCommand: [process.execPath, echoMcp] }))))

  it.live("keeps the Playwright MCP browser in playwright mode", () =>
    Effect.gen(function*() {
      const botTools = yield* toolsFor(["browser"])
      expect(names(botTools)).toEqual(["echo", "whoami_env", "fail", "pid", "hang", "throw"])
      expect(botTools.tools[0]!.activity).toBe("Using the browser")
      expect(botTools.tools[0]!.title({ text: "hi" })).toBe("Browser: echo")
      expect(names(yield* toolsFor(["web"]))).toEqual(["web_search", "web_fetch"])
    }).pipe(Effect.provide(layerWith({ browser: "playwright", browserCommand: [process.execPath, echoMcp] }))), 20_000)

  it("gives new bots the web tools by default", () => {
    expect(defaultTools).toEqual(["shell", "files", "browser", "web", "memory", "skills"])
  })

  it("describes web lookups and the watchable browser in the prompt", () => {
    const base = {
      bot: { systemPrompt: "Be helpful.", name: "Ada" } as never,
      profile: new Profile({ displayName: "Sam", email: "", timezone: "UTC" }),
      otherBots: [],
      display: ":1",
      now: new Date(0)
    }
    const tools = (toolNames: ReadonlyArray<string>) => ({
      tools: toolNames.map((name) => ({ name }) as never),
      workspace: "/w",
      memoryEnabled: false,
      memoryProject: undefined,
      coreMemory: undefined,
      recall: [],
      skills: [],
      integrations: [],
      unavailable: []
    })
    const both = systemPrompt({ ...base, tools: tools(["web_search", "web_fetch", "browser_navigate"]) })
    expect(both).toContain("search the web and read pages (web_search, web_fetch)")
    expect(both).toContain("the user can watch it on the desktop (DISPLAY=:1)")
    expect(both).toContain("Prefer web_search and web_fetch for looking things up")
    const webOnly = systemPrompt({ ...base, tools: tools(["web_search", "web_fetch"]) })
    expect(webOnly).toContain("web_search")
    expect(webOnly).not.toContain("DISPLAY")
  })
})

describe("browser over the API", () => {
  const makeClient = (config: Partial<AppConfigShape>, script = scriptedModel(() => say("ok"))) => {
    const web = HttpRouter.toWebHandler(
      AppRoutes.pipe(Layer.provide(testLayer(script.layer, undefined, config)), Layer.provide(BunHttpServer.layerHttpServices)),
      { disableLogger: true }
    )
    dispose = web.dispose
    return async (method: string, path: string, body?: unknown) => {
      const response = await web.handler(
        new Request(`http://localhost${path}`, {
          method,
          headers: { authorization: "Bearer test-token", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        })
      )
      const text = await response.text()
      return { status: response.status, json: text.length > 0 ? JSON.parse(text) : undefined }
    }
  }

  it("reports the browser engine and the web tools in health", async () => {
    expect((await makeClient(camofoxConfig())("GET", "/v1/health")).json).toMatchObject({
      browser: true,
      browserEngine: "camofox",
      web: true
    })
    await dispose?.()
    expect((await makeClient({ browser: "camofox", camofoxUrl: down })("GET", "/v1/health")).json).toMatchObject({
      browser: false,
      browserEngine: "camofox",
      web: true
    })
    await dispose?.()
    expect((await makeClient({ browser: "playwright", browserCommand: ["npx", "@playwright/mcp"] })("GET", "/v1/health")).json)
      .toMatchObject({ browser: true, browserEngine: "playwright", web: true })
    await dispose?.()
    expect((await makeClient({ browser: "off" })("GET", "/v1/health")).json).toMatchObject({
      browser: false,
      browserEngine: "none",
      web: true
    })
  })

  it("ends a deleted bot's browser session and closes cleared or deleted conversations' tabs", async () => {
    const request = makeClient(camofoxConfig())
    const bot = (await request("POST", "/v1/bots", { name: "Ada" })).json
    expect(bot.tools).toContain("web")
    const first = (await request("POST", "/v1/conversations", { botIds: [bot.id] })).json
    const second = (await request("POST", "/v1/conversations", { botIds: [bot.id] })).json

    expect((await request("DELETE", `/v1/conversations/${first.id}/messages`)).status).toBe(204)
    expect((await request("DELETE", `/v1/conversations/${second.id}`)).status).toBe(204)
    const groups = fake!.requests.filter((r) => r.path.startsWith("/tabs/group/")).map((r) => `${r.path}?${r.query.userId}`)
    expect(groups).toEqual([`/tabs/group/${first.id}?${bot.id}`, `/tabs/group/${second.id}?${bot.id}`])

    expect((await request("DELETE", `/v1/bots/${bot.id}`)).status).toBe(204)
    expect(fake!.requests.slice(-2).map((r) => `${r.method} ${r.path}`)).toEqual([
      `DELETE /sessions/${bot.id}`,
      `DELETE /sessions/${bot.id}/storage_state`
    ])
  })

  it("still deletes bots and conversations when camofox is down", async () => {
    const request = makeClient({ browser: "camofox", camofoxUrl: down })
    const bot = (await request("POST", "/v1/bots", { name: "Ada" })).json
    const conversation = (await request("POST", "/v1/conversations", { botIds: [bot.id] })).json
    expect((await request("DELETE", `/v1/conversations/${conversation.id}`)).status).toBe(204)
    expect((await request("DELETE", `/v1/bots/${bot.id}`)).status).toBe(204)
  })
})

describe("a reply that searches the web", () => {
  it.live("runs web_search through camofox and feeds the results back to the model", () => {
    const model = scriptedModel((call) =>
      call.index === 0 ? callTool("web_search", { query: "effect-ts typescript", limit: 2 }) : say("Effect is a TypeScript library.")
    )
    return Effect.gen(function*() {
      yield* withProviderKey
      const bot = yield* createBot({ name: "Ada", tools: ["web", "browser"] })
      const conversation = yield* createConversation([bot.id])
      yield* sendAndWait(conversation.id, "What is Effect?")

      expect(model.calls[0]!.tools).toContain("web_search")
      expect(model.calls[0]!.prompt).toContain("web_search, web_fetch")
      expect(model.calls[1]!.prompt).toContain("from Google, via the browser")
      expect(model.calls[1]!.prompt).toContain("https://effect.website/")
      const message = (yield* (yield* ConversationRepo).messages(conversation.id)).at(-1)!
      expect(message.parts[0]).toMatchObject({ type: "tool-call", name: "web_search", title: "Searched \"effect-ts typescript\"" })
      expect(message.parts[1]).toMatchObject({ type: "tool-result", isFailure: false })
      expect(fake!.tabs.size).toBe(1)
      expect([...fake!.tabs.values()][0]).toMatchObject({ userId: bot.id, sessionKey: conversation.id })
    }).pipe(Effect.provide(testLayer(model.layer, undefined, camofoxConfig({ googleSnapshot }))))
  })
})
