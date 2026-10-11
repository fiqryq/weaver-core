import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AppConfig } from "../../src/config/Config.ts"
import type { AgentTool } from "../../src/tools/AgentTool.ts"
import { browserTools } from "../../src/tools/builtin/Browser.ts"
import { Camofox } from "../../src/tools/builtin/Camofox.ts"
import { publicUrl, type UrlGuard } from "../../src/tools/builtin/UrlGuard.ts"
import { webTools } from "../../src/tools/builtin/Web.ts"
import { type FakeCamofox, type FakeCamofoxOptions, startFakeCamofox } from "../support/fixtures/fakeCamofox.ts"
import { tempDir } from "../support/layers.ts"

const googleSnapshot = readFileSync(join(import.meta.dirname, "..", "support", "fixtures", "google-snapshot.txt"), "utf8")
const bingSnapshot = readFileSync(join(import.meta.dirname, "..", "support", "fixtures", "bing-snapshot.txt"), "utf8")
const owner = { botId: "bot-1", conversationId: "chat-1" }

/** Sites the tests open; the fake camofox never fetches them, so DNS isn't involved. */
const guard: UrlGuard = (url) => /^https:\/\/(example\.com|news\.example)(\/|$)/.test(url) ? Effect.succeed(new URL(url)) : publicUrl(url)

let fake: FakeCamofox | undefined
afterEach(() => {
  fake?.close()
  fake = undefined
})

const withCamofox = (options: FakeCamofoxOptions = {}, key = options.accessKey ?? "") => {
  fake = startFakeCamofox(options)
  return Camofox.layer.pipe(Layer.provide(AppConfig.layerTest({ browser: "camofox", camofoxUrl: fake.url, camofoxKey: key })))
}

const toolsOf = (workspace = tempDir()) =>
  Effect.gen(function*() {
    const tools: ReadonlyArray<AgentTool> = browserTools({ camofox: yield* Camofox, owner, workspace, guard })
    return (name: string) => tools.find((tool) => tool.name === name)!
  })

const paths = () => fake!.requests.map((request) => `${request.method} ${request.path}`)

