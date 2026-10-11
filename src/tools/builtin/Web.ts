import { Duration, Effect, Schema } from "effect"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"
import { type Camofox, type SnapshotResponse, snapshotWindow, type TabOwner } from "./Camofox.ts"
import { formatBytes } from "./Files.ts"
import { htmlToText, inlineText, pageOf } from "./HtmlText.ts"
import { publicUrl, type UrlGuard } from "./UrlGuard.ts"

export const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
export const duckDuckGoUrl = "https://html.duckduckgo.com/html/"
export const maxFetchBytes = 2 * 1024 * 1024
/** Characters of a page per call; with its link list it stays under the runner's tool output limit. */
export const pageChars = 8_000
const linkListChars = 2_500
const defaultResults = 5
const maxResults = 10
const fetchTimeout = Duration.seconds(20)
const maxRedirects = 5

export interface SearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

export interface FetchedPage {
  readonly url: string
  readonly status: number
  readonly contentType: string
  readonly body: string
  /** The body was longer than the size cap and was cut. */
  readonly cut: boolean
  readonly bytes: number
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const decodeBody = (bytes: Uint8Array, contentType: string): string => {
  const sniffed = new TextDecoder().decode(bytes.subarray(0, 2048))
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? sniffed.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
  try {
    return new TextDecoder((charset ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes)
  } catch {
    return new TextDecoder("utf-8").decode(bytes)
  }
}

/** Reads at most `limit` bytes of a response body. */
const readCapped = async (response: Response, limit: number): Promise<{ bytes: Uint8Array; cut: boolean }> => {
  if (response.body === null) return { bytes: new Uint8Array(), cut: false }
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  let cut = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const room = limit - length
    if (value.length > room) {
      chunks.push(value.subarray(0, room))
      length += room
      cut = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
    length += value.length
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, cut }
}

/**
 * Fetches a page over plain HTTP. With a guard, the URL and every redirect are checked first, so a
 * public page can't redirect into the server's network.
 */
export const fetchPage = (
  raw: string,
  options: {
    readonly guard?: UrlGuard
    readonly method?: "GET" | "POST"
    readonly form?: Record<string, string>
    readonly headers?: Record<string, string>
    readonly maxBytes?: number
    readonly timeout?: Duration.Duration
  } = {}
): Effect.Effect<FetchedPage, ToolFailure> => {
  const check = (url: string) =>
    options.guard !== undefined
      ? options.guard(url)
      : Effect.try({ try: () => new URL(url), catch: () => new ToolFailure({ message: `${url} isn't a valid URL.` }) })
  const timeout = options.timeout ?? fetchTimeout
  return Effect.gen(function*() {
    let url = yield* check(raw)
    let method = options.method ?? "GET"
    for (let hop = 0;; hop++) {
      const target = url
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(target, {
            method,
            redirect: "manual",
            signal,
            headers: {
              "user-agent": userAgent,
              accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
              "accept-language": "en-US,en;q=0.9",
              ...(method === "POST" && options.form !== undefined
                ? { "content-type": "application/x-www-form-urlencoded" }
                : {}),
              ...options.headers
            },
            ...(method === "POST" && options.form !== undefined ? { body: new URLSearchParams(options.form).toString() } : {})
          }),
        catch: (cause) => new ToolFailure({ message: `Couldn't reach ${target.host}: ${errorText(cause)}` })
      })
      const location = response.headers.get("location")
      if (response.status >= 300 && response.status < 400 && location !== null) {
        yield* Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve())
        if (hop >= maxRedirects) return yield* new ToolFailure({ message: `${raw} redirected too many times.` })
        url = yield* check(new URL(location, target).href)
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET"
        }
        continue
      }
      const contentType = response.headers.get("content-type") ?? ""
      const { bytes, cut } = yield* Effect.tryPromise({
        try: () => readCapped(response, options.maxBytes ?? maxFetchBytes),
        catch: (cause) => new ToolFailure({ message: `Couldn't read ${target.host}: ${errorText(cause)}` })
      })
      return {
        url: target.href,
        status: response.status,
        contentType,
        body: decodeBody(bytes, contentType),
        cut,
        bytes: bytes.length
      } satisfies FetchedPage
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(new ToolFailure({ message: `${raw} didn't answer within ${Math.round(Duration.toSeconds(timeout))} seconds.` }))
    })
  )
}

