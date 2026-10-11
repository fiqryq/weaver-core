import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { decodeStringArray, decodeStringRecord, newId, nowIso } from "../../platform/lib/util.ts"
import {
  Integration,
  type IntegrationCreate,
  IntegrationNotFound,
  type IntegrationUpdate,
  mergeSecrets
} from "./Integration.ts"

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
  readonly created_at: string
  readonly updated_at: string
}

const fromRow = (row: IntegrationRow): Integration =>
  new Integration({
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })

/** Stored integrations with their real secrets. The API layer masks them on the way out. */
export class IntegrationRepo extends Context.Service<IntegrationRepo, {
  readonly list: Effect.Effect<ReadonlyArray<Integration>>
  get(id: string): Effect.Effect<Integration, IntegrationNotFound>
  create(input: IntegrationCreate): Effect.Effect<Integration>
  update(id: string, input: IntegrationUpdate): Effect.Effect<Integration, IntegrationNotFound>
  remove(id: string): Effect.Effect<void, IntegrationNotFound>
}>()("weaver/IntegrationRepo") {
  static readonly layer = Layer.effect(
    IntegrationRepo,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const list = sql<IntegrationRow>`SELECT * FROM integrations ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.orDie
      )

      const get = Effect.fn("IntegrationRepo.get")(function*(id: string) {
        const rows = yield* sql<IntegrationRow>`SELECT * FROM integrations WHERE id = ${id}`.pipe(Effect.orDie)
        const row = rows[0]
        if (row === undefined) return yield* new IntegrationNotFound({ id })
        return fromRow(row)
      })

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
        yield* sql`UPDATE integrations SET ${sql.update(changes)} WHERE id = ${id}`.pipe(Effect.orDie)
        return yield* get(id)
      })

      const remove = Effect.fn("IntegrationRepo.remove")(function*(id: string) {
        yield* get(id)
        yield* sql`DELETE FROM integrations WHERE id = ${id}`.pipe(Effect.orDie)
      })

      return IntegrationRepo.of({ list, get, create, update, remove })
    })
  )
}
