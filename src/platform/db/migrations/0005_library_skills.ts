import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** The shared library skills each bot can use. */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE bots ADD COLUMN library_skills TEXT NOT NULL DEFAULT '[]'`
})
