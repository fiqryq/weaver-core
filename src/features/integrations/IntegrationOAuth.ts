import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import { InvalidClientError, OAuthError, UnauthorizedClientError } from "@modelcontextprotocol/sdk/server/auth/errors.js"
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { Clock, Context, Duration, Effect, Layer } from "effect"
import { BadRequest } from "../../platform/http/errors.ts"
import { nowIso, truncate } from "../../platform/lib/util.ts"
import { RunEvents } from "../runs/RunEvents.ts"
import { type Integration, IntegrationNotFound, OAuthStart } from "./Integration.ts"
import { isLoopbackRedirect, toMcpConfig } from "./integrationConfig.ts"
import { type OAuthData, type PendingSignIn, IntegrationRepo } from "./IntegrationRepo.ts"
import { type McpAuthProvider, type McpServerConfig, SignInRequired } from "./McpHub.ts"

export const signInAgainMessage = (name: string) =>
  `${name} needs you to sign in again. Open Weaver › Settings › Apps and click Sign In.`

export const signInFirstMessage = (name: string) => `Sign in to ${name} first.`

const pendingLifetime = Duration.minutes(10)
const discoveryTimeout = Duration.seconds(30)
/** Only used to fill in client metadata when the server re-registers on its own; that sign-in is never finished. */
const placeholderRedirect = "http://127.0.0.1/callback"

const clientMetadata = (redirectUri: string): OAuthClientMetadata => ({
  client_name: "Weaver",
  redirect_uris: [redirectUri],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  client_uri: "https://github.com/fiqryq/weaver-core"
})

const randomState = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

const describe = (cause: unknown): string => {
  const message = cause instanceof OAuthError
    ? cause.message || cause.errorCode
    : cause instanceof Error
    ? cause.message
    : String(cause)
  return truncate(message, 300)
}

const withoutRegistration = ({ clientInformation: _, redirectUri: __, tokens: ___, ...rest }: OAuthData): OAuthData =>
  rest
const withoutTokens = ({ tokens: _, ...rest }: OAuthData): OAuthData => rest
const withoutPending = ({ pending: _, ...rest }: OAuthData): OAuthData => rest

/**
 * - `use`: bots' calls; a needed sign-in marks the integration signed out instead of opening a browser.
 * - `start`: captures the authorization URL and PKCE verifier for the Mac to open.
 * - `finish`: exchanges the code with the pending sign-in's verifier and redirect.
 */
type Mode =
  | { readonly _tag: "use" }
  | { readonly _tag: "start"; readonly redirectUri: string; readonly state: string }
  | { readonly _tag: "finish"; readonly pending: PendingSignIn }

type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>

/** The SDK's view of one integration's OAuth data. Every call reads what's stored, since tokens change on refresh. */
class IntegrationAuthProvider implements McpAuthProvider {
  /** The registration's redirect as last read, for the SDK's synchronous getters. */
  private storedRedirect: string | undefined
  authorizationUrl: URL | undefined
  verifier: string | undefined

  constructor(
    private readonly id: string,
    private readonly mode: Mode,
    private readonly run: Run,
    private readonly repo: IntegrationRepo["Service"],
    private readonly events: RunEvents["Service"]
  ) {}

  private async read(): Promise<OAuthData> {
    const data = await this.run(this.repo.oauth(this.id))
    this.storedRedirect = data.redirectUri
    return data
  }

  private change(change: (data: OAuthData) => OAuthData): Promise<OAuthData> {
    return this.run(this.repo.updateOAuth(this.id, change))
  }

  get redirectUrl(): string {
    switch (this.mode._tag) {
      case "start":
        return this.mode.redirectUri
      case "finish":
        return this.mode.pending.redirectUri
      case "use":
        return this.storedRedirect ?? placeholderRedirect
    }
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadata(this.redirectUrl)
  }

  state(): string {
    return this.mode._tag === "start" ? this.mode.state : randomState()
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.read()).clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const redirectUri = this.redirectUrl
    await this.change((data) => ({ ...data, clientInformation, redirectUri }))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (this.mode._tag === "finish") {
      const signedInAt = await this.run(nowIso)
      await this.change((data) => ({ ...withoutPending(data), tokens, signedInAt }))
      return
    }
    // A refresh that lands after signing out doesn't sign back in.
    await this.change((data) => (data.tokens === undefined ? data : { ...data, tokens }))
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.verifier = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    if (this.mode._tag === "finish") return this.mode.pending.codeVerifier
    if (this.verifier !== undefined) return this.verifier
    throw new Error("No sign-in is in progress.")
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.mode._tag === "start") {
      this.authorizationUrl = authorizationUrl
      return
    }
    throw await this.signInRequired()
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    // Finishing retries the same code, so the provider's own error is what's reported.
    if (this.mode._tag === "finish") return
    switch (scope) {
      case "all":
      case "client":
        await this.change(withoutRegistration)
        return
      case "tokens":
        await this.change(withoutTokens)
        return
      case "verifier":
        await this.change(withoutPending)
        return
      case "discovery":
        return
    }
  }

  async signInRequired(): Promise<SignInRequired> {
    const integration = await this.run(this.repo.get(this.id))
    await this.change(withoutTokens)
    await this.run(this.events.publish({ type: "integration-changed", integrationId: this.id }))
    return new SignInRequired(signInAgainMessage(integration.name))
  }
}

