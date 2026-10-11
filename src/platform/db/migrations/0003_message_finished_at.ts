import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/**
 * When a reply reached done, error or cancelled, in server time, so clients can tell which replies
 * finished since they last synced. Replies finished before this migration use their creation time.
 */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE messages ADD COLUMN finished_at TEXT`
  yield* sql`
    UPDATE messages SET finished_at = created_at
    WHERE role = 'assistant' AND status IN ('done', 'error', 'cancelled')
  `
})
