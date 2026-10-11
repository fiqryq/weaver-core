import { Schema } from "effect"

/** Built-in capabilities a bot can be given. Integrations (MCP servers) are listed separately. */
export const BuiltinTool = Schema.Literals(["shell", "files", "browser", "web", "memory", "skills"])
export type BuiltinTool = typeof BuiltinTool.Type

/** What a bot gets when it's created without a tool list. */
export const defaultTools: ReadonlyArray<BuiltinTool> = ["shell", "files", "browser", "web", "memory", "skills"]

/**
 * How shell commands and file writes are handled:
 * `auto` runs them, `ask` waits for the person to approve each one, `off` doesn't offer them.
 */
export const ApprovalMode = Schema.Literals(["auto", "ask", "off"])
export type ApprovalMode = typeof ApprovalMode.Type

export const defaultSystemPrompt = `You are a helpful teammate with your own computer (a Linux VPS). Keep replies short and conversational.
When you need the user to pick between options, ask the question and then list each option on its own line as \`- [ ] Option\`.`

export const defaultMaxSteps = 25

export class Bot extends Schema.Class<Bot>("Bot")({
  id: Schema.String,
  name: Schema.String,
  label: Schema.String,
  systemPrompt: Schema.String,
  /** Empty uses the default provider. */
  providerId: Schema.String,
  /** Empty uses the provider's default model. */
  model: Schema.String,
  mascotId: Schema.String,
  colorHex: Schema.String,
  symbol: Schema.String,
  tools: Schema.Array(BuiltinTool),
  approvalMode: ApprovalMode,
  maxSteps: Schema.Int,
  integrationIds: Schema.Array(Schema.String),
  /** Bots it can ask for help with `ask_bot`. */
  teammateIds: Schema.Array(Schema.String),
  /** Skills from the shared library it can use, by name. */
  librarySkills: Schema.Array(Schema.String),
  /** Basic Memory project its memory lives in; empty uses the shared one. */
  memoryProject: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

export const BotCreate = Schema.Struct({
  name: Schema.NonEmptyString,
  label: Schema.optional(Schema.String),
  systemPrompt: Schema.optional(Schema.String),
  providerId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  mascotId: Schema.optional(Schema.String),
  colorHex: Schema.optional(Schema.String),
  symbol: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(BuiltinTool)),
  approvalMode: Schema.optional(ApprovalMode),
  maxSteps: Schema.optional(Schema.Int),
  integrationIds: Schema.optional(Schema.Array(Schema.String)),
  teammateIds: Schema.optional(Schema.Array(Schema.String)),
  librarySkills: Schema.optional(Schema.Array(Schema.String)),
  memoryProject: Schema.optional(Schema.String)
})
export type BotCreate = typeof BotCreate.Type

export const BotUpdate = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  label: Schema.optional(Schema.String),
  systemPrompt: Schema.optional(Schema.String),
  providerId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  mascotId: Schema.optional(Schema.String),
  colorHex: Schema.optional(Schema.String),
  symbol: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(BuiltinTool)),
  approvalMode: Schema.optional(ApprovalMode),
  maxSteps: Schema.optional(Schema.Int),
  integrationIds: Schema.optional(Schema.Array(Schema.String)),
  teammateIds: Schema.optional(Schema.Array(Schema.String)),
  librarySkills: Schema.optional(Schema.Array(Schema.String)),
  memoryProject: Schema.optional(Schema.String)
})
export type BotUpdate = typeof BotUpdate.Type

export class BotNotFound extends Schema.TaggedError<BotNotFound>()("BotNotFound", {
  id: Schema.String
}, { httpApiStatus: 404 }) {}
