import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { Context, Effect, Layer, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { AppConfig } from "../../config/Config.ts"
import { decrypt, encrypt, isEncrypted } from "../../platform/lib/crypto.ts"
import { decodeStringArray, decodeStringRecord, newId, nowIso } from "../../platform/lib/util.ts"
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

/**
 * Decodes OAuth data, transparently decrypting if encryption is enabled.
 * Handles migration from plaintext to encrypted storage.
 */
const decodeOAuth = (raw: string, encryptionKey: string): OAuthData => {
  if (!raw || raw === "{}") return {}
  
  try {
    // If encryption is enabled and data looks encrypted, decrypt it first
    if (encryptionKey && isEncrypted(raw)) {
      try {
        const decrypted = decrypt(raw, encryptionKey)
        const parsed: unknown = JSON.parse(decrypted)
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as OAuthData : {}
      } catch {
        // Decryption failed - might be corrupted or wrong key
        // Fall through to try parsing as plaintext
      }
    }
    
    // Try parsing as plaintext (for migration or when encryption is disabled)
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as OAuthData : {}
  } catch {
    return {}
  }
}

/**
 * Encodes OAuth data, encrypting if encryption key is available.
 */
const encodeOAuth = (data: OAuthData, encryptionKey: string): string => {
  const json = JSON.stringify(data)
  if (encryptionKey) {
    try {
      return encrypt(json, encryptionKey)
    } catch {
      // Encryption failed - fall back to plaintext (shouldn't happen with valid key)
      return json
    }
  }
  return json
}

const fromRow = (row: IntegrationRow, encryptionKey: string): Integration => {
  const auth = row.auth === "oauth" ? "oauth" : "none"
  const oauth = decodeOAuth(row.oauth, encryptionKey)
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
      const config = yield* AppConfig
      const encryptionKey = config.encryptionKey
      const writes = Semaphore.makeUnsafe(1)

      const list = sql<IntegrationRow>`SELECT * FROM integrations ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map((row) => fromRow(row, encryptionKey))),
        Effect.orDie
      )

      const getRow = Effect.fn("IntegrationRepo.getRow")(function*(id: string) {
        const rows = yield* sql<IntegrationRow>`SELECT * FROM integrations WHERE id = ${id}`.pipe(Effect.orDie)
        const row = rows[0]
        if (row === undefined) return yield* new IntegrationNotFound({ id })
        return row
      })

      const get = (id: string) => Effect.map(getRow(id), (row) => fromRow(row, encryptionKey))

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
        }`.pipe(Effect.orDie)
        return yield* Effect.orDie(get(id))
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
        yield* sql`UPDATE integrations SET ${sql.update(changes)} WHERE id = ${id}`.pipe(Effect.orDie)
        return yield* get(id)
      }, writes.withPermit)

      const remove = Effect.fn("IntegrationRepo.remove")(function*(id: string) {
        yield* get(id)
        yield* sql`DELETE FROM integrations WHERE id = ${id}`.pipe(Effect.orDie)
      })

      const oauth = (id: string) => Effect.map(getRow(id), (row) => decodeOAuth(row.oauth, encryptionKey))

      const updateOAuth = Effect.fn("IntegrationRepo.updateOAuth")(
        function*(id: string, change: (data: OAuthData) => OAuthData) {
          const current = yield* oauth(id)
          const next = change(current)
          const encoded = encodeOAuth(next, encryptionKey)
          yield* sql`UPDATE integrations SET oauth = ${encoded} WHERE id = ${id}`.pipe(Effect.orDie)
          
          // If we just migrated from plaintext to encrypted (encryption enabled + current was plaintext)
          if (encryptionKey && current !== next) {
            const row = yield* getRow(id)
            // Check if the stored value was plaintext before this update
            if (!isEncrypted(row.oauth)) {
              yield* Effect.logInfo(`Migrated OAuth tokens to encrypted storage for integration ${id}`)
            }
          }
          
          return next
        },
        writes.withPermit
      )

      return IntegrationRepo.of({ list, get, create, update, remove, oauth, updateOAuth })
    })
  )
}
