/**
 * A hosted MCP server behind OAuth for tests: protected resource and authorization server metadata,
 * dynamic client registration, a token endpoint (authorization code with PKCE S256, refresh) and a
 * Streamable HTTP MCP endpoint that answers 401 without a valid bearer token. The browser step is
 * `approve`, which checks the authorization URL like the real consent page would and mints a code.
 */

interface Registration {
  readonly client_id: string
  readonly client_name?: string
  readonly redirect_uris: ReadonlyArray<string>
  readonly grant_types?: ReadonlyArray<string>
  readonly response_types?: ReadonlyArray<string>
  readonly token_endpoint_auth_method?: string
  readonly client_uri?: string
}

interface Grant {
  readonly clientId: string
  readonly user: string
}

interface PendingCode extends Grant {
  readonly redirectUri: string
  readonly challenge: string
  readonly resource: string | null
}

export interface FakeRequest {
  readonly method: string
  readonly path: string
}

const tools = [
  { name: "whoami", description: "Who's signed in", inputSchema: { type: "object", properties: {} } },
  {
    name: "add",
    description: "Adds two numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } }
  }
]

const sha256 = async (text: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("base64url")

const tokenError = (error: string, description: string) =>
  Response.json({ error, error_description: description }, { status: 400 })

export const startFakeOAuthMcp = () => {
  const requests: Array<FakeRequest> = []
  const registrations: Array<Registration> = []
  const codes = new Map<string, PendingCode>()
  const accessTokens = new Map<string, Grant & { expiresAt: number }>()
  const refreshTokens = new Map<string, Grant>()
  /** Every token handed out, to check none of them leaks through the API. */
  const issued: Array<string> = []
  let counter = 0
  let refreshes = 0
  let initializes = 0
  let failRefresh = false

  const next = (prefix: string) => `${prefix}-${++counter}-${crypto.randomUUID()}`

  const issueTokens = (grant: Grant) => {
    const access = next("access")
    const refresh = next("refresh")
    accessTokens.set(access, { ...grant, expiresAt: Date.now() + 60_000 })
    refreshTokens.set(refresh, grant)
    issued.push(access, refresh)
    return Response.json({ access_token: access, token_type: "Bearer", expires_in: 60, refresh_token: refresh })
  }

  const handleToken = async (request: Request) => {
    const form = new URLSearchParams(await request.text())
    const clientId = form.get("client_id") ?? ""
    if (!registrations.some((registration) => registration.client_id === clientId)) {
      return Response.json({ error: "invalid_client", error_description: "Unknown client" }, { status: 401 })
    }
    if (form.get("grant_type") === "authorization_code") {
      const code = codes.get(form.get("code") ?? "")
      codes.delete(form.get("code") ?? "")
      if (code === undefined || code.clientId !== clientId) return tokenError("invalid_grant", "Unknown or used code")
      if (code.redirectUri !== form.get("redirect_uri")) return tokenError("invalid_grant", "Redirect URI mismatch")
      if (await sha256(form.get("code_verifier") ?? "") !== code.challenge) {
        return tokenError("invalid_grant", "PKCE verification failed")
      }
      if (code.resource !== form.get("resource")) return tokenError("invalid_target", "Resource mismatch")
      return issueTokens(code)
    }
    if (form.get("grant_type") === "refresh_token") {
      refreshes++
      const grant = refreshTokens.get(form.get("refresh_token") ?? "")
      if (failRefresh || grant === undefined || grant.clientId !== clientId) {
        return tokenError("invalid_grant", "Refresh token revoked")
      }
      refreshTokens.delete(form.get("refresh_token") ?? "")
      return issueTokens(grant)
    }
    return tokenError("unsupported_grant_type", "Unsupported grant")
  }

  const handleMcp = async (request: Request, base: string) => {
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
    const grant = accessTokens.get(bearer)
    if (grant === undefined || grant.expiresAt <= Date.now()) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }
      })
    }
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const message = await request.json() as { id?: number | string; method: string; params?: Record<string, unknown> }
    if (message.id === undefined) return new Response(null, { status: 202 })
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result })
    switch (message.method) {
      case "initialize":
        initializes++
        return reply({
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-hosted", version: "1.0.0" }
        })
      case "tools/list":
        return reply({ tools })
      case "tools/call": {
        const args = (message.params?.arguments ?? {}) as { a?: number; b?: number }
        const text = message.params?.name === "add" ? String((args.a ?? 0) + (args.b ?? 0)) : `signed in as ${grant.user}`
        return reply({ content: [{ type: "text", text }] })
      }
      case "ping":
        return reply({})
      default:
        return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
    }
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      const base = url.origin
      requests.push({ method: request.method, path: url.pathname })
      switch (url.pathname) {
        case "/.well-known/oauth-protected-resource":
        case "/.well-known/oauth-protected-resource/mcp":
          return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] })
        case "/.well-known/oauth-authorization-server":
          return Response.json({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"]
          })
        case "/register": {
          const metadata = await request.json() as Omit<Registration, "client_id">
          if (!Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length === 0) {
            return Response.json({ error: "invalid_redirect_uri" }, { status: 400 })
          }
          const registration = { ...metadata, client_id: next("client") }
          registrations.push(registration)
          return Response.json({ ...registration, client_id_issued_at: Math.floor(Date.now() / 1000) }, { status: 201 })
        }
        case "/token":
          return handleToken(request)
        case "/mcp":
          return handleMcp(request, base)
        default:
          return new Response("Not found", { status: 404 })
      }
    }
  })

  const url = `http://127.0.0.1:${server.port}`

  /** What the consent page does: checks the request and answers the code the browser is redirected with. */
  const approve = (authorizationUrl: string, user = "ada") => {
    const request = new URL(authorizationUrl)
    const param = (name: string) => {
      const value = request.searchParams.get(name)
      if (value === null) throw new Error(`The authorization URL has no ${name}`)
      return value
    }
    if (`${request.origin}${request.pathname}` !== `${url}/authorize`) throw new Error(`Unexpected endpoint ${request.href}`)
    if (param("response_type") !== "code") throw new Error("response_type must be code")
    if (param("code_challenge_method") !== "S256") throw new Error("PKCE must use S256")
    const clientId = param("client_id")
    const redirectUri = param("redirect_uri")
    const registration = registrations.find((candidate) => candidate.client_id === clientId)
    if (registration === undefined) throw new Error(`Unknown client ${clientId}`)
    if (!registration.redirect_uris.includes(redirectUri)) throw new Error(`${redirectUri} isn't registered`)
    if (param("resource") !== `${url}/mcp`) throw new Error(`Unexpected resource ${param("resource")}`)
    const code = next("code")
    codes.set(code, { clientId, user, redirectUri, challenge: param("code_challenge"), resource: param("resource") })
    return { code, state: param("state"), redirectUri, clientId }
  }

  return {
    url,
    mcpUrl: `${url}/mcp`,
    requests,
    registrations,
    issued,
    approve,
    get refreshes() {
      return refreshes
    },
    get initializes() {
      return initializes
    },
    /** Every access token handed out so far stops working, as if it expired. */
    expireAccessTokens: () => {
      for (const grant of accessTokens.values()) grant.expiresAt = 0
    },
    /** Refreshing answers `invalid_grant`, as when the person revoked access. */
    revokeRefresh: () => {
      failRefresh = true
    },
    close: () => server.stop(true)
  }
}

export type FakeOAuthMcp = ReturnType<typeof startFakeOAuthMcp>
