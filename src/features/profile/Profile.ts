import { Schema } from "effect"

/** Who the bots work for. The Mac app sends this so prompts can address the person by name and in their timezone. */
export class Profile extends Schema.Class<Profile>("Profile")({
  displayName: Schema.String,
  email: Schema.String,
  timezone: Schema.String
}) {}

export const ProfileUpdate = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String)
})
export type ProfileUpdate = typeof ProfileUpdate.Type

export class Health extends Schema.Class<Health>("Health")({
  status: Schema.Literal("ok"),
  version: Schema.String,
  /** Short git SHA the server was built from; `dev` when it runs from source. */
  commit: Schema.optional(Schema.String),
  /** When the server was built (ISO-8601); null when it runs from source. */
  builtAt: Schema.optional(Schema.NullOr(Schema.String)),
  memory: Schema.Boolean,
  /** Whether the selected browser engine can be used right now. */
  browser: Schema.Boolean,
  browserEngine: Schema.optional(Schema.Literals(["camofox", "playwright", "none"])),
  /** web_search and web_fetch, which work without a browser. */
  web: Schema.optional(Schema.Boolean),
  uptimeSeconds: Schema.optional(Schema.Number),
  /** Bots can ask their teammates for help (`teammateIds`, handoff conversations). */
  handoffs: Schema.optional(Schema.Boolean),
  /** The shared skills library (`/v1/skills`, `Bot.librarySkills`). */
  skillsLibrary: Schema.optional(Schema.Boolean),
  /** Memory projects, each project's knowledge graph and note history (`/v1/memory`, `Bot.memoryProject`). */
  memoryApi: Schema.optional(Schema.Boolean),
  /** Teams of bots with a manager, a room and a private chat (`/v1/teams`). */
  teams: Schema.optional(Schema.Boolean),
  /** Integrations can sign in to hosted MCP servers (`auth: "oauth"`, `/v1/integrations/:id/oauth`). */
  oauthIntegrations: Schema.optional(Schema.Boolean),
  /** The server can check for and install its own updates (`/v1/update`). */
  updates: Schema.optional(Schema.Boolean),
  /** Bytes free for the server on the data folder's filesystem. */
  dataDirFreeBytes: Schema.optional(Schema.Number)
}) {}
