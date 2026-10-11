import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import {
  Conversation,
  ConversationCreate,
  ConversationNotFound,
  ConversationUpdate,
  Message,
  MessageNotFound,
  SendMessage,
  SendResult
} from "./Conversation.ts"

const IdParams = { id: Schema.String }

export class ConversationsApi extends HttpApiGroup.make("conversations")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(Conversation) }),
    HttpApiEndpoint.get("get", "/:id", { params: IdParams, success: Conversation, error: ConversationNotFound }),
    HttpApiEndpoint.post("create", "/", { payload: ConversationCreate, success: Conversation, error: BadRequest }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: IdParams,
      payload: ConversationUpdate,
      success: Conversation,
      error: [ConversationNotFound, BadRequest]
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: IdParams,
      success: HttpApiSchema.NoContent,
      error: ConversationNotFound
    }),
    HttpApiEndpoint.get("messages", "/:id/messages", {
      params: IdParams,
      query: { after: Schema.optional(Schema.NumberFromString) },
      success: Schema.Array(Message),
      error: ConversationNotFound
    }),
    HttpApiEndpoint.delete("clearMessages", "/:id/messages", {
      params: IdParams,
      success: HttpApiSchema.NoContent,
      error: ConversationNotFound
    }),
    HttpApiEndpoint.delete("removeMessage", "/:id/messages/:messageId", {
      params: { id: Schema.String, messageId: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [ConversationNotFound, MessageNotFound]
    }),
    HttpApiEndpoint.post("send", "/:id/messages", {
      params: IdParams,
      payload: SendMessage,
      success: SendResult,
      error: [ConversationNotFound, BadRequest]
    }),
    HttpApiEndpoint.post("regenerate", "/:id/regenerate", {
      params: IdParams,
      success: Schema.Struct({ runId: Schema.String }),
      error: [ConversationNotFound, BadRequest, Conflict]
    }),
    HttpApiEndpoint.post("cancel", "/:id/cancel", {
      params: IdParams,
      success: HttpApiSchema.NoContent,
      error: ConversationNotFound
    })
  )
  .middleware(Authorization)
  .prefix("/v1/conversations")
{}
