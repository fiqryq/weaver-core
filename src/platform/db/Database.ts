import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "../../config/Config.ts"
import { migrations } from "./migrations/index.ts"

const ForeignKeys = Layer.effectDiscard(
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql`PRAGMA foreign_keys = ON`)
)

const MigratorLayer = Layer.merge(
  SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) }),
  ForeignKeys
)

/** SQLite in the data directory, migrated before anything else touches it. */
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AppConfig
    mkdirSync(config.dataDir, { recursive: true })
    return MigratorLayer.pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: join(config.dataDir, "weaver.db") }))
    )
  })
)

export const DatabaseTest = MigratorLayer.pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))
)
