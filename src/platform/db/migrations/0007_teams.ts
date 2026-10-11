import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Teams of bots led by a manager, with their room and private chat. */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT '',
      manager_bot_id TEXT NOT NULL,
      members TEXT NOT NULL DEFAULT '[]',
      parent_team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      room_conversation_id TEXT NOT NULL,
      private_conversation_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      task TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  yield* sql`CREATE INDEX teams_parent ON teams (parent_team_id)`
  yield* sql`ALTER TABLE conversations ADD COLUMN team_id TEXT`
})
