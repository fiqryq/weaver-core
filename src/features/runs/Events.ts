import { Schema } from "effect"
import { Message, ToolCallPart, ToolResultPart } from "../conversations/Conversation.ts"

/**
 * Everything streamed over `/v1/events`. Clients that reconnect, or fall too far behind to be sent
 * every event (see `RunEvents`), catch up from the messages endpoint first.
 */
export const RunEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("run-started"),
    runId: Schema.String,
    conversationId: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("message-created"),
    conversationId: Schema.String,
    message: Message
  }),
  Schema.Struct({
    type: Schema.Literal("text-delta"),
    conversationId: Schema.String,
    messageId: Schema.String,
    delta: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    conversationId: Schema.String,
    messageId: Schema.String,
    part: ToolCallPart
  }),
  Schema.Struct({
    type: Schema.Literal("tool-result"),
    conversationId: Schema.String,
    messageId: Schema.String,
    part: ToolResultPart
  }),
  Schema.Struct({
    type: Schema.Literal("approval-requested"),
    conversationId: Schema.String,
    messageId: Schema.String,
    approvalId: Schema.String,
    part: ToolCallPart
  }),
  Schema.Struct({
    type: Schema.Literal("approval-resolved"),
    conversationId: Schema.String,
    messageId: Schema.String,
    approvalId: Schema.String,
    approved: Schema.Boolean
  }),
  Schema.Struct({
    type: Schema.Literal("activity"),
    conversationId: Schema.String,
    /** e.g. "Checking memory"; empty clears it. */
    text: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("message-done"),
    conversationId: Schema.String,
    message: Message
  }),
  Schema.Struct({
    type: Schema.Literal("run-finished"),
    runId: Schema.String,
    conversationId: Schema.String,
    status: Schema.Literals(["done", "cancelled", "error"])
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    conversationId: Schema.String,
    message: Schema.String
  }),
  /** A bot's skills were added, changed, used or removed; not tied to a conversation. */
  Schema.Struct({
    type: Schema.Literal("skills-changed"),
    botId: Schema.String
  }),
  /** The shared skills library, or which bots use its skills, changed. */
  Schema.Struct({
    type: Schema.Literal("skill-library-changed")
  }),
  /** A team was created, changed, deleted, or its status or task changed; not tied to a conversation. */
  Schema.Struct({
    type: Schema.Literal("team-changed"),
    teamId: Schema.String
  }),
  /** An integration signed in, signed out, or needs the person to sign in again. */
  Schema.Struct({
    type: Schema.Literal("integration-changed"),
    integrationId: Schema.String
  })
])
export type RunEvent = typeof RunEvent.Type
