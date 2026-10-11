import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Layer } from "effect"
import { AppConfig } from "../../src/config/Config.ts"
import { ConversationRepo } from "../../src/features/conversations/ConversationRepo.ts"
import type { AgentTool } from "../../src/tools/AgentTool.ts"
import { browserTools } from "../../src/tools/builtin/Browser.ts"
import { Camofox } from "../../src/tools/builtin/Camofox.ts"
import { webTools } from "../../src/tools/builtin/Web.ts"
import {
  callTool,
  createBot,
  createConversation,
  say,
  scriptedModel,
  sendAndWait,
  tempDir,
  testLayer,
  withProviderKey
} from "../support/layers.ts"

/**
 * Real searches and pages through a running camofox-browser. Opt in with `WEAVER_E2E_CAMOFOX=1`; it uses
 * `WEAVER_CAMOFOX_URL` (default http://127.0.0.1:9377) and `WEAVER_CAMOFOX_KEY`. `WEAVER_E2E_DUCKDUCKGO=1`
 * runs the direct DuckDuckGo search, which some networks block.
 */
const enabled = process.env.WEAVER_E2E_CAMOFOX === "1"
const duckDuckGo = process.env.WEAVER_E2E_DUCKDUCKGO === "1"
const camofoxUrl = (process.env.WEAVER_CAMOFOX_URL ?? "http://127.0.0.1:9377").replace(/\/+$/, "")
const camofoxKey = process.env.WEAVER_CAMOFOX_KEY ?? ""
const timeout = 180_000
const config = { browser: "camofox", camofoxUrl, camofoxKey } as const

const camofoxLayer = Camofox.layer.pipe(Layer.provide(AppConfig.layerTest(config)))

const toolsFor = (conversationId: string) =>
  Effect.gen(function*() {
    const camofox = yield* Camofox
    const owner = { botId: "e2e-bot", conversationId }
    const tools: ReadonlyArray<AgentTool> = [
      ...webTools({ camofox, owner }),
      ...browserTools({ camofox, owner, workspace: tempDir() })
    ]
    return (name: string) => tools.find((tool) => tool.name === name)!
  })

describe.skipIf(!enabled)(`camofox at ${camofoxUrl}`, () => {
  it.live("is up", () =>
    Effect.gen(function*() {
      expect(yield* (yield* Camofox).available).toBe(true)
    }).pipe(Effect.provide(camofoxLayer)))

  it.live("searches Google through the browser", () =>
    Effect.gen(function*() {
      const conversationId = `search-${Date.now()}`
      const output = yield* (yield* toolsFor(conversationId))("web_search").run({ query: "Effect TypeScript library", limit: 5 })
      expect(output).toMatch(/^Results for "Effect TypeScript library" from (Google|DuckDuckGo|Bing), via the browser/)
      expect(output).toMatch(/\n1\. .+\n {3}https?:\/\//)
      yield* (yield* Camofox).closeConversation(conversationId, ["e2e-bot"])
    }).pipe(Effect.provide(camofoxLayer)), timeout)

  it.live("reads example.com in the browser", () =>
    Effect.gen(function*() {
      const conversationId = `fetch-${Date.now()}`
      const output = yield* (yield* toolsFor(conversationId))("web_fetch").run({ url: "https://example.com" })
      expect(output).toContain("(read in the browser)")
      expect(output).toContain("This domain is for use in documentation examples")
      yield* (yield* Camofox).closeConversation(conversationId, ["e2e-bot"])
    }).pipe(Effect.provide(camofoxLayer)), timeout)

  it.live("navigates, reads the page, and clicks a link", () =>
    Effect.gen(function*() {
      const tool = yield* toolsFor(`browse-${Date.now()}`)
      const opened = yield* tool("browser_navigate").run({ url: "https://example.com" })
      expect(opened).toContain("URL: https://example.com/")
      const snapshot = yield* tool("browser_snapshot").run({})
      const ref = /- link "[^"]+" \[(e\d+)\]/.exec(snapshot)?.[1]
      expect(ref).toBeDefined()
      const clicked = yield* tool("browser_click").run({ ref: ref! })
      expect(clicked).toMatch(/URL: https:\/\/(www\.)?iana\.org\//)
      expect(yield* tool("browser_back").run({})).toContain("URL: https://example.com/")
      expect(yield* tool("browser_close").run({})).toBe("Closed the browser tab.")
    }).pipe(Effect.provide(camofoxLayer)), timeout)

  it.live("refuses to open private addresses", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip((yield* toolsFor(`ssrf-${Date.now()}`))("browser_navigate").run({ url: "http://169.254.169.254/" }))
      expect(failure.message).toContain("private or local address")
    }).pipe(Effect.provide(camofoxLayer)))

  it.live("lets a bot search and read during a reply", () => {
    const model = scriptedModel((call) =>
      call.index === 0
        ? callTool("web_search", { query: "example domain iana", limit: 3 })
        : call.index === 1
        ? callTool("web_fetch", { url: "https://example.com" })
        : say("Done.")
    )
    return Effect.gen(function*() {
      yield* withProviderKey
      const bot = yield* createBot({ name: "Ada", tools: ["web", "browser"] })
      const conversation = yield* createConversation([bot.id])
      yield* sendAndWait(conversation.id, "Look up example.com", Duration.millis(timeout))
      const reply = (yield* (yield* ConversationRepo).messages(conversation.id)).at(-1)!
      const results = reply.parts.flatMap((part) => (part.type === "tool-result" ? [part] : []))
      expect(results.map((result) => result.isFailure)).toEqual([false, false])
      expect(model.calls[1]!.prompt).toMatch(/Results for \\+"example domain iana\\+" from \w+, via the browser/)
      expect(model.calls[2]!.prompt).toContain("This domain is for use in documentation examples")
      yield* (yield* Camofox).removeBot(bot.id)
    }).pipe(Effect.provide(testLayer(model.layer, undefined, config)))
  }, timeout)
})

describe.skipIf(!duckDuckGo)("DuckDuckGo", () => {
  it.live("searches directly when there's no browser", () =>
    Effect.gen(function*() {
      const [search] = webTools({ camofox: undefined, owner: { botId: "e2e-bot", conversationId: "ddg" } })
      const output = yield* search!.run({ query: "Effect TypeScript library", limit: 3 })
      expect(output).toMatch(/^Results for "Effect TypeScript library" from DuckDuckGo, searched directly/)
      expect(output).toMatch(/\n1\. .+\n {3}https?:\/\//)
    }), 60_000)
})
