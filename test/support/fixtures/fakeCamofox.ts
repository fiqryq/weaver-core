/**
 * A camofox-browser REST server for tests: keeps tabs per user and session key like the real one,
 * pages long snapshots the same way, and records every request.
 */

export interface CamofoxRequest {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  readonly body: Record<string, unknown>
  readonly authorization: string | null
}

interface Tab {
  readonly userId: string
  readonly sessionKey: string
  url: string
  history: Array<string>
}

export interface FakeCamofoxOptions {
  /** Requires `Authorization: Bearer <key>` on everything but `/health`. */
  readonly accessKey?: string
  /** Snapshots by URL; other pages get a small generic one. */
  readonly pages?: Record<string, string>
  /** Snapshot of the Google results page. */
  readonly googleSnapshot?: string
  /** Google answers with its "unusual traffic" page and camofox has no fallback left. */
  readonly googleBlocked?: boolean
  /** Google blocks and camofox falls back to Bing, whose results only show once the page is waited on. */
  readonly bingSnapshot?: string
}

// camofox-browser's snapshot window (lib/snapshot.js).
const maxSnapshotChars = 80_000
const tailChars = 5_000

const windowSnapshot = (yaml: string, offset: number) => {
  const total = yaml.length
  if (total <= maxSnapshotChars) return { text: yaml, truncated: false, totalChars: total, hasMore: false, nextOffset: null }
  const budget = maxSnapshotChars - tailChars - 200
  const tail = yaml.slice(-tailChars)
  const clamped = Math.min(Math.max(0, offset), total - tailChars)
  const chunkEnd = clamped + budget
  const hasMore = chunkEnd < total - tailChars
  const marker = hasMore
    ? `\n[... truncated at char ${chunkEnd} of ${total}. Call snapshot with offset=${chunkEnd} to see more. Pagination links below. ...]\n`
    : "\n"
  return { text: yaml.slice(clamped, chunkEnd) + marker + tail, truncated: true, totalChars: total, hasMore, nextOffset: hasMore ? chunkEnd : null }
}

const genericPage = (url: string) =>
  [
    `- heading "Page at ${url}" [level=1]`,
    `- link "Next page" [e1]:`,
    `  - /url: ${url.replace(/\/$/, "")}/next`,
    `- textbox "Search" [e2]`,
    `- button "Go" [e3]`
  ].join("\n")

// A 1x1 transparent PNG.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

