import { Clock, Context, Duration, Effect, Layer, Schema, Semaphore } from "effect"
import { AppConfig } from "../../config/Config.ts"

/** Why a call to camofox-browser failed; `gone` means the tab no longer exists there. */
export class CamofoxError extends Schema.TaggedError<CamofoxError>()("CamofoxError", {
  reason: Schema.Literals(["unreachable", "timeout", "gone", "no-page", "failed"]),
  message: Schema.String
}) {}

/** Each bot is a camofox user and each conversation a tab group; the browser tools and web tools keep a tab each. */
export interface TabOwner {
  readonly botId: string
  readonly conversationId: string
  readonly purpose: "browser" | "web"
}

export type NavigateTarget = { readonly url: string } | { readonly macro: string; readonly query: string }

export interface NavigateResult {
  readonly ok: boolean
  readonly url: string
  readonly googleSerp?: boolean
  readonly googleBlocked?: boolean
  /** Set when camofox fell back from Google to another engine, e.g. `duckduckgo`. */
  readonly searchEngine?: string
  readonly navigationOk?: boolean
  readonly httpStatus?: number | null
}

export interface SnapshotResponse {
  readonly url: string
  readonly snapshot: string
  readonly refsCount?: number
  readonly truncated?: boolean
  readonly totalChars?: number
  readonly hasMore?: boolean
  readonly nextOffset?: number | null
}

export interface PageLink {
  readonly text: string
  readonly href: string
  readonly ref?: string
}

export type TabAction = "click" | "type" | "press" | "scroll" | "back" | "wait"

/** How long a health check stays fresh. */
export const healthCacheMillis = 10_000
const healthTimeout = Duration.seconds(3)
const actionTimeout = Duration.seconds(45)
/** Opening a page can wait for a cold browser start plus camofox's own 30-second navigation limit. */
const navigateTimeout = Duration.seconds(90)
const cleanupTimeout = Duration.seconds(5)

/**
 * camofox-browser sends snapshots up to 80K characters whole; longer ones come as a chunk of this
 * many characters from the offset, a `[... truncated at char N of M ...]` marker, and the page's
 * last 5K characters (its navigation links).
 */
const snapshotChunkChars = 74_800
const snapshotTailChars = 5_000

