import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Each bot's memory project, and earlier versions of memory notes. */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE bots ADD COLUMN memory_project TEXT NOT NULL DEFAULT ''`
  yield* sql`
    CREATE TABLE memory_versions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      permalink TEXT NOT NULL,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content TEXT NOT NULL,
      checksum TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      restored_from TEXT,
      note_updated_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`
  yield* sql`CREATE INDEX memory_versions_note ON memory_versions (project, permalink, created_at)`
})