describe("camofox browser tools", () => {
  it.live("open a tab per bot and conversation, reuse it, and replace it when it's gone", () =>
    Effect.gen(function*() {
      const tool = yield* toolsOf()
      const first = yield* tool("browser_navigate").run({ url: "https://example.com/" })
      expect(first).toContain("URL: https://example.com/")
      expect(first).toContain("- link \"Next page\" [e1]:")
      expect(fake!.requests.find((request) => request.path === "/tabs")!.body).toEqual({
        userId: "bot-1",
        sessionKey: "chat-1",
        url: "https://example.com/"
      })

      yield* tool("browser_navigate").run({ url: "https://news.example/" })
      expect(paths().filter((path) => path === "POST /tabs")).toHaveLength(1)
      expect(fake!.requests.at(-2)).toMatchObject({ path: "/tabs/tab-1/navigate", body: { userId: "bot-1", url: "https://news.example/" } })

      fake!.dropTab("tab-1")
      const gone = yield* Effect.flip(tool("browser_click").run({ ref: "e1" }))
      expect(gone.message).toContain("tab was closed")
      const reopened = yield* tool("browser_navigate").run({ url: "https://example.com/" })
      expect(reopened).toContain("URL: https://example.com/")
      expect([...fake!.tabs.keys()]).toEqual(["tab-2"])

      fake!.dropTab("tab-2")
      yield* tool("browser_navigate").run({ url: "https://news.example/" })
      expect(paths().filter((path) => path === "POST /tabs")).toHaveLength(3)
      expect(fake!.tabs.get("tab-3")!.url).toBe("https://news.example/")
    }).pipe(Effect.provide(withCamofox())))

  it.live("click, type, press, scroll and go back, returning the page each time", () =>
    Effect.gen(function*() {
      const tool = yield* toolsOf()
      expect((yield* Effect.flip(tool("browser_click").run({ ref: "e1" }))).message).toContain("No page is open")
      yield* tool("browser_navigate").run({ url: "https://example.com/" })

      const clicked = yield* tool("browser_click").run({ ref: "e1" })
      expect(clicked).toContain("Clicked e1.\nURL: https://example.com/next")
      expect(fake!.requests.find((request) => request.path.endsWith("/click"))!.body).toEqual({ userId: "bot-1", ref: "e1" })
      expect((yield* Effect.flip(tool("browser_click").run({ ref: "e99" }))).message).toContain("Unknown ref: e99")

      const typed = yield* tool("browser_type").run({ ref: "e2", text: "cats", submit: true })
      expect(typed).toContain("Typed into e2 and pressed Enter.")
      expect(typed).toContain("URL: https://example.com/next?q=cats")
      expect(fake!.requests.find((request) => request.path.endsWith("/type"))!.body).toEqual({
        userId: "bot-1",
        ref: "e2",
        text: "cats",
        submit: true
      })

      expect(yield* tool("browser_press").run({ key: "Escape" })).toContain("Pressed Escape.")
      expect(yield* tool("browser_scroll").run({ direction: "down", amount: 800 })).toContain("Scrolled down.")
      expect(fake!.requests.find((request) => request.path.endsWith("/scroll"))!.body).toEqual({ userId: "bot-1", direction: "down", amount: 800 })
      expect(yield* tool("browser_back").run({})).toContain("URL: https://example.com/next\n")

      expect(yield* tool("browser_links").run({})).toContain("[e1] Next page — https://example.com/next/next")
      expect(yield* tool("browser_close").run({})).toBe("Closed the browser tab.")
      expect(paths().at(-1)).toBe("DELETE /tabs/tab-1")
      expect(fake!.requests.at(-1)!.query).toEqual({ userId: "bot-1" })
    }).pipe(Effect.provide(withCamofox())))

  it.live("search sites through camofox's macros", () =>
    Effect.gen(function*() {
      const tool = yield* toolsOf()
      const output = yield* tool("browser_navigate").run({ search: { engine: "youtube", query: "lofi beats" } })
      expect(output).toContain("URL: https://www.youtube.com/search?q=lofi%20beats")
      expect(fake!.requests.find((request) => request.path.endsWith("/navigate"))!.body).toEqual({
        userId: "bot-1",
        sessionKey: "chat-1",
        macro: "@youtube_search",
        query: "lofi beats"
      })
      expect(tool("browser_navigate").title({ search: { engine: "youtube", query: "lofi beats" } })).toBe("Searched youtube for \"lofi beats\"")
      expect(tool("browser_navigate").title({ url: "https://example.com/a" })).toBe("Opened example.com")
      expect(tool("browser_click").title({ ref: "e12" })).toBe("Clicked e12")
    }).pipe(Effect.provide(withCamofox())))

  it.live("page through long snapshots, past camofox's own 80K window", () => {
    const line = (i: number) => `- text: line ${String(i).padStart(6, "0")} ${"lorem ipsum ".repeat(6)}`
    const short = Array.from({ length: 200 }, (_, i) => line(i)).join("\n")
    const huge = Array.from({ length: 3000 }, (_, i) => line(i)).join("\n")
    return Effect.gen(function*() {
      const tool = yield* toolsOf()
      const first = yield* tool("browser_navigate").run({ url: "https://example.com/" })
      const next = Number(first.match(/offset=(\d+)/)![1])
      expect(first).toContain(line(0))
      const second = yield* tool("browser_snapshot").run({ offset: next })
      expect(second).toContain(`URL: https://example.com/\n\n${short.slice(next, next + 40)}`)

      yield* tool("browser_navigate").run({ url: "https://news.example/" })
      const deep = 150_000
      const page = yield* tool("browser_snapshot").run({ offset: deep })
      expect(page).toContain(`\n\n${huge.slice(deep, deep + 60)}`)
      expect(page).toContain(`Showing characters ${deep}–`)
      expect(page).toContain(`of ${huge.length}`)
      expect(page.length).toBeLessThan(12_000)
    }).pipe(Effect.provide(withCamofox({ pages: { "https://example.com/": short, "https://news.example/": huge } })))
  })

  it.live("refuse private pages, before opening them and when a page lands on one", () =>
    Effect.gen(function*() {
      const tool = yield* toolsOf()
      for (const url of ["http://localhost:7700/", "http://127.0.0.1:9377/health", "http://169.254.169.254/", "http://[::1]/"]) {
        expect((yield* Effect.flip(tool("browser_navigate").run({ url }))).message, url).toContain("public internet")
      }
      expect(fake!.requests.filter((request) => request.method !== "GET")).toEqual([])

      yield* tool("browser_navigate").run({ url: "https://example.com/" })
      const landed = yield* Effect.flip(tool("browser_click").run({ ref: "e1" }))
      expect(landed.message).toContain("10.0.0.8")
      expect(landed.message).toContain("The tab was closed.")
      expect(paths().at(-1)).toBe("DELETE /tabs/tab-1")
    }).pipe(Effect.provide(withCamofox({ pages: { "https://example.com/": "- link \"Router\" [e1]:\n  - /url: http://10.0.0.8/admin" } }))))

  it.live("save screenshots in the workspace instead of returning the image", () => {
    const workspace = tempDir()
    return Effect.gen(function*() {
      const tool = yield* toolsOf(workspace)
      yield* tool("browser_navigate").run({ url: "https://example.com/" })
      const output = yield* tool("browser_screenshot").run({})
      expect(output).toMatch(/^Saved a screenshot \(\d+ bytes\) to screenshots\/screenshot-.+\.png in your workspace\.$/)
      expect(output.length).toBeLessThan(200)
      const [file] = readdirSync(join(workspace, "screenshots"))
      expect(readFileSync(join(workspace, "screenshots", file!)).subarray(1, 4).toString()).toBe("PNG")
    }).pipe(Effect.provide(withCamofox()))
  })

  it.live("send the access key as a bearer token", () =>
    Effect.gen(function*() {
      const tool = yield* toolsOf()
      yield* tool("browser_navigate").run({ url: "https://example.com/" })
      expect(fake!.requests.filter((request) => request.path !== "/health").every((request) => request.authorization === "Bearer s3cret"))
        .toBe(true)
    }).pipe(Effect.provide(withCamofox({ accessKey: "s3cret" }))))

  it.live("explain a wrong access key", () =>
    Effect.gen(function*() {
      const tool = yield* toolsOf()
      const failure = yield* Effect.flip(tool("browser_navigate").run({ url: "https://example.com/" }))
      expect(failure.message).toContain("WEAVER_CAMOFOX_KEY")
    }).pipe(Effect.provide(withCamofox({ accessKey: "s3cret" }, "wrong"))))

  it.live("explain how to start the browser service when it isn't running", () =>
    Effect.gen(function*() {
      const camofox = yield* Camofox
      expect(yield* camofox.available).toBe(false)
      const tools = browserTools({ camofox, owner, workspace: tempDir(), guard })
      const failure = yield* Effect.flip(tools.find((tool) => tool.name === "browser_navigate")!.run({ url: "https://example.com/" }))
      expect(failure.message).toBe(
        "The browser service isn't running at http://127.0.0.1:9. Start it with `npx @askjo/camofox-browser` or rerun the setup script."
      )
    }).pipe(Effect.provide(Camofox.layer.pipe(Layer.provide(AppConfig.layerTest({ browser: "camofox", camofoxUrl: "http://127.0.0.1:9" }))))))
})