/** Signs integrations with `auth: "oauth"` in to their hosted MCP servers, with the Mac relaying the browser step. */
export class IntegrationOAuth extends Context.Service<IntegrationOAuth, {
  /** The MCP settings for an integration, with its OAuth provider when it signs in. */
  config(integration: Integration): McpServerConfig
  /** Discovers and registers if needed, answering the URL to open, or nulls when the stored sign-in works. */
  start(id: string, redirectUri: string): Effect.Effect<OAuthStart, IntegrationNotFound | BadRequest>
  /** Exchanges the code from the browser for tokens, answering the signed-in integration. */
  finish(id: string, code: string, state: string): Effect.Effect<Integration, IntegrationNotFound | BadRequest>
  /** Forgets the tokens and any pending sign-in, keeping the client registration. */
  signOut(id: string): Effect.Effect<void, IntegrationNotFound | BadRequest>
}>()("weaver/IntegrationOAuth") {
  static readonly layer = Layer.effect(
    IntegrationOAuth,
    Effect.gen(function*() {
      const repo = yield* IntegrationRepo
      const events = yield* RunEvents
      const run: Run = Effect.runPromiseWith(yield* Effect.context<never>())
      const providers = new Map<string, IntegrationAuthProvider>()

      const provider = (id: string, mode: Mode) => new IntegrationAuthProvider(id, mode, run, repo, events)
      const changed = (id: string) => events.publish({ type: "integration-changed", integrationId: id })

      const oauthIntegration = Effect.fn("IntegrationOAuth.oauthIntegration")(function*(id: string) {
        const integration = yield* repo.get(id)
        if (integration.auth !== "oauth") {
          return yield* new BadRequest({ message: `${integration.name} doesn't use sign-in.` })
        }
        return integration
      })

      const config = (integration: Integration) => {
        if (integration.auth !== "oauth") return toMcpConfig(integration)
        let shared = providers.get(integration.id)
        if (shared === undefined) {
          shared = provider(integration.id, { _tag: "use" })
          providers.set(integration.id, shared)
        }
        return toMcpConfig(integration, shared)
      }

      const start = Effect.fn("IntegrationOAuth.start")(function*(id: string, redirectUri: string) {
        const integration = yield* oauthIntegration(id)
        if (!isLoopbackRedirect(redirectUri)) {
          return yield* new BadRequest({ message: "The redirect has to go to this Mac (127.0.0.1)" })
        }
        // A registration only accepts the redirects it was made for.
        yield* repo.updateOAuth(id, (data) =>
          data.clientInformation !== undefined && data.redirectUri !== redirectUri ? withoutRegistration(data) : data)
        const state = randomState()
        const starting = provider(id, { _tag: "start", redirectUri, state })
        const result = yield* Effect.tryPromise({
          try: () => auth(starting, { serverUrl: integration.url }),
          catch: (cause) => new BadRequest({ message: `${integration.name} doesn't support automatic sign-in: ${describe(cause)}` })
        }).pipe(
          Effect.timeoutOrElse({
            duration: discoveryTimeout,
            orElse: () => Effect.fail(new BadRequest({ message: `${integration.name} didn't answer in time. Try again.` }))
          })
        )
        if (result === "AUTHORIZED") return new OAuthStart({ authorizationUrl: null, state: null })
        const authorizationUrl = starting.authorizationUrl
        const codeVerifier = starting.verifier
        if (authorizationUrl === undefined || codeVerifier === undefined) {
          return yield* Effect.die(new Error("The sign-in started without an authorization URL."))
        }
        const expiresAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(pendingLifetime)
        yield* repo.updateOAuth(id, (data) => ({ ...data, pending: { state, codeVerifier, redirectUri, expiresAt } }))
        return new OAuthStart({ authorizationUrl: authorizationUrl.href, state })
      })

      const finish = Effect.fn("IntegrationOAuth.finish")(function*(id: string, code: string, state: string) {
        const integration = yield* oauthIntegration(id)
        const pending = (yield* repo.oauth(id)).pending
        const now = yield* Clock.currentTimeMillis
        if (pending === undefined || pending.state !== state || pending.expiresAt <= now) {
          return yield* new BadRequest({ message: "This sign-in expired or was replaced. Try again." })
        }
        yield* Effect.tryPromise({
          try: () => auth(provider(id, { _tag: "finish", pending }), { serverUrl: integration.url, authorizationCode: code }),
          catch: (cause) => cause
        }).pipe(
          Effect.timeoutOrElse({
            duration: discoveryTimeout,
            orElse: () => Effect.fail(new Error(`${integration.name} didn't answer in time.`))
          }),
          Effect.catch((cause) =>
            Effect.andThen(
              cause instanceof InvalidClientError || cause instanceof UnauthorizedClientError
                ? repo.updateOAuth(id, withoutRegistration)
                : Effect.void,
              Effect.fail(new BadRequest({ message: `${integration.name} didn't accept the sign-in: ${describe(cause)}` }))
            )
          )
        )
        yield* changed(id)
        return yield* repo.get(id)
      })

      const signOut = Effect.fn("IntegrationOAuth.signOut")(function*(id: string) {
        yield* oauthIntegration(id)
        yield* repo.updateOAuth(id, (data) => withoutPending(withoutTokens(data)))
        yield* changed(id)
      })

      return IntegrationOAuth.of({ config, start, finish, signOut })
    })
  )
}
