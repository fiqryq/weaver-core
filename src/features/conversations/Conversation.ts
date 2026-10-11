import { Schema } from "effect"

export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})
export type TextPart = typeof TextPart.Type

export const ApprovalState = Schema.Literals(["pending", "approved", "denied"])
export type ApprovalState = typeof ApprovalState.Type

export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  /** Short human label, e.g. "Ran `ls -la`". */
  title: Schema.String,
  params: Schema.Unknown,
  /** Set when the call needed the person's approval. */
  approval: Schema.optional(ApprovalState),
  approvalId: Schema.optional(Schema.String)
})
export type ToolCallPart = typeof ToolCallPart.Type

export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  output: Schema.String,
  isFailure: Schema.Boolean,
  /** On `ask_bot` results: the bot-to-bot conversation the teammate answered in. */
  handoffConversationId: Schema.optional(Schema.String)
})
export type ToolResultPart = typeof ToolResultPart.Type

/** Something the bot saved for later (a skill or a memory) in a review after the reply finished. */
export const LearnedPart = Schema.Struct({
  type: Schema.Literal("learned"),
  /** e.g. `Created skill "deploy-checks"` or `Added to Core Memory`. */
  text: Schema.String
})
export type LearnedPart = typeof LearnedPart.Type

export const ReportKind = Schema.Literals(["decision", "summary", "question", "brief"])
export type ReportKind = typeof ReportKind.Type

/**
 * A team's report: decisions, summaries and questions in the team's private chat, briefs in its room.
 * Shown as a card; models see it as text.
 */
export const ReportPart = Schema.Struct({
  type: Schema.Literal("report"),
  kind: ReportKind,
  teamId: Schema.String,
  title: Schema.NullOr(Schema.String),
  text: Schema.String
})
export type ReportPart = typeof ReportPart.Type

export const MessagePart = Schema.Union([TextPart, ToolCallPart, ToolResultPart, LearnedPart, ReportPart])
export type MessagePart = typeof MessagePart.Type

export const MessageRole = Schema.Literals(["user", "assistant"])
export type MessageRole = typeof MessageRole.Type

export const MessageStatus = Schema.Literals(["streaming", "done", "error", "cancelled"])
export type MessageStatus = typeof MessageStatus.Type

export class Message extends Schema.Class<Message>("Message")({
  id: Schema.String,
  conversationId: Schema.String,
  /** Increases with every message on the server; use it as the `after` cursor. */
  seq: Schema.Int,
  role: MessageRole,
  botId: Schema.NullOr(Schema.String),
  senderName: Schema.String,
  parts: Schema.Array(MessagePart),
  replyQuote: Schema.NullOr(Schema.String),
  hidden: Schema.Boolean,
  status: MessageStatus,
  error: Schema.NullOr(Schema.String),
  providerId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  promptTokens: Schema.Int,
  completionTokens: Schema.Int,
  createdAt: Schema.String,
  /**
   * When a reply reached done, error or cancelled, in server time; null while streaming and for the
   * person's own messages. Later updates (like learned parts from a review) don't move it.
   */
  finishedAt: Schema.NullOr(Schema.String)
}) {}

/** The visible reply text: every text part, joined. */
export const messageText = (parts: ReadonlyArray<MessagePart>): string =>
  parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim()

/**
 * `handoff`: one bot asking a teammate for help with `ask_bot`; the person can watch but not reply.
 * `team-room`: a team's manager and members working together; the person can watch but not post.
 * `team-private`: the person and a team's manager, where the person gives the team its tasks.
 */
export const ConversationKind = Schema.Literals(["chat", "handoff", "team-room", "team-private"])
export type ConversationKind = typeof ConversationKind.Type

export class Conversation extends Schema.Class<Conversation>("Conversation")({
  id: Schema.String,
  title: Schema.String,
  botIds: Schema.Array(Schema.String),
  kind: ConversationKind,
  /** The asking bot of a handoff; null for chats. */
  requesterBotId: Schema.NullOr(Schema.String),
  /** The team of a team room or private chat; null otherwise. */
  teamId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

export const ConversationCreate = Schema.Struct({
  title: Schema.optional(Schema.String),
  botIds: Schema.Array(Schema.String).check(Schema.isMinLength(1))
})
export type ConversationCreate = typeof ConversationCreate.Type

export const ConversationUpdate = Schema.Struct({
  title: Schema.optional(Schema.String),
  botIds: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1)))
})
export type ConversationUpdate = typeof ConversationUpdate.Type

export const SendMessage = Schema.Struct({
  text: Schema.String,
  replyQuote: Schema.optional(Schema.String),
  /** Choice answers are sent hidden: the bot sees them, the chat shows the picked card instead. */
  hidden: Schema.optional(Schema.Boolean)
})
export type SendMessage = typeof SendMessage.Type

export class SendResult extends Schema.Class<SendResult>("SendResult")({
  runId: Schema.String,
  message: Message
}) {}

export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()("ConversationNotFound", {
  id: Schema.String
}, { httpApiStatus: 404 }) {}

export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()("MessageNotFound", {
  id: Schema.String
}, { httpApiStatus: 404 }) {}
