import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/**
 * The text parts of a message row's `parts` JSON, joined like `messageText`. Rows whose `parts`
 * aren't a JSON array of objects index nothing instead of failing the statement.
 */
const textOf = (row: string) =>
  `(SELECT trim(group_concat(json_extract(value, '$.text'), char(10) || char(10))) ` +
  `FROM json_each(CASE WHEN json_valid(${row}.parts) THEN CASE WHEN json_type(${row}.parts) = 'array' THEN ${row}.parts END END) ` +
  `WHERE CASE WHEN type = 'object' THEN json_extract(value, '$.type') END = 'text')`

/**
 * Full-text index over message text for `session_search`. Rows are keyed by `messages.seq`
 * (the FTS rowid) and kept in sync by triggers, so every write path (including cascading
 * deletes of conversations and bots) updates it. Only finished messages are indexed.
 */
export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE VIRTUAL TABLE message_search USING fts5(text, tokenize = 'porter unicode61')`

  yield* sql.unsafe(`
    CREATE TRIGGER message_search_insert AFTER INSERT ON messages
    WHEN NEW.status = 'done'
    BEGIN
      INSERT INTO message_search (rowid, text)
      SELECT NEW.seq, text FROM (SELECT ${textOf("NEW")} AS text) WHERE text IS NOT NULL AND text != '';
    END
  `)

  yield* sql.unsafe(`
    CREATE TRIGGER message_search_update AFTER UPDATE OF parts, status ON messages
    WHEN NEW.status = 'done' OR OLD.status = 'done'
    BEGIN
      DELETE FROM message_search WHERE rowid = OLD.seq;
      INSERT INTO message_search (rowid, text)
      SELECT NEW.seq, text FROM (SELECT ${textOf("NEW")} AS text)
      WHERE NEW.status = 'done' AND text IS NOT NULL AND text != '';
    END
  `)

  yield* sql`
    CREATE TRIGGER message_search_delete AFTER DELETE ON messages
    BEGIN
      DELETE FROM message_search WHERE rowid = OLD.seq;
    END
  `

  yield* sql.unsafe(`
    INSERT INTO message_search (rowid, text)
    SELECT seq, text FROM (SELECT seq, ${textOf("messages")} AS text FROM messages WHERE status = 'done')
    WHERE text IS NOT NULL AND text != ''
  `)
})
