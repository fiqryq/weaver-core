import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { IntegrationOAuth, signInAgainMessage } from "../../../src/features/integrations/IntegrationOAuth.ts"
import { IntegrationRepo } from "../../../src/features/integrations/IntegrationRepo.ts"
import { McpHub } from "../../../src/features/integrations/McpHub.ts"
import { RunEvents } from "../../../src/features/runs/RunEvents.ts"
import { Toolbox } from "../../../src/features/runs/Toolbox.ts"
import { type FakeOAuthMcp, startFakeOAuthMcp } from "../../support/fixtures/fakeOAuthMcp.ts"
import { createBot, say, scriptedModel, testLayer } from "../../support/layers.ts"
import { type Client, makeClient } from "../teams/support.ts"

const redirect = "http://127.0.0.1:53682/callback"
const otherRedirect = "http://localhost:53999/oauth/done"
const expectedTools = [
  { name: "whoami", description: "Who's signed in" },
  { name: "add", description: "Adds two numbers" }
]

let fake: FakeOAuthMcp
beforeAll(() => {
  fake = startFakeOAuthMcp()
})
afterAll(() => fake.close())

let client: Client | undefined
afterEach(async () => {
  await client?.dispose()
  client = undefined
})

/** Every response the API gave, to check no secret ever leaves the server. */
const recorded: Array<string> = []

const api = async () => {
  client = await makeClient(() => say("ok"))
  const request = client.request
  return async (method: string, path: string, body?: unknown) => {
    const response = await request(method, path, body)
    recorded.push(JSON.stringify(response.json ?? null))
    return response
  }
}

type Request = Awaited<ReturnType<typeof api>>

/** Starts a sign-in, approves it like the browser would and relays the code like the Mac app. */
const signIn = async (request: Request, id: string, redirectUri = redirect) => {
  const started = await request("POST", `/v1/integrations/${id}/oauth/start`, { redirectUri })
  expect(started.status).toBe(200)
  const approved = fake.approve(started.json.authorizationUrl)
  expect(approved.state).toBe(started.json.state)
  expect(approved.redirectUri).toBe(redirectUri)
  return request("POST", `/v1/integrations/${id}/oauth/finish`, { code: approved.code, state: approved.state })
}

const integrationChanged = (id: string) =>
  client!.events.filter((event) => event.type === "integration-changed" && event.integrationId === id).length

