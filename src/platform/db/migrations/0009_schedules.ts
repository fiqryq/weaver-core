import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Tasks a bot repeats in a conversation on an interval, e.g. "scrape remote jobs every 5 hours". */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      every_minutes INTEGER NOT NULL,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      created_at TEXT NOT NULL
    )`
  yield* sql`CREATE INDEX schedules_next_run ON schedules (next_run_at)`
  yield* sql`CREATE INDEX schedules_conversation ON schedules (conversation_id)`
})
