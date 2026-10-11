import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AppConfig } from "../../src/config/Config.ts"
import type { AgentTool } from "../../src/tools/AgentTool.ts"
import { Camofox } from "../../src/tools/builtin/Camofox.ts"
import { htmlToText, pageOf } from "../../src/tools/builtin/HtmlText.ts"
import { isPrivateAddress, publicUrl, type UrlGuard } from "../../src/tools/builtin/UrlGuard.ts"
import { maxFetchBytes, pageChars, parseDuckDuckGo, parseSearchSnapshot, unwrapResultUrl, webTools } from "../../src/tools/builtin/Web.ts"

const fixtures = join(import.meta.dirname, "..", "support", "fixtures")
const duckDuckGoHtml = readFileSync(join(fixtures, "duckduckgo.html"), "utf8")
const googleSnapshot = readFileSync(join(fixtures, "google-snapshot.txt"), "utf8")

const tool = (tools: ReadonlyArray<AgentTool>, name: string) => tools.find((t) => t.name === name)!

const fakeLookup = (table: Record<string, ReadonlyArray<string>>) => async (hostname: string) => {
  const found = table[hostname]
  if (found === undefined) throw new Error("ENOTFOUND")
  return found
}

describe("URL guard", () => {
  it("tells private, loopback, link-local and reserved addresses from public ones", () => {
    for (const ip of ["127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.100.1.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "ff02::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it.effect("refuses local and private targets, including through DNS", () =>
    Effect.gen(function*() {
      const lookup = fakeLookup({ "evil.test": ["93.184.215.14", "10.0.0.5"], "example.com": ["93.184.215.14"], "rebind.test": ["::1"] })
      for (const url of ["http://localhost:7700/v1/health", "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]:7700/", "http://[::ffff:127.0.0.1]/", "http://metadata.google.internal/", "http://evil.test/", "http://rebind.test/", "http://intranet/"]) {
        const failure = yield* Effect.flip(publicUrl(url, lookup))
        expect(failure.message, url).toContain("public internet")
      }
      expect((yield* Effect.flip(publicUrl("file:///etc/passwd", lookup))).message).toContain("Only http and https")
      expect((yield* Effect.flip(publicUrl("http://nowhere.test/", lookup))).message).toContain("Couldn't find nowhere.test")
      expect((yield* publicUrl("example.com/page", lookup)).href).toBe("https://example.com/page")
    }))
})

describe("HTML to text", () => {
  it("keeps headings, paragraphs, lists and numbered links, and drops scripts, styles, navigation and hidden parts", () => {
    const page = htmlToText(
      `<!doctype html><html><head><title>Docs &amp; Guides</title><style>body{color:red}</style>
      <script>var secret = "<p>not shown</p>";</script></head>
      <body><nav><a href="/home">Home</a></nav>
      <main><h1>Getting started</h1>
      <p>Install it with <code>bun add effect</code>. See the <a href="/docs/intro?x=1&amp;y=2">introduction</a>.</p>
      <ul><li>Fast</li><li>Typed<ul><li>Really</li></ul></li></ul>
      <div hidden>Hidden text</div><p aria-hidden="true">Also hidden</p>
      <p>Caf&eacute; &#8212; &#x2603; &nbsp;done</p>
      <a href="javascript:void(0)">Ignored</a> <a href="https://example.org/">Example</a> <a href="/docs/intro?x=1&y=2">again</a>
      </main><footer>Footer</footer></body></html>`,
      "https://example.com/start"
    )
    expect(page.title).toBe("Docs & Guides")
    expect(page.text).toContain("# Getting started")
    expect(page.text).toContain("Install it with bun add effect. See the introduction [1].")
    expect(page.text).toContain("- Fast\n- Typed\n  - Really")
    expect(page.text).toContain("Example [2] again [1]")
    expect(page.text).toContain("Ignored")
    expect(page.links).toEqual(["https://example.com/docs/intro?x=1&y=2", "https://example.org/"])
    for (const hidden of ["Home", "Hidden text", "Also hidden", "Footer", "secret", "color:red", "not shown"]) {
      expect(page.text).not.toContain(hidden)
    }
    expect(page.text).toContain("&eacute; — ☃")
  })

  it("pages long text at line breaks", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n")
    const first = pageOf(text, 0, 1000)
    expect(first.body.endsWith("\n")).toBe(true)
    expect(first.next).toBe(first.body.length)
    const second = pageOf(text, first.next!, 1000)
    expect(second.body.startsWith("line ")).toBe(true)
    expect(pageOf(text, text.length - 10, 1000).next).toBeUndefined()
  })
})

describe("search result parsing", () => {
  it("reads DuckDuckGo's HTML results without ads, unwrapping redirect links", () => {
    const results = parseDuckDuckGo(duckDuckGoHtml)
    expect(results.map((result) => result.url)).toEqual([
      "https://effect.website/",
      "https://github.com/Effect-TS/effect",
      "https://github.com/mikearnaldi/effect-ts"
    ])
    expect(results[0]).toMatchObject({ title: "Effect | Production Grade TypeScript" })
    expect(results[0]!.snippet).toContain("Effect prevents the real performance killers")
    expect(JSON.stringify(results)).not.toContain("udemy")
  })

  it("reads Google results from a browser snapshot, skipping Google's own links", () => {
    const results = parseSearchSnapshot(googleSnapshot)
    expect(results.map((result) => result.url)).toEqual([
      "https://effect.website/",
      "https://github.com/Effect-TS/effect",
      "https://dev.to/effect/introduction-to-effect"
    ])
    expect(results[0]!.snippet).toContain("powerful TypeScript library")
    expect(results[2]!.title).toBe("Introduction to Effect \"the missing standard library\"")
  })

  it("reads Bing results from a browser snapshot, with their summaries rather than cite lines", () => {
    const results = parseSearchSnapshot(readFileSync(join(fixtures, "bing-snapshot.txt"), "utf8"))
    expect(results.map((result) => result.url)).toEqual([
      "https://vocaberry.com/grammar/affect-vs-effect/",
      "https://dictionary.cambridge.org/dictionary/english/effect",
      "https://effect.website/",
      "https://www.merriam-webster.com/dictionary/effect"
    ])
    expect(results[2]).toMatchObject({ title: "Effect | Production Grade TypeScript" })
    expect(results[2]!.snippet).toMatch(/^Effect covers a broader scope/)
    expect(results[3]!.snippet).toMatch(/^3 days ago · The meaning of EFFECT/)
  })

  it("unwraps tracking links from DuckDuckGo, Google and Bing", () => {
    expect(unwrapResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x")).toBe("https://example.com/a")
    expect(unwrapResultUrl("https://www.google.com/url?q=https://example.com/b&sa=U")).toBe("https://example.com/b")
    const bing = `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from("https://example.com/c").toString("base64url")}&ntb=1`
    expect(unwrapResultUrl(bing)).toBe("https://example.com/c")
    expect(unwrapResultUrl("javascript:alert(1)")).toBeUndefined()
  })
})

/** A small web server standing in for public sites. */
const startSite = () => {
  const hits: Array<string> = []
  const longText = Array.from({ length: 600 }, (_, i) => `<p>Paragraph ${i} of the long article, with some words to read.</p>`).join("")
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      hits.push(`${request.method} ${url.pathname}`)
      switch (url.pathname) {
        case "/article":
          return new Response(
            `<html><head><title>An article</title></head><body><article><h1>Hello</h1><p>Read <a href="/more">more</a>.</p></article></body></html>`,
            { headers: { "content-type": "text/html; charset=utf-8" } }
          )
        case "/long":
          return new Response(`<html><body>${longText}</body></html>`, { headers: { "content-type": "text/html" } })
        case "/redirect-ok":
          return new Response(null, { status: 302, headers: { location: "/article" } })
        case "/redirect-private":
          return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
        case "/big":
          return new Response("a".repeat(maxFetchBytes + 500_000), { headers: { "content-type": "text/plain" } })
        case "/file.pdf":
          return new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } })
        case "/ddg":
          if (request.method !== "POST") return new Response("anomaly-modal", { status: 202 })
          return new Response(duckDuckGoHtml, { headers: { "content-type": "text/html" } })
        case "/ddg-captcha":
          return new Response(`<div class="anomaly-modal__modal">challenge</div>`, { status: 202, headers: { "content-type": "text/html" } })
      }
      return new Response("<h1>Not found</h1><p>Nothing here.</p>", { status: 404, headers: { "content-type": "text/html" } })
    }
  })
  const origin = `http://127.0.0.1:${server.port}`
  const guard: UrlGuard = (url) => url.startsWith(origin) ? Effect.succeed(new URL(url)) : publicUrl(url)
  return { origin, guard, hits, close: () => server.stop(true) }
}

