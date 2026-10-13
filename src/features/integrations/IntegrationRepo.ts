import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { Context, Effect, Layer, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { decodeStringArray, decodeStringRecord, newId, nowIso, orDieWithLog } from "../../platform/lib/util.ts"
import {
  Integration,
  type IntegrationCreate,
  IntegrationNotFound,
  type IntegrationUpdate,
  mergeSecrets
} from "./Integration.ts"

/** A sign-in that was started and waits for the browser to come back with a code. */
export interface PendingSignIn {
  readonly state: string
  readonly codeVerifier: string
  readonly redirectUri: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
}

/** What an OAuth integration keeps between sign-ins. Never sent to clients. */
export interface OAuthData {
  readonly clientInformation?: OAuthClientInformationMixed
  /** The redirect URI the client registration was made for. */
  readonly redirectUri?: string
  readonly tokens?: OAuthTokens
  readonly pending?: PendingSignIn
  readonly signedInAt?: string
}

interface IntegrationRow {
  readonly id: string
  readonly name: string
  readonly preset_id: string | null
  readonly transport: string
  readonly command: string
  readonly args: string
  readonly env: string
  readonly url: string
  readonly headers: string
  readonly enabled: number
  readonly auth: string
  readonly oauth: string
  readonly created_at: string
  readonly updated_at: string
}

const decodeOAuth = (raw: string): OAuthData => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as OAuthData : {}
  } catch {
    return {}
  }
}

const fromRow = (row: IntegrationRow): Integration => {
  const auth = row.auth === "oauth" ? "oauth" : "none"
  const oauth = decodeOAuth(row.oauth)
  return new Integration({
    id: row.id,
    name: row.name,
    presetId: row.preset_id,
    transport: row.transport === "http" ? "http" : "stdio",
    command: row.command,
    args: decodeStringArray(row.args),
    env: decodeStringRecord(row.env),
    url: row.url,
    headers: decodeStringRecord(row.headers),
    enabled: row.enabled === 1,
    auth,
    oauthStatus: auth === "oauth" ? (oauth.tokens !== undefined ? "signed-in" : "signed-out") : null,
    oauthSignedInAt: oauth.signedInAt ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

/** Stored integrations with their real secrets. The API layer masks them on the way out. */
export class IntegrationRepo extends Context.Service<IntegrationRepo, {
  readonly list: Effect.Effect<ReadonlyArray<Integration>>
  get(id: string): Effect.Effect<Integration, IntegrationNotFound>
  create(input: IntegrationCreate): Effect.Effect<Integration>
  /** Changing the URL or `auth` forgets the OAuth data, so it signs in again. */
  update(id: string, input: IntegrationUpdate): Effect.Effect<Integration, IntegrationNotFound>
  remove(id: string): Effect.Effect<void, IntegrationNotFound>
  oauth(id: string): Effect.Effect<OAuthData, IntegrationNotFound>
  /** Applies `change` to the stored OAuth data atomically and returns the result. */
  updateOAuth(id: string, change: (data: OAuthData) => OAuthData): Effect.Effect<OAuthData, IntegrationNotFound>
}>()("weaver/IntegrationRepo") {
  static readonly layer = Layer.effect(
    IntegrationRepo,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writes = Semaphore.makeUnsafe(1)

      const list = sql<IntegrationRow>`SELECT * FROM integrations ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map(fromRow)),
        orDieWithLog
      )

      const getRow = Effect.fn("IntegrationRepo.getRow")(function*(id: string) {
        const rows = yield* sql<IntegrationRow>`SELECT * FROM integrations WHERE id = ${id}`.pipe(orDieWithLog)
        const row = rows[0]
        if (row === undefined) return yield* new IntegrationNotFound({ id })
        return row
      })

      const get = (id: string) => Effect.map(getRow(id), fromRow)

      const create = Effect.fn("IntegrationRepo.create")(function*(input: IntegrationCreate) {
        const id = newId()
        const now = yield* nowIso
        yield* sql`INSERT INTO integrations ${
          sql.insert({
            id,
            name: input.name.trim(),
            preset_id: input.presetId ?? null,
            transport: input.transport,
            command: input.command ?? "",
            args: JSON.stringify(input.args ?? []),
            env: JSON.stringify(input.env ?? {}),
            url: input.url ?? "",
            headers: JSON.stringify(input.headers ?? {}),
            enabled: input.enabled === false ? 0 : 1,
            auth: input.auth ?? "none",
            oauth: "{}",
            created_at: now,
            updated_at: now
          })
        }`.pipe(orDieWithLog)
        return yield* orDieWithLog(get(id))
      })

      const update = Effect.fn("IntegrationRepo.update")(function*(id: string, input: IntegrationUpdate) {
        const current = yield* get(id)
        const changes: Record<string, string | number> = { updated_at: yield* nowIso }
        if (input.name !== undefined) changes.name = input.name.trim()
        if (input.transport !== undefined) changes.transport = input.transport
        if (input.command !== undefined) changes.command = input.command
        if (input.args !== undefined) changes.args = JSON.stringify(input.args)
        if (input.env !== undefined) changes.env = JSON.stringify(mergeSecrets(current.env, input.env))
        if (input.url !== undefined) changes.url = input.url
        if (input.headers !== undefined) changes.headers = JSON.stringify(mergeSecrets(current.headers, input.headers))
        if (input.enabled !== undefined) changes.enabled = input.enabled ? 1 : 0
        if (input.auth !== undefined) changes.auth = input.auth
        const urlChanged = input.url !== undefined && input.url !== current.url
        const authChanged = input.auth !== undefined && input.auth !== current.auth
        if (urlChanged || authChanged) changes.oauth = "{}"
        yield* sql`UPDATE integrations SET ${sql.update(changes)} WHERE id = ${id}`.pipe(orDieWithLog)
        return yield* get(id)
      }, writes.withPermit)

      const remove = Effect.fn("IntegrationRepo.remove")(function*(id: string) {
        yield* get(id)
        yield* sql`DELETE FROM integrations WHERE id = ${id}`.pipe(orDieWithLog)
      })

      const oauth = (id: string) => Effect.map(getRow(id), (row) => decodeOAuth(row.oauth))

      const updateOAuth = Effect.fn("IntegrationRepo.updateOAuth")(
        function*(id: string, change: (data: OAuthData) => OAuthData) {
          const next = change(yield* oauth(id))
          yield* sql`UPDATE integrations SET oauth = ${JSON.stringify(next)} WHERE id = ${id}`.pipe(orDieWithLog)
          return next
        },
        writes.withPermit
      )

      return IntegrationRepo.of({ list, get, create, update, remove, oauth, updateOAuth })
    })
  )
}