describe("OAuth integrations over HTTP", () => {
  it("checks sign-in settings and reports the feature in health", async () => {
    const request = await api()
    expect((await request("GET", "/v1/health")).json).toMatchObject({ oauthIntegrations: true })

    const created = await request("POST", "/v1/integrations", { name: "Fake", transport: "http", url: fake.mcpUrl, auth: "oauth" })
    expect(created.status).toBe(200)
    expect(created.json).toMatchObject({ auth: "oauth", oauthStatus: "signed-out", oauthSignedInAt: null })

    const plain = await request("POST", "/v1/integrations", { name: "Plain", transport: "http", url: "https://example.com/mcp" })
    expect(plain.json).toMatchObject({ auth: "none", oauthStatus: null, oauthSignedInAt: null })

    const invalid = async (body: Record<string, unknown>) => {
      const response = await request("POST", "/v1/integrations", { name: "Bad", auth: "oauth", ...body })
      expect(response.status).toBe(400)
      return response.json.message
    }
    expect(await invalid({ transport: "stdio", command: "npx" })).toBe("Sign-in only works with HTTP MCP servers.")
    expect(await invalid({ transport: "http", url: "http://example.com/mcp" })).toBe("Sign-in needs an https:// URL.")
    expect(await invalid({ transport: "http", url: "nope" })).toBe("Enter the MCP server's URL.")
    expect((await request("POST", "/v1/integrations", { name: "Bad", transport: "http", url: "x", auth: "token" })).status)
      .toBe(400)

    const stdio = await request("POST", "/v1/integrations", { name: "Local", transport: "stdio", command: "npx" })
    const patched = await request("PATCH", `/v1/integrations/${stdio.json.id}`, { auth: "oauth" })
    expect(patched.status).toBe(400)
    expect(patched.json.message).toBe("Sign-in only works with HTTP MCP servers.")
    const switched = await request("PATCH", `/v1/integrations/${plain.json.id}`, { auth: "oauth" })
    expect(switched.json).toMatchObject({ auth: "oauth", oauthStatus: "signed-out" })
  })

  it("signs in through a loopback redirect, refreshes, signs out and forgets the sign-in when the URL changes", async () => {
    const request = await api()
    const id = (await request("POST", "/v1/integrations", { name: "Fake", transport: "http", url: fake.mcpUrl, auth: "oauth" }))
      .json.id
    const plain = (await request("POST", "/v1/integrations", { name: "Plain", transport: "http", url: fake.mcpUrl })).json
    const start = (redirectUri: string, target = id) =>
      request("POST", `/v1/integrations/${target}/oauth/start`, { redirectUri })

    for (const bad of ["https://example.com/callback", "http://192.168.1.2:5000/cb", "http://127.0.0.1/callback", "nope"]) {
      const response = await start(bad)
      expect(response.status).toBe(400)
      expect(response.json.message).toBe("The redirect has to go to this Mac (127.0.0.1)")
    }
    expect((await start(redirect, plain.id)).json.message).toBe("Plain doesn't use sign-in.")
    expect((await start(redirect, "missing")).status).toBe(404)
    expect(fake.registrations).toHaveLength(0)

    const registered = fake.registrations.length
    const first = await start(redirect)
    expect(first.status).toBe(200)
    expect(first.json.authorizationUrl).toMatch(new RegExp(`^${fake.url}/authorize\\?`))
    expect(first.json.state).toEqual(expect.any(String))
    const firstUrl = new URL(first.json.authorizationUrl)
    expect(Object.fromEntries(firstUrl.searchParams)).toMatchObject({
      response_type: "code",
      code_challenge_method: "S256",
      redirect_uri: redirect,
      state: first.json.state,
      resource: fake.mcpUrl
    })
    expect(fake.registrations).toHaveLength(registered + 1)
    expect(fake.registrations.at(-1)).toMatchObject({
      client_name: "Weaver",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_uri: "https://github.com/fiqryq/weaver-core"
    })

    const second = await start(redirect)
    expect(fake.registrations).toHaveLength(registered + 1)
    expect(second.json.state).not.toBe(first.json.state)
    expect(new URL(second.json.authorizationUrl).searchParams.get("client_id")).toBe(firstUrl.searchParams.get("client_id"))

    const finish = (code: string, state: string) => request("POST", `/v1/integrations/${id}/oauth/finish`, { code, state })
    const replaced = fake.approve(first.json.authorizationUrl)
    expect((await finish(replaced.code, replaced.state)).json.message).toBe("This sign-in expired or was replaced. Try again.")
    const approved = fake.approve(second.json.authorizationUrl)
    expect((await finish(approved.code, "wrong")).status).toBe(400)
    expect((await finish("bad-code", approved.state)).json.message).toBe("Fake didn't accept the sign-in: Unknown or used code")

    const before = Date.now()
    const done = await finish(fake.approve(second.json.authorizationUrl).code, approved.state)
    expect(done.status).toBe(200)
    expect(done.json).toEqual({ ok: true, tools: expectedTools, error: null })
    const signedIn = (await request("GET", "/v1/integrations")).json.find((integration: { id: string }) => integration.id === id)
    expect(signedIn).toMatchObject({ auth: "oauth", oauthStatus: "signed-in" })
    expect(Date.parse(signedIn.oauthSignedInAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(Object.keys(signedIn).sort()).toEqual([
      "args", "auth", "command", "createdAt", "enabled", "env", "headers", "id", "name", "oauthSignedInAt", "oauthStatus",
      "presetId", "transport", "updatedAt", "url"
    ])
    expect((await finish("again", approved.state)).json.message).toBe("This sign-in expired or was replaced. Try again.")
    await waitForEvents(id, 1)

    expect((await request("POST", `/v1/integrations/${id}/test`)).json).toEqual({ ok: true, tools: expectedTools, error: null })
    fake.expireAccessTokens()
    const refreshes = fake.refreshes
    expect((await request("POST", `/v1/integrations/${id}/test`)).json.ok).toBe(true)
    expect(fake.refreshes).toBe(refreshes + 1)

    // Signed in with a refresh token, starting again just refreshes.
    expect((await start(redirect)).json).toEqual({ authorizationUrl: null, state: null })

    // Another redirect needs a registration made for it.
    const moved = await start(otherRedirect)
    expect(fake.registrations).toHaveLength(registered + 2)
    expect(fake.registrations.at(-1)!.redirect_uris).toEqual([otherRedirect])
    expect(new URL(moved.json.authorizationUrl).searchParams.get("client_id")).toBe(fake.registrations.at(-1)!.client_id)
    const movedApproval = fake.approve(moved.json.authorizationUrl)
    expect((await finish(movedApproval.code, movedApproval.state)).json.ok).toBe(true)

    const signOut = await request("DELETE", `/v1/integrations/${id}/oauth`)
    expect(signOut.status).toBe(204)
    expect((await request("GET", `/v1/integrations`)).json.find((i: { id: string }) => i.id === id).oauthStatus).toBe("signed-out")
    await waitForEvents(id, 3)
    expect((await request("DELETE", `/v1/integrations/${plain.id}/oauth`)).json.message).toBe("Plain doesn't use sign-in.")

    const quiet = fake.requests.length
    expect((await request("POST", `/v1/integrations/${id}/test`)).json).toEqual({ ok: false, tools: [], error: "Sign in to Fake first." })
    const draft = await request("POST", "/v1/integrations/test", { name: "Draft", transport: "http", url: fake.mcpUrl, auth: "oauth" })
    expect(draft.json).toEqual({ ok: false, tools: [], error: "Sign in to Draft first." })
    expect(fake.requests.length).toBe(quiet)

    // Signing out keeps the registration.
    const again = await start(otherRedirect)
    expect(fake.registrations).toHaveLength(registered + 2)
    const againApproval = fake.approve(again.json.authorizationUrl)
    expect((await finish(againApproval.code, againApproval.state)).json.ok).toBe(true)

    const renamed = await request("PATCH", `/v1/integrations/${id}`, { name: "Fake Renamed" })
    expect(renamed.json.oauthStatus).toBe("signed-in")
    const relocated = await request("PATCH", `/v1/integrations/${id}`, { url: `${fake.mcpUrl}?workspace=2` })
    expect(relocated.json).toMatchObject({ oauthStatus: "signed-out", oauthSignedInAt: null })
    await start(otherRedirect)
    expect(fake.registrations).toHaveLength(registered + 3)

    const responses = recorded.join("\n")
    expect(fake.issued.length).toBeGreaterThan(0)
    for (const token of fake.issued) expect(responses).not.toContain(token)
    expect(responses).not.toMatch(/codeVerifier|code_verifier|clientInformation|refresh_token|access_token/)
  })
})

const waitForEvents = async (id: string, count: number) => {
  const deadline = Date.now() + 5000
  while (integrationChanged(id) < count) {
    if (Date.now() > deadline) throw new Error(`Expected ${count} integration-changed events, got ${integrationChanged(id)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(integrationChanged(id)).toBe(count)
}

/** Signs an integration in through the service, approving like the browser. */
const signInDirectly = (id: string) =>
  Effect.gen(function*() {
    const oauth = yield* IntegrationOAuth
    const started = yield* oauth.start(id, redirect)
    const approved = fake.approve(started.authorizationUrl!)
    return yield* oauth.finish(id, approved.code, approved.state)
  })

describe("OAuth integrations at runtime", () => {
  it.live("gives bots the tools with the token, refreshes it, and asks for a new sign-in when refreshing fails", () => {
    const model = scriptedModel(() => say("ok"))
    return Effect.gen(function*() {
      const integrations = yield* IntegrationRepo
      const oauth = yield* IntegrationOAuth
      const hub = yield* McpHub
      const toolbox = yield* Toolbox
      const integration = yield* integrations.create({ name: "Fake", transport: "http", url: fake.mcpUrl, auth: "oauth" })
      const bot = yield* createBot({ name: "Ada", integrationIds: [integration.id] })

      const notYet = yield* toolbox.forBot(bot)
      expect(notYet.tools).toHaveLength(0)
      expect(notYet.unavailable).toEqual([`Fake (${signInAgainMessage("Fake")})`])

      expect((yield* signInDirectly(integration.id)).oauthStatus).toBe("signed-in")
      const initializes = fake.initializes
      const tools = yield* toolbox.forBot(bot)
      expect(tools.tools.map((tool) => tool.name)).toEqual(["fake__whoami", "fake__add"])
      expect(tools.unavailable).toEqual([])
      const whoami = tools.tools[0]!
      expect(yield* whoami.run({})).toBe("signed in as ada")
      expect(yield* tools.tools[1]!.run({ a: 2, b: 3 })).toBe("5")

      const firstTokens = (yield* integrations.oauth(integration.id)).tokens
      fake.expireAccessTokens()
      const refreshes = fake.refreshes
      expect(yield* whoami.run({})).toBe("signed in as ada")
      expect(fake.refreshes).toBe(refreshes + 1)
      const refreshed = (yield* integrations.oauth(integration.id)).tokens
      expect(refreshed?.access_token).not.toBe(firstTokens?.access_token)
      // The connection stays open across the refresh: the key doesn't change with tokens.
      expect(oauth.config(yield* integrations.get(integration.id)).key).toBe(oauth.config(integration).key)
      expect(fake.initializes).toBe(initializes + 1)

      const events = yield* RunEvents
      const changed = yield* events.subscribe().pipe(
        Stream.filter((event) => event.type === "integration-changed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.sleep("20 millis")
      fake.revokeRefresh()
      fake.expireAccessTokens()
      const failure = yield* Effect.flip(hub.call(oauth.config(integration), "whoami", {}))
      expect(failure.message).toBe("Fake needs you to sign in again. Open Weaver › Settings › Apps and click Sign In.")
      expect(yield* Fiber.join(changed)).toEqual([{ type: "integration-changed", integrationId: integration.id }])
      const signedOut = yield* integrations.get(integration.id)
      expect(signedOut.oauthStatus).toBe("signed-out")
      expect((yield* integrations.oauth(integration.id)).tokens).toBeUndefined()

      const quiet = fake.requests.length
      const after = yield* toolbox.forBot(bot)
      expect(after.tools).toHaveLength(0)
      expect(after.unavailable).toEqual([`Fake (${signInAgainMessage("Fake")})`])
      expect(fake.requests.length).toBe(quiet)
    }).pipe(Effect.provide(testLayer(model.layer)))
  }, 20_000)

  it.live("turns down a sign-in that expired", () => {
    const model = scriptedModel(() => say("ok"))
    return Effect.gen(function*() {
      const integrations = yield* IntegrationRepo
      const oauth = yield* IntegrationOAuth
      const integration = yield* integrations.create({ name: "Fake", transport: "http", url: fake.mcpUrl, auth: "oauth" })
      const started = yield* oauth.start(integration.id, redirect)
      const pending = (yield* integrations.oauth(integration.id)).pending!
      expect(pending.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000)
      expect(pending.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000)
      yield* integrations.updateOAuth(integration.id, (data) => ({ ...data, pending: { ...pending, expiresAt: Date.now() - 1 } }))
      const approved = fake.approve(started.authorizationUrl!)
      const error = yield* Effect.flip(oauth.finish(integration.id, approved.code, approved.state))
      expect(error.message).toBe("This sign-in expired or was replaced. Try again.")
      expect((yield* integrations.get(integration.id)).oauthStatus).toBe("signed-out")
    }).pipe(Effect.provide(testLayer(model.layer)))
  }, 20_000)
})
