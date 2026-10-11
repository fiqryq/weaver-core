import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Clock, Effect, Schema } from "effect"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"
import type { Camofox, CamofoxError, TabAction, TabOwner } from "./Camofox.ts"
import { formatBytes } from "./Files.ts"
import { publicUrl, type UrlGuard } from "./UrlGuard.ts"
import { formatSnapshotPage, pageChars } from "./Web.ts"

/** Sites camofox-browser has a search shortcut for (its `@<engine>_search` macros). */
export const searchEngines = [
  "google",
  "youtube",
  "amazon",
  "reddit",
  "wikipedia",
  "twitter",
  "yelp",
  "spotify",
  "netflix",
  "linkedin",
  "instagram",
  "tiktok",
  "twitch"
] as const

const linkListChars = 8_000

const NavigateParams = Schema.Struct({
  url: Schema.optional(Schema.String).annotate({ description: "The page to open (http or https)." }),
  search: Schema.optional(
    Schema.Struct({
      engine: Schema.Literals(searchEngines).annotate({ description: "Where to search." }),
      query: Schema.String.annotate({ description: "What to search for." })
    })
  ).annotate({ description: "Open a site's search results instead of a URL." })
})
const SnapshotParams = Schema.Struct({
  offset: Schema.optional(Schema.Int).annotate({ description: "Character offset to continue a long page from (from the previous hint)." })
})
const ClickParams = Schema.Struct({
  ref: Schema.String.annotate({ description: "The element's ref from the snapshot, e.g. `e12`." })
})
const TypeParams = Schema.Struct({
  ref: Schema.String.annotate({ description: "The field's ref from the snapshot, e.g. `e3`." }),
  text: Schema.String.annotate({ description: "The text to fill in; it replaces what's in the field." }),
  submit: Schema.optional(Schema.Boolean).annotate({ description: "Press Enter afterwards, e.g. to send a search." })
})
const PressParams = Schema.Struct({
  key: Schema.String.annotate({ description: "A key name such as `Enter`, `Escape`, `Tab`, `ArrowDown` or `Control+a`." })
})
const ScrollParams = Schema.Struct({
  direction: Schema.Literals(["up", "down", "left", "right"]),
  amount: Schema.optional(Schema.Int).annotate({ description: "Pixels to scroll (default 500)." })
})
const NoParams = Schema.Struct({})

const refOf = (params: unknown): string => {
  const ref = (params as { ref?: unknown })?.ref
  return typeof ref === "string" && ref.length > 0 ? shorten(ref.replace(/^@/, ""), 20) : "an element"
}

const navigateTitle = (params: unknown): string => {
  const { search, url } = (params ?? {}) as { url?: unknown; search?: { engine?: unknown; query?: unknown } }
  if (search !== undefined && typeof search?.query === "string") {
    return `Searched ${typeof search.engine === "string" ? search.engine : "the web"} for "${shorten(search.query, 50)}"`
  }
  if (typeof url !== "string" || url.length === 0) return "Opened a page"
  try {
    return `Opened ${new URL(/^[a-z]+:/i.test(url) ? url : `https://${url}`).host}`
  } catch {
    return `Opened ${shorten(url, 60)}`
  }
}

export interface BrowserToolsOptions {
  readonly camofox: Camofox["Service"]
  readonly owner: Omit<TabOwner, "purpose">
  /** Where screenshots are saved. */
  readonly workspace: string
  readonly guard?: UrlGuard
}