describe("camofox web tools", () => {
  it.live("search Google through the browser in a tab of their own", () =>
    Effect.gen(function*() {
      const camofox = yield* Camofox
      const tools = webTools({ camofox, owner, guard })
      const output = yield* tools[0]!.run({ query: "effect-ts typescript" })
      expect(output).toContain("Results for \"effect-ts typescript\" from Google, via the browser:")
      expect(output).toContain("1. Effect – The best way to build robust apps in TypeScript\n   https://effect.website/\n   Effect is a powerful")
      expect(output).toContain("3. Introduction to Effect \"the missing standard library\"\n   https://dev.to/effect/introduction-to-effect")
      expect(output).not.toContain("google.com")
      expect(fake!.requests.find((request) => request.path.endsWith("/navigate"))!.body).toMatchObject({
        macro: "@google_search",
        query: "effect-ts typescript"
      })

      yield* browserTools({ camofox, owner, workspace: tempDir(), guard })[0]!.run({ url: "https://example.com/" })
      expect(fake!.tabs.size).toBe(2)
      expect([...fake!.tabs.values()].every((tab) => tab.sessionKey === "chat-1" && tab.userId === "bot-1")).toBe(true)
    }).pipe(Effect.provide(withCamofox({ googleSnapshot }))))

  it.live("wait for camofox's fallback engine to show its results", () =>
    Effect.gen(function*() {
      const output = yield* webTools({ camofox: yield* Camofox, owner, guard })[0]!.run({ query: "Effect TypeScript library" })
      expect(output).toContain("Results for \"Effect TypeScript library\" from Bing, via the browser:")
      expect(output).toContain("3. Effect | Production Grade TypeScript\n   https://effect.website/\n   Effect covers a broader scope")
      expect(paths().filter((path) => path.endsWith("/wait"))).toHaveLength(1)
    }).pipe(Effect.provide(withCamofox({ bingSnapshot }))))

  it.live("fall back to DuckDuckGo when Google blocks the browser", () => {
    const ddg = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(readFileSync(join(import.meta.dirname, "..", "support", "fixtures", "duckduckgo.html"), "utf8"), {
          headers: { "content-type": "text/html" }
        })
    })
    return Effect.gen(function*() {
      const camofox = yield* Camofox
      const tools = webTools({ camofox, owner, guard, duckDuckGoUrl: `http://127.0.0.1:${ddg.port}/html/` })
      const output = yield* tools[0]!.run({ query: "effect-ts" })
      expect(output).toContain("DuckDuckGo, searched directly (the browser couldn't search: Google blocked the search.)")
      expect(output).toContain("https://effect.website/")
    }).pipe(Effect.provide(withCamofox({ googleBlocked: true })), Effect.ensuring(Effect.promise(() => ddg.stop(true))))
  })

  it.live("read pages in the browser and page through them", () => {
    const article = Array.from({ length: 400 }, (_, i) => `- paragraph: Sentence number ${i} of the story.`).join("\n")
    return Effect.gen(function*() {
      const camofox = yield* Camofox
      const fetch = webTools({ camofox, owner, guard })[1]!
      const first = yield* fetch.run({ url: "https://news.example/story" })
      expect(first).toContain("URL: https://news.example/story (read in the browser)")
      expect(first).toContain("Sentence number 0 of")
      const offset = Number(first.match(/web_fetch with offset=(\d+)/)![1])
      const second = yield* fetch.run({ url: "https://news.example/story", offset })
      expect(second).toContain(`Showing characters ${offset}–`)
      expect(paths().filter((path) => path.endsWith("/navigate") || path === "POST /tabs")).toHaveLength(1)
      expect((yield* Effect.flip(fetch.run({ url: "http://192.168.0.1/" }))).message).toContain("public internet")
    }).pipe(Effect.provide(withCamofox({ pages: { "https://news.example/story": article } })))
  })
})

describe("camofox sessions", () => {
  it.live("close a conversation's tabs and end a deleted bot's session", () =>
    Effect.gen(function*() {
      const camofox = yield* Camofox
      yield* browserTools({ camofox, owner, workspace: tempDir(), guard })[0]!.run({ url: "https://example.com/" })
      yield* camofox.closeConversation("chat-1", ["bot-2"])
      expect(fake!.tabs.size).toBe(0)
      const groups = fake!.requests.filter((request) => request.path === "/tabs/group/chat-1")
      expect(groups.map((request) => request.query.userId).sort()).toEqual(["bot-1", "bot-2"])

      yield* camofox.removeBot("bot-1")
      expect(paths().slice(-2)).toEqual(["DELETE /sessions/bot-1", "DELETE /sessions/bot-1/storage_state"])
    }).pipe(Effect.provide(withCamofox())))
})