const markerPattern = /\n\[\.\.\. truncated at char (\d+) of \d+\./

/** One page of a camofox snapshot, starting at `offset`. */
export const snapshotWindow = (
  response: SnapshotResponse,
  offset: number,
  size: number
): { readonly body: string; readonly start: number; readonly next: number | undefined; readonly total: number } => {
  const text = response.snapshot ?? ""
  const cut = (chunk: string, from: number) => {
    let end = Math.min(from + size, chunk.length)
    if (end < chunk.length) {
      const lineBreak = chunk.lastIndexOf("\n", end)
      if (lineBreak > from + size * 0.7) end = lineBreak + 1
    }
    return end
  }
  if (response.truncated !== true) {
    const start = Math.min(Math.max(offset, 0), text.length)
    const end = cut(text, start)
    return { body: text.slice(start, end), start, next: end < text.length ? end : undefined, total: text.length }
  }
  const total = response.totalChars ?? text.length
  const marker = markerPattern.exec(text)
  const start = marker !== null
    ? Number(marker[1]) - snapshotChunkChars
    : Math.min(Math.max(offset, 0), Math.max(total - snapshotTailChars, 0))
  const chunk = marker !== null ? text.slice(0, marker.index) : text.slice(0, Math.max(text.length - snapshotTailChars - 1, 0))
  const end = cut(chunk, 0)
  const next = start + end
  return { body: chunk.slice(0, end), start, next: next < total ? next : undefined, total }
}

/** Talks to camofox-browser's REST API and remembers each bot and conversation's current tabs. */
export class Camofox extends Context.Service<Camofox, {
  readonly url: string
  /** Whether camofox answers its health check; cached for a few seconds. */
  readonly available: Effect.Effect<boolean>
  /** Opens a URL or search in the owner's tab, creating it (or replacing one that vanished) when needed. */
  navigate(owner: TabOwner, target: NavigateTarget): Effect.Effect<NavigateResult, CamofoxError>
  snapshot(owner: TabOwner, offset?: number): Effect.Effect<SnapshotResponse, CamofoxError>
  act(owner: TabOwner, action: TabAction, body?: Record<string, unknown>): Effect.Effect<{ readonly url?: string }, CamofoxError>
  links(owner: TabOwner): Effect.Effect<ReadonlyArray<PageLink>, CamofoxError>
  screenshot(owner: TabOwner): Effect.Effect<{ readonly data: string; readonly mimeType: string }, CamofoxError>
  /** The URL the owner's tab was last sent to, if it has one. */
  currentUrl(owner: TabOwner): Effect.Effect<string | undefined>
  /** Closes the owner's tab. Never fails. */
  close(owner: TabOwner): Effect.Effect<void>
  /** Closes every tab the conversation's bots have open for it. Never fails. */
  closeConversation(conversationId: string, botIds: ReadonlyArray<string>): Effect.Effect<void>
  /** Ends a deleted bot's browser session and deletes its saved cookies. Never fails. */
  removeBot(botId: string): Effect.Effect<void>
}>()("weaver/Camofox") {
  static readonly layer = Layer.effect(
    Camofox,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const base = config.camofoxUrl
      const notRunning = `The browser service isn't running at ${base}. Start it with \`npx @askjo/camofox-browser\` or rerun the setup script.`

      const tabs = new Map<string, { id: string; url: string | undefined }>()
      const locks = new Map<string, Semaphore.Semaphore>()
      let health: { ok: boolean; checkedAt: number } | undefined

      const keyOf = (owner: TabOwner) => `${owner.botId}\n${owner.conversationId}\n${owner.purpose}`
      const lockFor = (key: string) => {
        let lock = locks.get(key)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          locks.set(key, lock)
        }
        return lock
      }

      const request = <A>(
        method: "GET" | "POST" | "DELETE",
        path: string,
        options: {
          readonly body?: Record<string, unknown>
          readonly query?: Record<string, string | number>
          readonly timeout?: Duration.Duration
          /** The route is about one tab, so 404 and 410 mean that tab is gone. */
          readonly tab?: boolean
        } = {}
      ): Effect.Effect<A, CamofoxError> => {
        const timeout = options.timeout ?? actionTimeout
        return Effect.tryPromise({
          try: async (signal) => {
            const url = new URL(`${base}${path}`)
            for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value))
            const headers: Record<string, string> = {}
            if (config.camofoxKey.length > 0) headers.authorization = `Bearer ${config.camofoxKey}`
            if (options.body !== undefined) headers["content-type"] = "application/json"
            const response = await fetch(url, {
              method,
              headers,
              signal,
              ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
            })
            const text = await response.text()
            let json: unknown
            try {
              json = text.length > 0 ? JSON.parse(text) : {}
            } catch {
              json = undefined
            }
            return { status: response.status, json, text }
          },
          catch: () => new CamofoxError({ reason: "unreachable", message: notRunning })
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new CamofoxError({
                  reason: "timeout",
                  message: `The browser didn't answer within ${Math.round(Duration.toSeconds(timeout))} seconds.`
                })
              )
          }),
          Effect.flatMap(({ json, status, text }) => {
            if (status >= 200 && status < 300 && json !== undefined) return Effect.succeed(json as A)
            const detail = (json as { error?: unknown } | undefined)?.error
            const said = typeof detail === "string" && detail.length > 0 ? detail : text.trim().slice(0, 300) || `HTTP ${status}`
            if (status === 401 || status === 403) {
              return Effect.fail(
                new CamofoxError({
                  reason: "failed",
                  message: `The browser service at ${base} refused Weaver's access key; set WEAVER_CAMOFOX_KEY to its CAMOFOX_ACCESS_KEY.`
                })
              )
            }
            if (options.tab === true && (status === 404 || status === 410)) {
              return Effect.fail(new CamofoxError({ reason: "gone", message: `The browser tab is gone (${said}).` }))
            }
            return Effect.fail(new CamofoxError({ reason: "failed", message: `The browser couldn't do that: ${said}` }))
          })
        )
      }

      const available = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        if (health !== undefined && now - health.checkedAt < healthCacheMillis) return health.ok
        const ok = yield* request<{ ok?: boolean }>("GET", "/health", { timeout: healthTimeout }).pipe(
          Effect.map((body) => body.ok !== false),
          Effect.catch(() => Effect.succeed(false))
        )
        health = { ok, checkedAt: yield* Clock.currentTimeMillis }
        return ok
      })

      const forget = (key: string) =>
        Effect.sync(() => {
          tabs.delete(key)
        })

      const navigate = (owner: TabOwner, target: NavigateTarget) => {
        const key = keyOf(owner)
        const ids = { userId: owner.botId, sessionKey: owner.conversationId }
        const send = (tabId: string) =>
          request<NavigateResult>("POST", `/tabs/${encodeURIComponent(tabId)}/navigate`, {
            body: { ...ids, ...target },
            timeout: navigateTimeout,
            tab: true
          })
        const remember = (id: string, result: NavigateResult) =>
          Effect.sync(() => {
            tabs.set(key, { id, url: "url" in target ? target.url : result.url })
            return result
          })
        const create = Effect.gen(function*() {
          const created = yield* request<{ tabId: string; url: string; navigationOk?: boolean; httpStatus?: number | null }>(
            "POST",
            "/tabs",
            { body: "url" in target ? { ...ids, url: target.url } : ids, timeout: navigateTimeout }
          )
          if ("url" in target) {
            return yield* remember(created.tabId, {
              ok: true,
              url: created.url,
              ...(created.navigationOk !== undefined ? { navigationOk: created.navigationOk } : {}),
              ...(created.httpStatus !== undefined ? { httpStatus: created.httpStatus } : {})
            })
          }
          tabs.set(key, { id: created.tabId, url: undefined })
          return yield* remember(created.tabId, yield* send(created.tabId))
        })
        return lockFor(key).withPermit(Effect.gen(function*() {
          const existing = tabs.get(key)
          if (existing === undefined) return yield* create
          const sent = yield* Effect.result(send(existing.id))
          if (sent._tag === "Success") return yield* remember(existing.id, sent.success)
          if (sent.failure.reason !== "gone") return yield* sent.failure
          yield* forget(key)
          return yield* create
        }))
      }

      /** Runs `use` on the owner's tab; a tab that's gone is forgotten and reported. */
      const onTab = <A>(owner: TabOwner, use: (tabId: string) => Effect.Effect<A, CamofoxError>) => {
        const key = keyOf(owner)
        return lockFor(key).withPermit(Effect.gen(function*() {
          const tab = tabs.get(key)
          if (tab === undefined) {
            return yield* new CamofoxError({
              reason: "no-page",
              message: "No page is open in the browser yet. Open one with browser_navigate first."
            })
          }
          return yield* use(tab.id).pipe(
            Effect.catchTag("CamofoxError", (error) =>
              error.reason === "gone"
                ? Effect.andThen(
                  forget(key),
                  Effect.fail(
                    new CamofoxError({
                      reason: "gone",
                      message: "The browser tab was closed (the browser may have restarted). Open the page again with browser_navigate."
                    })
                  )
                )
                : Effect.fail(error))
          )
        }))
      }

      const snapshot = (owner: TabOwner, offset = 0) =>
        onTab(owner, (tabId) => {
          const get = request<SnapshotResponse>("GET", `/tabs/${encodeURIComponent(tabId)}/snapshot`, {
            query: { userId: owner.botId, ...(offset > 0 ? { offset } : {}) },
            tab: true
          })
          // camofox pages from its last snapshot, so without one an offset gets the first chunk; ask again.
          return Effect.flatMap(get, (response) =>
            offset > 0 && response.truncated === true &&
              Number(markerPattern.exec(response.snapshot)?.[1]) === snapshotChunkChars
              ? get
              : Effect.succeed(response))
        })

      const act = (owner: TabOwner, action: TabAction, body: Record<string, unknown> = {}) =>
        onTab(owner, (tabId) =>
          request<{ url?: string }>("POST", `/tabs/${encodeURIComponent(tabId)}/${action}`, {
            body: { userId: owner.botId, ...body },
            timeout: action === "back" ? navigateTimeout : actionTimeout,
            tab: true
          }))

      const links = (owner: TabOwner) =>
        onTab(owner, (tabId) =>
          request<{ links?: ReadonlyArray<PageLink> }>("GET", `/tabs/${encodeURIComponent(tabId)}/links`, {
            query: { userId: owner.botId },
            tab: true
          })).pipe(Effect.map((body) => body.links ?? []))

      const screenshot = (owner: TabOwner) =>
        onTab(owner, (tabId) =>
          request<{ screenshot?: { data?: string; mimeType?: string } }>(
            "GET",
            `/tabs/${encodeURIComponent(tabId)}/screenshot`,
            { query: { userId: owner.botId }, tab: true }
          )).pipe(
            Effect.flatMap((body) =>
              body.screenshot?.data
                ? Effect.succeed({ data: body.screenshot.data, mimeType: body.screenshot.mimeType ?? "image/png" })
                : Effect.fail(new CamofoxError({ reason: "failed", message: "The browser didn't return a screenshot." }))
            )
          )

      const bestEffort = (what: string, effect: Effect.Effect<unknown, CamofoxError>) =>
        effect.pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            error.reason === "unreachable" ? Effect.void : Effect.logWarning(`Couldn't ${what}: ${error.message}`)
          )
        )

      const close = (owner: TabOwner) => {
        const key = keyOf(owner)
        return lockFor(key).withPermit(Effect.suspend(() => {
          const tab = tabs.get(key)
          tabs.delete(key)
          if (tab === undefined) return Effect.void
          return bestEffort(
            "close a browser tab",
            request("DELETE", `/tabs/${encodeURIComponent(tab.id)}`, { query: { userId: owner.botId }, timeout: cleanupTimeout })
          )
        }))
      }

      const closeConversation = (conversationId: string, botIds: ReadonlyArray<string>) =>
        Effect.suspend(() => {
          const owners = new Set(botIds)
          for (const [key] of tabs) {
            const [botId, conversation] = key.split("\n")
            if (conversation === conversationId) {
              owners.add(botId!)
              tabs.delete(key)
            }
          }
          return Effect.forEach(
            owners,
            (botId) =>
              bestEffort(
                "close a conversation's browser tabs",
                request("DELETE", `/tabs/group/${encodeURIComponent(conversationId)}`, {
                  query: { userId: botId },
                  timeout: cleanupTimeout
                })
              ),
            { concurrency: 4, discard: true }
          )
        })

      const removeBot = (botId: string) =>
        Effect.gen(function*() {
          for (const key of [...tabs.keys()]) {
            if (key.startsWith(`${botId}\n`)) {
              tabs.delete(key)
              locks.delete(key)
            }
          }
          const user = encodeURIComponent(botId)
          yield* bestEffort("end a deleted bot's browser session", request("DELETE", `/sessions/${user}`, { timeout: cleanupTimeout }))
          // Served by camofox's persistence plugin; without it there's nothing saved to delete.
          yield* request("DELETE", `/sessions/${user}/storage_state`, { timeout: cleanupTimeout }).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              error.reason === "unreachable" || error.message.includes("Cannot DELETE")
                ? Effect.void
                : Effect.logWarning(`Couldn't delete a deleted bot's browser cookies: ${error.message}`)
            )
          )
        })

      return Camofox.of({
        url: base,
        available,
        navigate,
        snapshot,
        act,
        links,
        screenshot,
        currentUrl: (owner) => Effect.sync(() => tabs.get(keyOf(owner))?.url),
        close,
        closeConversation,
        removeBot
      })
    })
  )
}
