import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Bots' teammates, and the bot-to-bot conversations they answer each other in. */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE bots ADD COLUMN teammate_ids TEXT NOT NULL DEFAULT '[]'`
  yield* sql`ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'`
  yield* sql`ALTER TABLE conversations ADD COLUMN requester_bot_id TEXT`
  yield* sql`CREATE INDEX conversations_handoff ON conversations (requester_bot_id) WHERE kind = 'handoff'`
})