export const startFakeCamofox = (options: FakeCamofoxOptions = {}) => {
  const requests: Array<CamofoxRequest> = []
  const tabs = new Map<string, Tab>()
  /** The last full snapshot per tab, which offsets page through (like camofox's `lastSnapshot`). */
  const lastSnapshot = new Map<string, string>()
  /** Tabs whose current page has been waited on. */
  const settled = new Set<string>()
  let counter = 0

  const snapshotOf = (url: string, tabId?: string) =>
    url.startsWith("https://www.google.com/search")
      ? options.googleSnapshot ?? genericPage(url)
      : url.startsWith("https://www.bing.com/search") && options.bingSnapshot !== undefined
      ? tabId !== undefined && settled.has(tabId) ? options.bingSnapshot : `- banner:\n  - link "Back to Bing search" [e3]:\n    - /url: /?FORM=Z9FD1`
      : options.pages?.[url] ?? genericPage(url)

  const goTo = (tabId: string, tab: Tab, url: string) => {
    tab.history.push(tab.url)
    tab.url = url
    lastSnapshot.delete(tabId)
    settled.delete(tabId)
  }

  const notFound = () => Response.json({ error: "Tab not found" }, { status: 404 })

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, unknown> : {}
      requests.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        authorization: request.headers.get("authorization")
      })
      if (url.pathname === "/health") return Response.json({ ok: true, engine: "camoufox", browserRunning: true })
      if (options.accessKey !== undefined && request.headers.get("authorization") !== `Bearer ${options.accessKey}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 })
      }
      const userId = String(body.userId ?? url.searchParams.get("userId") ?? "")

      if (request.method === "POST" && url.pathname === "/tabs") {
        if (!userId || !body.sessionKey) return Response.json({ error: "userId and sessionKey required" }, { status: 400 })
        const tabId = `tab-${++counter}`
        tabs.set(tabId, { userId, sessionKey: String(body.sessionKey), url: String(body.url ?? "about:blank"), history: [] })
        return Response.json({ tabId, url: body.url ?? "about:blank", httpStatus: body.url ? 200 : null, navigationOk: true })
      }

      const session = url.pathname.match(/^\/sessions\/([^/]+)(\/storage_state)?$/)
      if (request.method === "DELETE" && session !== null) {
        const user = decodeURIComponent(session[1]!)
        for (const [id, tab] of tabs) if (tab.userId === user) tabs.delete(id)
        return Response.json(session[2] ? { ok: true, userId: user, clearedLive: true, removedPersisted: true } : { ok: true })
      }

      const group = url.pathname.match(/^\/tabs\/group\/([^/]+)$/)
      if (request.method === "DELETE" && group !== null) {
        const key = decodeURIComponent(group[1]!)
        for (const [id, tab] of tabs) if (tab.userId === userId && tab.sessionKey === key) tabs.delete(id)
        return Response.json({ ok: true })
      }

      const route = url.pathname.match(/^\/tabs\/([^/]+)(?:\/([a-z]+))?$/)
      if (route === null) return new Response(`Cannot ${request.method} ${url.pathname}`, { status: 404 })
      const tabId = decodeURIComponent(route[1]!)
      const action = route[2]
      const tab = tabs.get(tabId)
      if (request.method === "DELETE" && action === undefined) {
        tabs.delete(tabId)
        return Response.json({ ok: true })
      }
      if (tab === undefined || tab.userId !== userId) return notFound()

      switch (action) {
        case "navigate": {
          if (body.macro === "@google_search") {
            const target = `https://www.google.com/search?q=${encodeURIComponent(String(body.query ?? ""))}`
            if (options.bingSnapshot !== undefined) {
              const bing = target.replace("https://www.google.com/", "https://www.bing.com/")
              goTo(tabId, tab, bing)
              return Response.json({ ok: true, tabId, url: bing, refsAvailable: true, searchEngine: "bing", fallbackFrom: "google" })
            }
            goTo(tabId, tab, target)
            if (options.googleBlocked) {
              return Response.json({ ok: false, tabId, url: "https://www.google.com/sorry/index", refsAvailable: false, googleBlocked: true })
            }
            return Response.json({ ok: true, tabId, url: target, refsAvailable: false, googleSerp: true })
          }
          if (typeof body.macro === "string") {
            const target = `https://www.${String(body.macro).slice(1).replace(/_search$/, "")}.com/search?q=${encodeURIComponent(String(body.query ?? ""))}`
            goTo(tabId, tab, target)
            return Response.json({ ok: true, tabId, url: target, refsAvailable: true })
          }
          if (typeof body.url !== "string") return Response.json({ error: "url or macro required" }, { status: 400 })
          goTo(tabId, tab, body.url)
          return Response.json({ ok: true, tabId, url: body.url, refsAvailable: true, httpStatus: 200, navigationOk: true })
        }
        case "snapshot": {
          const offset = Number(url.searchParams.get("offset") ?? 0)
          const cached = lastSnapshot.get(tabId)
          const full = offset > 0 && cached !== undefined ? cached : snapshotOf(tab.url, tabId)
          lastSnapshot.set(tabId, full)
          const window = windowSnapshot(full, offset > 0 && cached !== undefined ? offset : 0)
          return Response.json({
            url: tab.url,
            snapshot: window.text,
            refsCount: (full.match(/\[e\d+\]/g) ?? []).length,
            truncated: window.truncated,
            totalChars: window.totalChars,
            hasMore: window.hasMore,
            nextOffset: window.nextOffset
          })
        }
        case "click": {
          const ref = String(body.ref ?? "")
          if (!snapshotOf(tab.url).includes(`[${ref}]`)) {
            return Response.json(
              { error: `Unknown ref: ${ref} (valid refs: e1-e3, 3 total). Refs reset after navigation - call snapshot first.` },
              { status: 422 }
            )
          }
          const link = snapshotOf(tab.url).match(new RegExp(`\\[${ref}\\]:\\n\\s+- /url: (\\S+)`))
          if (link !== null) goTo(tabId, tab, link[1]!)
          return Response.json({ ok: true, url: tab.url, refsAvailable: true })
        }
        case "type": {
          if (body.submit === true) goTo(tabId, tab, `${tab.url.split("?")[0]}?q=${encodeURIComponent(String(body.text ?? ""))}`)
          return Response.json({ ok: true })
        }
        case "press":
        case "scroll":
          return Response.json({ ok: true })
        case "wait":
          settled.add(tabId)
          return Response.json({ ok: true, ready: true })
        case "back": {
          const previous = tab.history.pop()
          if (previous !== undefined) {
            tab.url = previous
            lastSnapshot.delete(tabId)
          }
          return Response.json({ ok: true, url: tab.url })
        }
        case "links":
          return Response.json({
            links: [...snapshotOf(tab.url).matchAll(/- link "([^"]*)" \[(e\d+)\]:\n\s+- \/url: (\S+)/g)].map((match) => ({
              text: match[1],
              ref: match[2],
              href: match[3]
            }))
          })
        case "screenshot":
          return Response.json({ screenshot: { data: png, mimeType: "image/png" } })
      }
      return new Response(`Cannot ${request.method} ${url.pathname}`, { status: 404 })
    }
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    tabs,
    /** Drops a tab as if camofox restarted or reaped it. */
    dropTab: (tabId: string) => tabs.delete(tabId),
    close: () => server.stop(true)
  }
}

export type FakeCamofox = ReturnType<typeof startFakeCamofox>