/** Unwraps search engines' click-tracking links to the page they point to. */
export const unwrapResultUrl = (raw: string): string | undefined => {
  let url: URL
  try {
    url = new URL(raw.startsWith("//") ? `https:${raw}` : raw)
  } catch {
    return undefined
  }
  const host = url.hostname.replace(/^www\./, "")
  if (host === "duckduckgo.com" && url.pathname === "/l/") return unwrapResultUrl(url.searchParams.get("uddg") ?? "")
  if (/^google\.[a-z.]+$/.test(host) && url.pathname === "/url") {
    return unwrapResultUrl(url.searchParams.get("q") ?? url.searchParams.get("url") ?? "")
  }
  if (host === "bing.com" && url.pathname === "/ck/a") {
    const encoded = url.searchParams.get("u")
    if (encoded === null || !encoded.startsWith("a1")) return undefined
    try {
      return unwrapResultUrl(Buffer.from(encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
    } catch {
      return undefined
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return url.href
}

const searchEngineHost = /(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com|duckduckgo\.com|bing\.com|microsoft\.com|msn\.com)$/

const isResultUrl = (url: string): boolean => !searchEngineHost.test(new URL(url).hostname)

/** Organic results from DuckDuckGo's HTML page, without ads. */
export const parseDuckDuckGo = (html: string): Array<SearchResult> => {
  const results: Array<SearchResult> = []
  const seen = new Set<string>()
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1)
  const classes = [...html.matchAll(/<div[^>]+class="([^"]*\bresult\b[^"]*)"/gi)].map((match) => match[1]!)
  blocks.forEach((block, index) => {
    if (/\bresult--ad\b/.test(classes[index] ?? "")) return
    const link = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    if (link === null) return
    const href = link[0].match(/href="([^"]*)"/i)?.[1]
    const url = href === undefined ? undefined : unwrapResultUrl(href.replace(/&amp;/g, "&"))
    if (url === undefined || !isResultUrl(url) || seen.has(url)) return
    const title = inlineText(link[1]!)
    if (title.length === 0) return
    seen.add(url)
    const snippet = block.match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i)?.[1]
    results.push({ title, url, snippet: snippet === undefined ? "" : inlineText(snippet) })
  })
  return results
}

const unquote = (text: string): string => text.replace(/\\(["\\])/g, "$1")

const indentOf = (line: string): number => line.length - line.trimStart().length

/** The first prose after a result's link, within its result: Google's `text` child or Bing's paragraph. */
const snippetAfter = (lines: ReadonlyArray<string>, index: number, indent: number): string => {
  let nested: number | undefined
  for (let next = index + 1; next < Math.min(lines.length, index + 30); next++) {
    const line = lines[next]!
    const lineIndent = indentOf(line)
    if (line.trim().length === 0 || lineIndent < indent - 2 || /^- listitem\b/.test(line.trim())) break
    if (lineIndent <= indent && /^- link "/.test(line.trim())) break
    if (nested !== undefined && lineIndent > nested) continue
    nested = /^- (link|heading) "/.test(line.trim()) ? lineIndent : undefined
    let text = line.trim().match(/^- (?:text|paragraph): (.*)$/)?.[1]?.trim()
    if (text?.startsWith("\"") && text.endsWith("\"")) text = unquote(text.slice(1, -1))
    if (text !== undefined && text.length >= 25 && !/https?:\/\/|›/.test(text)) return text
  }
  return ""
}

/**
 * Results from a search page's browser snapshot: camofox's Google results (link, `/url`, `cite`,
 * `text`) or any other engine's accessibility tree, where links carry a `/url` child.
 */
export const parseSearchSnapshot = (snapshot: string): Array<SearchResult> => {
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const byUrl = new Map<string, { title: string; url: string; snippet: string }>()
  const lines = snapshot.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const link = lines[index]!.match(/^(\s*)- link "((?:[^"\\]|\\.)*)"/)
    if (link === null) continue
    const indent = link[1]!.length
    let href: string | undefined
    for (let child = index + 1; child < lines.length; child++) {
      const line = lines[child]!
      if (line.trim().length === 0 || indentOf(line) <= indent) break
      const value = line.trim().match(/^- \/url: (.*)$/)
      if (value !== null) {
        href = value[1]!.trim()
        break
      }
    }
    const snippet = href === undefined ? "" : snippetAfter(lines, index, indent)
    const url = href === undefined ? undefined : unwrapResultUrl(href)
    const title = unquote(link[2]!).trim()
    if (url === undefined || title.length < 2 || !isResultUrl(url)) continue
    const existing = byUrl.get(url)
    if (existing !== undefined) {
      if (title.length > existing.title.length && !/^https?:\/\//.test(title)) existing.title = title
      if (existing.snippet.length === 0) existing.snippet = snippet
      continue
    }
    const result = { title, url, snippet }
    byUrl.set(url, result)
    results.push(result)
  }
  return results
}

const engineName = (engine: string): string =>
  engine === "duckduckgo" ? "DuckDuckGo" : engine.length > 0 ? `${engine[0]!.toUpperCase()}${engine.slice(1)}` : engine

export const formatResults = (query: string, source: string, results: ReadonlyArray<SearchResult>, limit: number): string => {
  const shown = results.slice(0, limit).map((result, index) => {
    const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`]
    if (result.snippet.length > 0) lines.push(`   ${shorten(result.snippet, 300)}`)
    return lines.join("\n")
  })
  return `Results for "${query}" from ${source}:\n\n${shown.join("\n\n")}\n\nUse web_fetch to read a result.`
}

/** One page of a fetched page's text, with the links it mentions listed under it. */
const formatPage = (
  page: { readonly url: string; readonly title: string; readonly text: string; readonly links: ReadonlyArray<string> },
  offset: number,
  note: string
): string => {
  const { body, next, start } = pageOf(page.text, offset, pageChars)
  const header = [page.title.length > 0 ? `# ${page.title}` : undefined, `URL: ${page.url} (${note})`].filter(Boolean).join("\n")
  const mentioned = [...new Set([...body.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))]
    .filter((number) => number >= 1 && number <= page.links.length)
  let linkList = ""
  for (const number of mentioned) {
    const line = `[${number}] ${page.links[number - 1]}\n`
    if (linkList.length + line.length > linkListChars) break
    linkList += line
  }
  const position = next !== undefined || start > 0
    ? `\n\n… Showing characters ${start}–${start + body.length} of ${page.text.length}.` +
      (next !== undefined ? ` Call web_fetch with offset=${next} to read more.` : " That's the end.")
    : ""
  const content = body.trim().length > 0 ? body.trim() : start > 0 ? "(nothing at this offset)" : "(the page has no readable text)"
  return `${header}\n\n${content}${linkList.length > 0 ? `\n\nLinks:\n${linkList.trimEnd()}` : ""}${position}`
}

/** One page of a browser snapshot, with a hint for reading on. */
export const formatSnapshotPage = (response: SnapshotResponse, offset: number, size: number, tool: string): string => {
  const window = snapshotWindow(response, offset, size)
  const position = window.next !== undefined || window.start > 0
    ? `\n\n… Showing characters ${window.start}–${window.start + window.body.length} of ${window.total}.` +
      (window.next !== undefined ? ` Call ${tool} with offset=${window.next} for more.` : " That's the end.")
    : ""
  const body = window.body.trim().length > 0 ? window.body.trimEnd() : "(the page is empty)"
  return `${body}${position}`
}

const isHtml = (contentType: string, body: string) =>
  /html|xhtml/i.test(contentType) || (contentType.length === 0 && /^\s*(<!doctype html|<html)/i.test(body))
const isText = (contentType: string) => /^text\/|json|xml|javascript|yaml|csv/i.test(contentType)

const SearchParams = Schema.Struct({
  query: Schema.String.annotate({ description: "What to search for." }),
  site: Schema.optional(Schema.String).annotate({ description: "Only search this site, e.g. `github.com`." }),
  limit: Schema.optional(Schema.Int).annotate({ description: `How many results to return (default ${defaultResults}, max ${maxResults}).` })
})

const FetchParams = Schema.Struct({
  url: Schema.String.annotate({ description: "The page to read (http or https)." }),
  offset: Schema.optional(Schema.Int).annotate({ description: "Character offset to continue a long page from (from the previous call's hint)." })
})

const hostOf = (raw: unknown): string => {
  if (typeof raw !== "string") return "a page"
  try {
    return new URL(/^[a-z]+:/i.test(raw) ? raw : `https://${raw}`).host || raw
  } catch {
    return shorten(raw, 50)
  }
}

export interface WebToolsOptions {
  /** camofox-browser, when it's the browser engine; the tools fall back to plain HTTP without it. */
  readonly camofox: Camofox["Service"] | undefined
  readonly owner: Omit<TabOwner, "purpose">
  readonly guard?: UrlGuard
  readonly duckDuckGoUrl?: string
}

export const webTools = (options: WebToolsOptions): ReadonlyArray<AgentTool> => {
  const guard = options.guard ?? ((url: string) => publicUrl(url))
  const owner: TabOwner = { ...options.owner, purpose: "web" }
  const camofox = options.camofox
  const ddgUrl = options.duckDuckGoUrl ?? duckDuckGoUrl
  /** Pages fetched over plain HTTP in this reply, so paging through one doesn't fetch it again. */
  const fetched = new Map<string, { url: string; title: string; text: string; links: ReadonlyArray<string> }>()

  const searchWithBrowser = (camofox: Camofox["Service"], query: string) =>
    Effect.gen(function*() {
      const result = yield* camofox.navigate(owner, { macro: "@google_search", query })
      if (!result.ok) {
        return yield* new ToolFailure({ message: result.googleBlocked ? "Google blocked the search." : "The search page didn't load." })
      }
      let results = parseSearchSnapshot((yield* camofox.snapshot(owner)).snapshot)
      // A fallback engine can still be redirecting or rendering its results when navigate returns.
      for (let attempt = 0; attempt < 2 && results.length === 0; attempt++) {
        yield* camofox.act(owner, "wait", { timeout: 10_000 })
        yield* Effect.sleep(Duration.seconds(1))
        results = parseSearchSnapshot((yield* camofox.snapshot(owner)).snapshot)
      }
      if (results.length === 0) {
        const links = yield* camofox.links(owner)
        results = links.flatMap((link) => {
          const url = unwrapResultUrl(link.href)
          const title = link.text.replace(/\s+/g, " ").trim()
          return url !== undefined && title.length > 1 && isResultUrl(url) ? [{ title, url, snippet: "" }] : []
        })
      }
      if (results.length === 0) return yield* new ToolFailure({ message: "The search page had no results." })
      const host = (() => {
        try {
          return new URL(result.url).hostname
        } catch {
          return ""
        }
      })()
      const engine = result.searchEngine ?? (/google\./.test(host) ? "google" : host.replace(/^www\./, "").split(".")[0] ?? "")
      return { results, source: `${engineName(engine)}, via the browser` }
    }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))

  const searchDuckDuckGo = (query: string) =>
    Effect.gen(function*() {
      const page = yield* fetchPage(ddgUrl, {
        method: "POST",
        form: { q: query, b: "" },
        headers: { referer: new URL(ddgUrl).origin + "/" }
      })
      if (page.status === 202 || /anomaly-modal|challenge-form/.test(page.body)) {
        return yield* new ToolFailure({ message: "DuckDuckGo asked for a captcha (too many searches from this server)." })
      }
      if (page.status >= 400) return yield* new ToolFailure({ message: `DuckDuckGo answered HTTP ${page.status}.` })
      return parseDuckDuckGo(page.body)
    })

  const searchTool: AgentTool = {
    name: "web_search",
    description:
      "Search the web and get a short list of results (title, URL, snippet). Use it to look things up; then read a result with web_fetch.",
    parameters: jsonSchemaOf(SearchParams),
    needsApproval: false,
    activity: "Searching the web",
    title: (params) => {
      const query = (params as { query?: unknown })?.query
      return typeof query === "string" && query.length > 0 ? `Searched "${shorten(query, 60)}"` : "Searched the web"
    },
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(SearchParams, raw)
        const site = params.site?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
        const query = site ? `${params.query.trim()} site:${site}` : params.query.trim()
        if (query.length === 0) return yield* new ToolFailure({ message: "The query is empty." })
        const limit = Math.min(Math.max(params.limit ?? defaultResults, 1), maxResults)

        let browserProblem: string | undefined
        if (camofox !== undefined) {
          if (yield* camofox.available) {
            const found = yield* Effect.result(searchWithBrowser(camofox, query))
            if (found._tag === "Success") return formatResults(query, found.success.source, found.success.results, limit)
            browserProblem = found.failure.message
          } else {
            browserProblem = "the browser service isn't running"
          }
        }
        const direct = yield* Effect.result(searchDuckDuckGo(query))
        const fallbackNote = browserProblem === undefined ? "" : ` (the browser couldn't search: ${browserProblem})`
        if (direct._tag === "Failure") {
          return yield* new ToolFailure({ message: `The search failed: ${direct.failure.message}${fallbackNote}` })
        }
        if (direct.success.length === 0) return `No results for "${query}" on DuckDuckGo${fallbackNote}.`
        return formatResults(query, `DuckDuckGo, searched directly${fallbackNote}`, direct.success, limit)
      })
  }

  const readWithBrowser = (camofox: Camofox["Service"], url: URL, offset: number) =>
    Effect.gen(function*() {
      if (offset === 0 || (yield* camofox.currentUrl(owner)) !== url.href) {
        const opened = yield* camofox.navigate(owner, { url: url.href })
        const landed = yield* Effect.result(guard(opened.url))
        if (landed._tag === "Failure" && /^https?:/.test(opened.url)) {
          yield* camofox.close(owner)
          return yield* new ToolFailure({ message: landed.failure.message })
        }
        if (opened.navigationOk === false) {
          return yield* new ToolFailure({ message: `${url.host} answered HTTP ${opened.httpStatus ?? "error"}.` })
        }
      }
      const response = yield* camofox.snapshot(owner, offset)
      return `URL: ${response.url} (read in the browser)\n\n${formatSnapshotPage(response, offset, pageChars, "web_fetch")}`
    }).pipe(Effect.catchTag("CamofoxError", (error) => Effect.fail(new ToolFailure({ message: error.message }))))

  const readDirectly = (url: URL, offset: number) =>
    Effect.gen(function*() {
      const cached = fetched.get(url.href)
      if (cached !== undefined) return formatPage(cached, offset, "fetched directly")
      const page = yield* fetchPage(url.href, { guard })
      if (page.status >= 400) {
        const excerpt = isHtml(page.contentType, page.body) ? htmlToText(page.body).text : page.body
        return yield* new ToolFailure({
          message: `${new URL(page.url).host} answered HTTP ${page.status}.${excerpt.trim() ? `\n\n${shorten(excerpt, 500)}` : ""}`
        })
      }
      const cutNote = page.cut ? `; only the first ${formatBytes(maxFetchBytes)} was read` : ""
      let converted: { url: string; title: string; text: string; links: ReadonlyArray<string> }
      if (isHtml(page.contentType, page.body)) {
        converted = { url: page.url, ...htmlToText(page.body, page.url) }
      } else if (isText(page.contentType)) {
        converted = { url: page.url, title: "", text: page.body, links: [] }
      } else {
        return `${page.url} is a ${page.contentType || "binary"} file (${formatBytes(page.bytes)}${page.cut ? " or more" : ""}); ` +
          "web_fetch only reads web pages and text. Download it with run_command if you need it."
      }
      fetched.set(url.href, converted)
      return formatPage(converted, offset, `fetched directly${cutNote}`)
    })

  const fetchTool: AgentTool = {
    name: "web_fetch",
    description:
      `Read a web page as text (headings, paragraphs, and links numbered [n] with their URLs listed). ` +
      `Long pages come ${pageChars} characters at a time; pass the offset from the hint to read on. ` +
      "Only public http(s) pages can be read.",
    parameters: jsonSchemaOf(FetchParams),
    needsApproval: false,
    activity: "Reading a page",
    title: (params) => `Read ${hostOf((params as { url?: unknown })?.url)}`,
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(FetchParams, raw)
        const offset = Math.max(params.offset ?? 0, 0)
        const url = yield* guard(params.url)
        if (camofox !== undefined && !fetched.has(url.href) && (yield* camofox.available)) {
          const read = yield* Effect.result(readWithBrowser(camofox, url, offset))
          if (read._tag === "Success") return read.success
          if (/bots can only open pages/.test(read.failure.message)) return yield* read.failure
          const direct = yield* Effect.result(readDirectly(url, offset))
          if (direct._tag === "Success") return direct.success
          return yield* new ToolFailure({ message: `${direct.failure.message} (the browser couldn't read it either: ${read.failure.message})` })
        }
        return yield* readDirectly(url, offset)
      })
  }

  return [searchTool, fetchTool]
}
