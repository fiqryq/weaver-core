import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BunHttpServer } from "@effect/platform-bun"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { defaultUpdateUrl } from "../../../src/config/Config.ts"
import { compareVersions, CurrentBuild, isUpdateAvailable, ReleaseInfo, sameCommit } from "../../../src/features/updates/Update.ts"
import { UpdateHttp, updateFiles } from "../../../src/features/updates/Updates.ts"
import { AppRoutes } from "../../../src/main.ts"
import { say, scriptedModel, tempDir, testLayer } from "../../support/layers.ts"

describe("compareVersions", () => {
  it("orders semantic versions", () => {
    expect(compareVersions("0.3.1", "0.3.0")).toBe(1)
    expect(compareVersions("0.3.0", "0.3.1")).toBe(-1)
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1)
    expect(compareVersions("v2.0.0", "1.99.99")).toBe(1)
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1)
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1)
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1)
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1)
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0)
    expect(compareVersions("latest", "1.0.0")).toBeUndefined()
  })

  it("decides whether an update is available per channel", () => {
    const current = new CurrentBuild({ version: "0.3.0", commit: "abc1234", builtAt: null })
    const release = (version: string, commit: string) =>
      new ReleaseInfo({ version, commit, tag: `server-v${version}`, publishedAt: "", notes: "" })
    expect(isUpdateAvailable("stable", current, release("0.3.1", "abc1234"))).toBe(true)
    expect(isUpdateAvailable("stable", current, release("0.3.0", "def5678"))).toBe(false)
    expect(isUpdateAvailable("stable", current, release("0.2.9", "def5678"))).toBe(false)
    expect(isUpdateAvailable("stable", current, null)).toBe(false)
    expect(isUpdateAvailable("latest", current, release("0.3.0", "def5678"))).toBe(true)
    expect(isUpdateAvailable("latest", current, release("0.3.0", "abc1234"))).toBe(false)
    expect(isUpdateAvailable("latest", current, release("0.3.0", "abc1234ffeeddcc"))).toBe(false)
    expect(isUpdateAvailable("latest", current, release("0.3.0", ""))).toBe(false)
    expect(sameCommit("dev", "abc1234")).toBe(false)
  })
})

interface FakeReleases {
  /** Answers by URL; anything missing is a 404. */
  readonly routes: Map<string, unknown>
  readonly urls: Array<string>
  offline: boolean
}

const fakeReleases = (): FakeReleases => ({ routes: new Map(), urls: [], offline: false })

const githubLatest = "https://api.github.com/repos/fiqryq/weaver-core/releases/latest"

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

const makeClient = (releases: FakeReleases, updateDir: string) => {
  const http = Layer.succeed(UpdateHttp, {
    githubApi: "https://api.github.com",
    fetch: async (url) => {
      releases.urls.push(url)
      if (releases.offline) throw new Error("getaddrinfo ENOTFOUND")
      const body = releases.routes.get(url)
      return body === undefined
        ? new Response("Not Found", { status: 404 })
        : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    }
  })
  const services = testLayer(scriptedModel(() => say("")).layer, tempDir(), { updateDir }).pipe(Layer.provide(http))
  const web = HttpRouter.toWebHandler(
    AppRoutes.pipe(Layer.provide(services), Layer.provide(BunHttpServer.layerHttpServices)),
    { disableLogger: true }
  )
  dispose = web.dispose
  return async (method: string, path: string, body?: unknown) => {
    const response = await web.handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          authorization: "Bearer test-token",
          ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    )
    const text = await response.text()
    return { status: response.status, json: text.length > 0 ? JSON.parse(text) : undefined }
  }
}

/** An update folder the root-side updater has set up. */
const installedUpdater = () => {
  const dir = join(tempDir(), "update")
  mkdirSync(dir)
  writeFileSync(join(dir, updateFiles.marker), "1\n")
  return dir
}

const stableRelease = (releases: FakeReleases, version: string) => {
  const tag = `server-v${version}`
  releases.routes.set(githubLatest, {
    tag_name: tag,
    body: "GitHub's notes",
    published_at: "2026-10-14T09:00:00Z",
    assets: [{ name: "weaver-server-linux-x64" }, { name: "release.json" }]
  })
  releases.routes.set(`${defaultUpdateUrl}/${tag}/release.json`, {
    version,
    commit: "def5678",
    tag,
    publishedAt: "2026-10-14T09:00:00Z",
    notes: "Fixed things."
  })
}

