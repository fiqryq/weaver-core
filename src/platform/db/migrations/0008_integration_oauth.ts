import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Sign-in for hosted MCP servers: `oauth` holds the client registration, tokens and a pending sign-in as JSON. */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE integrations ADD COLUMN auth TEXT NOT NULL DEFAULT 'none'`
  yield* sql`ALTER TABLE integrations ADD COLUMN oauth TEXT NOT NULL DEFAULT '{}'`
})