describe("web tools over plain HTTP", () => {
  let site: ReturnType<typeof startSite>
  beforeAll(() => {
    site = startSite()
  })
  afterAll(() => site.close())

  const tools = (overrides: { duckDuckGoUrl?: string } = {}) =>
    webTools({ camofox: undefined, owner: { botId: "bot", conversationId: "chat" }, guard: site.guard, ...overrides })

  it("are web_search and web_fetch, and never need approval", () => {
    const list = tools()
    expect(list.map((t) => t.name)).toEqual(["web_search", "web_fetch"])
    expect(list.every((t) => !t.needsApproval)).toBe(true)
    expect(tool(list, "web_search").title({ query: "effect ts" })).toBe("Searched \"effect ts\"")
    expect(tool(list, "web_fetch").title({ url: "https://example.com/page" })).toBe("Read example.com")
    expect(tool(list, "web_search").activity).toBe("Searching the web")
    expect(tool(list, "web_fetch").activity).toBe("Reading a page")
  })

  it.effect("reads an HTML page as text with its links listed", () =>
    Effect.gen(function*() {
      const output = yield* tool(tools(), "web_fetch").run({ url: `${site.origin}/redirect-ok` })
      expect(output).toContain("# An article")
      expect(output).toContain(`URL: ${site.origin}/article (fetched directly)`)
      expect(output).toContain("# Hello")
      expect(output).toContain("Read more [1].")
      expect(output).toContain(`Links:\n[1] ${site.origin}/more`)
    }))

  it.effect("pages through a long page without fetching it again", () =>
    Effect.gen(function*() {
      const fetch = tool(tools(), "web_fetch")
      const before = site.hits.filter((hit) => hit === "GET /long").length
      const first = yield* fetch.run({ url: `${site.origin}/long` })
      const offset = Number(first.match(/offset=(\d+)/)?.[1])
      expect(offset).toBeGreaterThan(pageChars * 0.7)
      expect(first).toContain("Paragraph 0 of")
      expect(first.length).toBeLessThan(12_000)
      const second = yield* fetch.run({ url: `${site.origin}/long`, offset })
      expect(second).toContain(`Showing characters ${offset}–`)
      expect(second).not.toContain("Paragraph 0 of")
      expect(site.hits.filter((hit) => hit === "GET /long").length - before).toBe(1)
    }))

  it.effect("refuses private targets, directly and through redirects", () =>
    Effect.gen(function*() {
      const fetch = tool(webTools({ camofox: undefined, owner: { botId: "bot", conversationId: "chat" } }), "web_fetch")
      for (const url of ["http://localhost:7700/v1/bots", "http://127.0.0.1:9377/health", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"]) {
        expect((yield* Effect.flip(fetch.run({ url }))).message, url).toContain("public internet")
      }
      const redirected = yield* Effect.flip(tool(tools(), "web_fetch").run({ url: `${site.origin}/redirect-private` }))
      expect(redirected.message).toContain("169.254.169.254")
      expect(redirected.message).toContain("public internet")
    }))

  it.effect("reads at most 2 MB, explains non-text files and reports HTTP errors", () =>
    Effect.gen(function*() {
      const fetch = tool(tools(), "web_fetch")
      expect(yield* fetch.run({ url: `${site.origin}/big` })).toContain("only the first 2.0 MB was read")
      expect(yield* fetch.run({ url: `${site.origin}/file.pdf` })).toContain("is a application/pdf file")
      const missing = yield* Effect.flip(fetch.run({ url: `${site.origin}/missing` }))
      expect(missing.message).toContain("answered HTTP 404")
      expect(missing.message).toContain("Nothing here.")
    }))

  it.effect("searches DuckDuckGo directly when there's no browser", () =>
    Effect.gen(function*() {
      const output = yield* tool(tools({ duckDuckGoUrl: `${site.origin}/ddg` }), "web_search").run({ query: "effect-ts", limit: 2 })
      expect(output).toContain("from DuckDuckGo, searched directly")
      expect(output).toContain("1. Effect | Production Grade TypeScript\n   https://effect.website/")
      expect(output).toContain("2. GitHub - Effect-TS/effect")
      expect(output).not.toContain("3.")
      const captcha = yield* Effect.flip(tool(tools({ duckDuckGoUrl: `${site.origin}/ddg-captcha` }), "web_search").run({ query: "x" }))
      expect(captcha.message).toContain("captcha")
    }))

  it.live("falls back to DuckDuckGo when the browser service is down, and says so", () =>
    Effect.gen(function*() {
      const camofox = yield* Camofox
      const search = tool(
        webTools({ camofox, owner: { botId: "bot", conversationId: "chat" }, guard: site.guard, duckDuckGoUrl: `${site.origin}/ddg` }),
        "web_search"
      )
      const output = yield* search.run({ query: "effect-ts", site: "github.com" })
      expect(output).toContain("Results for \"effect-ts site:github.com\"")
      expect(output).toContain("DuckDuckGo, searched directly (the browser couldn't search: the browser service isn't running)")
      expect(site.hits).toContain("POST /ddg")
    }).pipe(Effect.provide(Camofox.layer.pipe(Layer.provide(AppConfig.layerTest({ browser: "camofox", camofoxUrl: "http://127.0.0.1:9" }))))))
})