describe("the update API", () => {
  it("adds the build and the update capability to /v1/health", async () => {
    const request = makeClient(fakeReleases(), installedUpdater())
    const health = (await request("GET", "/v1/health")).json
    expect(health).toMatchObject({ status: "ok", version: "0.1.0", commit: "dev", builtAt: null, updates: true })
  })

  it("reports the newest stable release, caches it and refreshes on request", async () => {
    const releases = fakeReleases()
    stableRelease(releases, "0.2.0")
    const request = makeClient(releases, installedUpdater())

    const check = await request("GET", "/v1/update")
    expect(check.status).toBe(200)
    expect(check.json).toMatchObject({
      current: { version: "0.1.0", commit: "dev", builtAt: null },
      channel: "stable",
      latest: {
        version: "0.2.0",
        commit: "def5678",
        tag: "server-v0.2.0",
        publishedAt: "2026-10-14T09:00:00Z",
        notes: "Fixed things."
      },
      available: true,
      checkError: null,
      supported: true,
      status: { state: "idle", message: null, tag: null, updatedAt: null }
    })
    expect(Date.parse(check.json.checkedAt)).not.toBeNaN()

    const fetches = releases.urls.length
    await request("GET", "/v1/update?channel=stable")
    expect(releases.urls.length).toBe(fetches)
    stableRelease(releases, "0.1.0")
    const refreshed = (await request("GET", "/v1/update?channel=stable&refresh=1")).json
    expect(releases.urls.length).toBeGreaterThan(fetches)
    expect(refreshed).toMatchObject({ latest: { version: "0.1.0" }, available: false })
  })

  it("falls back to the GitHub release when it has no release.json", async () => {
    const releases = fakeReleases()
    releases.routes.set(githubLatest, {
      tag_name: "v0.4.0",
      body: "Older release",
      published_at: "2026-09-01T00:00:00Z",
      assets: [{ name: "weaver-server-linux-x64" }]
    })
    const request = makeClient(releases, installedUpdater())
    expect((await request("GET", "/v1/update")).json).toMatchObject({
      latest: { version: "0.4.0", commit: "", tag: "v0.4.0", publishedAt: "2026-09-01T00:00:00Z", notes: "Older release" },
      available: true
    })
  })

  it("compares commits on the latest channel", async () => {
    const releases = fakeReleases()
    releases.routes.set(`${defaultUpdateUrl}/server-latest/release.json`, {
      version: "0.1.0",
      commit: "abc1234",
      tag: "server-latest",
      publishedAt: "2026-10-14T09:00:00Z",
      notes: "Built from main."
    })
    const request = makeClient(releases, installedUpdater())
    expect((await request("GET", "/v1/update?channel=latest")).json).toMatchObject({
      channel: "latest",
      latest: { version: "0.1.0", commit: "abc1234", tag: "server-latest" },
      // The tests run from source, whose commit is "dev".
      available: true
    })
  })

  it("answers with a check error instead of failing when the releases can't be reached", async () => {
    const releases = fakeReleases()
    releases.offline = true
    const request = makeClient(releases, installedUpdater())
    const check = await request("GET", "/v1/update")
    expect(check.status).toBe(200)
    expect(check.json).toMatchObject({ latest: null, available: false, supported: true })
    expect(check.json.checkError).toContain("api.github.com")
    expect((await request("GET", "/v1/update?channel=latest")).json.checkError).toContain("github.com")
    const missing = await request("POST", "/v1/update", { channel: "stable" })
    expect(missing.status).toBe(404)
    expect(missing.json._tag).toBe("NoUpdate")
  })

  it("says updates aren't supported until the updater is installed", async () => {
    const releases = fakeReleases()
    stableRelease(releases, "0.2.0")
    const bare = join(tempDir(), "update")
    mkdirSync(bare)
    const request = makeClient(releases, bare)
    expect((await request("GET", "/v1/update")).json.supported).toBe(false)
    const refused = await request("POST", "/v1/update", { channel: "stable" })
    expect(refused.status).toBe(503)
    expect(refused.json).toMatchObject({ _tag: "UpdatesUnsupported" })
    expect(refused.json.message).toContain("sudo weaver-update")
  })

  it("queues the newest release for the updater and refuses a second request", async () => {
    const releases = fakeReleases()
    stableRelease(releases, "0.2.0")
    const dir = installedUpdater()
    const request = makeClient(releases, dir)

    const queued = await request("POST", "/v1/update", { channel: "stable" })
    expect(queued.status).toBe(202)
    expect(queued.json).toMatchObject({
      channel: "stable",
      latest: { tag: "server-v0.2.0" },
      supported: true,
      status: { state: "requested", tag: "server-v0.2.0", message: null }
    })
    expect(readFileSync(join(dir, updateFiles.request), "utf8")).toBe("server-v0.2.0\n")
    expect((await request("GET", "/v1/update")).json.status.state).toBe("requested")

    const again = await request("POST", "/v1/update", { channel: "stable" })
    expect(again.status).toBe(409)
    expect(again.json._tag).toBe("UpdateInProgress")

    // The updater took the request and is downloading.
    writeFileSync(
      join(dir, updateFiles.status),
      JSON.stringify({ state: "downloading", message: null, tag: "server-v0.2.0", updatedAt: new Date().toISOString() })
    )
    rmSync(join(dir, updateFiles.request))
    expect((await request("GET", "/v1/update")).json.status).toMatchObject({ state: "downloading", tag: "server-v0.2.0" })
    expect((await request("POST", "/v1/update", { channel: "stable", tag: "server-v0.1.9" })).status).toBe(409)

    // It finished (or rolled back): a new request goes through.
    writeFileSync(
      join(dir, updateFiles.status),
      JSON.stringify({ state: "rolled-back", message: "The new server didn't start.", tag: "server-v0.2.0", updatedAt: new Date().toISOString() })
    )
    expect((await request("GET", "/v1/update")).json.status).toMatchObject({
      state: "rolled-back",
      message: "The new server didn't start."
    })
    const pinned = await request("POST", "/v1/update", { channel: "stable", tag: "server-v0.1.9" })
    expect(pinned.status).toBe(202)
    expect(readFileSync(join(dir, updateFiles.request), "utf8")).toBe("server-v0.1.9\n")
  })

  it("refuses when there's nothing newer and checks explicit tags", async () => {
    const releases = fakeReleases()
    stableRelease(releases, "0.1.0")
    const dir = installedUpdater()
    const request = makeClient(releases, dir)
    const none = await request("POST", "/v1/update", { channel: "stable" })
    expect(none.status).toBe(404)
    expect(none.json).toMatchObject({ _tag: "NoUpdate" })
    expect((await request("POST", "/v1/update", { tag: "../etc/passwd" })).status).toBe(400)
    // An explicit tag installs even when it isn't newer (a reinstall or a downgrade).
    expect((await request("POST", "/v1/update", { tag: "server-v0.1.0" })).status).toBe(202)
  })

  it("stops treating stale requests and stuck updates as in progress", async () => {
    const releases = fakeReleases()
    stableRelease(releases, "0.2.0")
    const dir = installedUpdater()
    const request = makeClient(releases, dir)

    writeFileSync(join(dir, updateFiles.request), "server-v0.2.0\n")
    const old = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(join(dir, updateFiles.request), old, old)
    const stale = (await request("GET", "/v1/update")).json.status
    expect(stale).toMatchObject({ state: "failed", tag: "server-v0.2.0" })
    expect(stale.message).toContain("sudo weaver-update")
    expect((await request("POST", "/v1/update", { channel: "stable" })).status).toBe(202)
    expect((await request("GET", "/v1/update")).json.status.state).toBe("requested")

    rmSync(join(dir, updateFiles.request))
    writeFileSync(
      join(dir, updateFiles.status),
      JSON.stringify({ state: "installing", message: null, tag: "server-v0.2.0", updatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() })
    )
    expect((await request("GET", "/v1/update")).json.status.state).toBe("failed")
    expect((await request("POST", "/v1/update", { channel: "stable" })).status).toBe(202)
  })

  it("needs the server token", async () => {
    expect(await fetchWithoutToken()).toBe(401)
  })
})

/** GET /v1/update without a bearer token, through a fresh handler. */
const fetchWithoutToken = async () => {
  const web = HttpRouter.toWebHandler(
    AppRoutes.pipe(
      Layer.provide(testLayer(scriptedModel(() => say("")).layer)),
      Layer.provide(BunHttpServer.layerHttpServices)
    ),
    { disableLogger: true }
  )
  try {
    return (await web.handler(new Request("http://localhost/v1/update"))).status
  } finally {
    await web.dispose()
  }
}
