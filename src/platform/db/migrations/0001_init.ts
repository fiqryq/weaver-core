import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      mascot_id TEXT NOT NULL DEFAULT '',
      color_hex TEXT NOT NULL DEFAULT '#EC5BA8',
      symbol TEXT NOT NULL DEFAULT 'sparkle',
      tools TEXT NOT NULL DEFAULT '[]',
      approval_mode TEXT NOT NULL DEFAULT 'ask',
      max_steps INTEGER NOT NULL DEFAULT 25,
      integration_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE conversation_bots (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, bot_id)
    )
  `

  yield* sql`
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      bot_id TEXT,
      sender_name TEXT NOT NULL DEFAULT '',
      parts TEXT NOT NULL DEFAULT '[]',
      reply_quote TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'done',
      error TEXT,
      provider_id TEXT,
      model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX messages_conversation ON messages (conversation_id, seq)`

  yield* sql`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE integrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      preset_id TEXT,
      transport TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      args TEXT NOT NULL DEFAULT '[]',
      env TEXT NOT NULL DEFAULT '{}',
      url TEXT NOT NULL DEFAULT '',
      headers TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `
})