/** The browser tools on camofox-browser: each bot drives its own tab per conversation, read through snapshots with element refs. */
export const browserTools = (options: BrowserToolsOptions): ReadonlyArray<AgentTool> => {
  const { camofox } = options
  const guard = options.guard ?? ((url: string) => publicUrl(url))
  const owner: TabOwner = { ...options.owner, purpose: "browser" }
  const failure = (error: CamofoxError) => new ToolFailure({ message: error.message })

  /** The page as a snapshot; a page on a private address is closed instead of shown. */
  const showPage = (prefix: string, offset = 0) =>
    Effect.gen(function*() {
      const response = yield* camofox.snapshot(owner, offset).pipe(Effect.mapError(failure))
      if (/^https?:/i.test(response.url)) {
        const checked = yield* Effect.result(guard(response.url))
        if (checked._tag === "Failure") {
          yield* camofox.close(owner)
          return yield* new ToolFailure({ message: `${checked.failure.message} The tab was closed.` })
        }
      }
      return `${prefix}URL: ${response.url}\n\n${formatSnapshotPage(response, offset, pageChars, "browser_snapshot")}`
    })

  const act = (action: TabAction, body: Record<string, unknown>, done: string) =>
    Effect.andThen(camofox.act(owner, action, body).pipe(Effect.mapError(failure)), showPage(`${done}\n`))

  const tool = <S extends Schema.Top & { readonly DecodingServices: never }>(
    spec: Omit<AgentTool, "run" | "parameters" | "needsApproval" | "activity"> & { readonly params: S },
    run: (params: S["Type"]) => Effect.Effect<string, ToolFailure>
  ): AgentTool => ({
    name: spec.name,
    description: spec.description,
    parameters: jsonSchemaOf(spec.params),
    needsApproval: false,
    activity: "Using the browser",
    title: spec.title,
    run: (raw) => Effect.flatMap(decodeParams(spec.params, raw), run)
  })

  return [
    tool({
      name: "browser_navigate",
      description:
        "Open a page in your web browser, or a site's search results with `search`. Returns the page as an accessibility " +
        "snapshot where interactive elements have refs like [e12] for browser_click and browser_type. " +
        "For simply looking something up, web_search and web_fetch are faster.",
      title: navigateTitle,
      params: NavigateParams
    }, (params) =>
      Effect.gen(function*() {
        if (params.search !== undefined) {
          const query = params.search.query.trim()
          if (query.length === 0) return yield* new ToolFailure({ message: "The search query is empty." })
          const result = yield* camofox.navigate(owner, { macro: `@${params.search.engine}_search`, query }).pipe(Effect.mapError(failure))
          const note = result.googleBlocked === true
            ? "Google blocked the search; try web_search instead.\n"
            : result.searchEngine !== undefined
            ? `Google didn't answer, so this searched ${result.searchEngine}.\n`
            : ""
          return yield* showPage(note)
        }
        if (params.url === undefined || params.url.trim().length === 0) {
          return yield* new ToolFailure({ message: "Pass a url to open, or a search." })
        }
        const url = yield* guard(params.url)
        const result = yield* camofox.navigate(owner, { url: url.href }).pipe(Effect.mapError(failure))
        const status = result.navigationOk === false ? `The page answered HTTP ${result.httpStatus ?? "error"}.\n` : ""
        return yield* showPage(status)
      })),
    tool({
      name: "browser_snapshot",
      description: `Read the current page again (e.g. after it changed). Long pages come ${pageChars} characters at a time; pass the offset from the hint to read on.`,
      title: () => "Read the page",
      params: SnapshotParams
    }, (params) => showPage("", Math.max(params.offset ?? 0, 0))),
    tool({
      name: "browser_click",
      description: "Click an element by its ref from the latest snapshot. Returns the page afterwards.",
      title: (params) => `Clicked ${refOf(params)}`,
      params: ClickParams
    }, (params) => act("click", { ref: params.ref.replace(/^@/, "") }, `Clicked ${params.ref}.`)),
    tool({
      name: "browser_type",
      description: "Fill a text field by its ref from the latest snapshot, optionally pressing Enter. Returns the page afterwards.",
      title: (params) => `Typed into ${refOf(params)}`,
      params: TypeParams
    }, (params) =>
      act(
        "type",
        { ref: params.ref.replace(/^@/, ""), text: params.text, submit: params.submit === true },
        `Typed into ${params.ref}${params.submit === true ? " and pressed Enter" : ""}.`
      )),
    tool({
      name: "browser_press",
      description: "Press a key on the page, e.g. Enter, Escape or Tab. Returns the page afterwards.",
      title: (params) => {
        const key = (params as { key?: unknown })?.key
        return `Pressed ${typeof key === "string" ? shorten(key, 20) : "a key"}`
      },
      params: PressParams
    }, (params) => act("press", { key: params.key }, `Pressed ${params.key}.`)),
    tool({
      name: "browser_scroll",
      description: "Scroll the page, e.g. to load more results. Returns the page afterwards.",
      title: (params) => {
        const direction = (params as { direction?: unknown })?.direction
        return `Scrolled ${typeof direction === "string" ? direction : "the page"}`
      },
      params: ScrollParams
    }, (params) =>
      act(
        "scroll",
        { direction: params.direction, ...(params.amount !== undefined ? { amount: Math.max(params.amount, 1) } : {}) },
        `Scrolled ${params.direction}.`
      )),
    tool({
      name: "browser_back",
      description: "Go back to the previous page. Returns that page.",
      title: () => "Went back",
      params: NoParams
    }, () => act("back", {}, "Went back.")),
    tool({
      name: "browser_links",
      description: "List the links on the current page with their URLs and refs.",
      title: () => "Listed the page's links",
      params: NoParams
    }, () =>
      Effect.gen(function*() {
        const links = yield* camofox.links(owner).pipe(Effect.mapError(failure))
        if (links.length === 0) return "The page has no links."
        let text = ""
        let shown = 0
        for (const link of links) {
          const label = link.text.replace(/\s+/g, " ").trim() || "(no text)"
          const line = `${link.ref ? `[${link.ref}] ` : ""}${shorten(label, 100)} — ${link.href}\n`
          if (text.length + line.length > linkListChars) break
          text += line
          shown++
        }
        return shown < links.length ? `${text}… and ${links.length - shown} more links.` : text.trimEnd()
      })),
    tool({
      name: "browser_screenshot",
      description:
        "Save a screenshot of the current page as a PNG in your workspace (you can't see it yourself; use browser_snapshot to read the page).",
      title: () => "Took a screenshot",
      params: NoParams
    }, () =>
      Effect.gen(function*() {
        const shot = yield* camofox.screenshot(owner).pipe(Effect.mapError(failure))
        const bytes = Buffer.from(shot.data, "base64")
        const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().replace(/[:.]/g, "-")
        const name = join("screenshots", `screenshot-${stamp}.png`)
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(join(options.workspace, "screenshots"), { recursive: true })
            await writeFile(join(options.workspace, name), bytes)
          },
          catch: (cause) => new ToolFailure({ message: `Couldn't save the screenshot: ${String(cause)}` })
        })
        return `Saved a screenshot (${formatBytes(bytes.length)}) to ${name} in your workspace.`
      })),
    tool({
      name: "browser_close",
      description: "Close your browser tab when you're done with it.",
      title: () => "Closed the browser tab",
      params: NoParams
    }, () => Effect.as(camofox.close(owner), "Closed the browser tab."))
  ]
}
