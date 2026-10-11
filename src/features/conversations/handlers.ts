import { Effect } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import { nowIso } from "../../platform/lib/util.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import { AgentRunner } from "../runs/AgentRunner.ts"
import { RunEvents } from "../runs/RunEvents.ts"
import { MessageNotFound, SendResult } from "./Conversation.ts"
import { ConversationRepo } from "./ConversationRepo.ts"

/**
 * Adds the server's clock, read before `effect` runs, as `X-Weaver-Now`, so clients can remember
 * how far they've synced in server time (compare with `Message.finishedAt`).
 */
const withServerNow = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(nowIso, (now) =>
    HttpEffect.withPreResponseHandler(
      effect,
      (_request, response) => Effect.succeed(HttpServerResponse.setHeader(response, "x-weaver-now", now))
    ))

export const ConversationsHandlers = HttpApiBuilder.group(
  Api,
  "conversations",
  Effect.fn(function*(handlers) {
    const conversations = yield* ConversationRepo
    const bots = yield* BotRepo
    const runner = yield* AgentRunner
    const events = yield* RunEvents

    const checkBots = (ids: ReadonlyArray<string> | undefined) =>
      Effect.gen(function*() {
        if (ids === undefined) return
        const known = new Set((yield* bots.list).map((bot) => bot.id))
        const unknown = ids.filter((id) => !known.has(id))
        if (unknown.length > 0) return yield* new BadRequest({ message: `Unknown bot: ${unknown.join(", ")}` })
      })

    return handlers
      .handle("list", () => withServerNow(conversations.list))
      .handle("get", ({ params }) => conversations.get(params.id))
      .handle("create", ({ payload }) =>
        Effect.andThen(
          checkBots(payload.botIds),
          conversations.create({ title: payload.title ?? "", botIds: payload.botIds })
        ))
      .handle("update", ({ params, payload }) =>
        Effect.andThen(checkBots(payload.botIds), conversations.update(params.id, payload)))
      .handle("remove", ({ params }) =>
        Effect.andThen(runner.cancelConversation(params.id), conversations.remove(params.id)))
      .handle("messages", ({ params, query }) =>
        withServerNow(Effect.andThen(conversations.get(params.id), conversations.messages(params.id, query.after))))
      .handle("clearMessages", ({ params }) =>
        Effect.gen(function*() {
          yield* conversations.get(params.id)
          yield* runner.cancelConversation(params.id)
          const messages = yield* conversations.messages(params.id)
          yield* conversations.deleteMessages(messages.map((message) => message.id))
        }))
      .handle("removeMessage", ({ params }) =>
        Effect.gen(function*() {
          yield* conversations.get(params.id)
          const message = yield* conversations.getMessage(params.messageId)
          if (message === undefined || message.conversationId !== params.id) {
            return yield* new MessageNotFound({ id: params.messageId })
          }
          yield* conversations.deleteMessages([message.id])
        }))
      .handle("send", ({ params, payload }) =>
        Effect.gen(function*() {
          yield* conversations.get(params.id)
          const text = payload.text.trim()
          if (text.length === 0) return yield* new BadRequest({ message: "The message is empty." })
          const message = yield* conversations.insertMessage({
            conversationId: params.id,
            role: "user",
            parts: [{ type: "text", text }],
            replyQuote: payload.replyQuote ?? null,
            hidden: payload.hidden ?? false
          })
          yield* events.publish({ type: "message-created", conversationId: params.id, message })
          const runId = yield* runner.start(params.id)
          return new SendResult({ runId, message })
        }))
      .handle("regenerate", ({ params }) =>
        Effect.gen(function*() {
          yield* conversations.get(params.id)
          if (yield* runner.isRunning(params.id)) {
            return yield* new Conflict({ message: "The bots are still replying." })
          }
          const messages = yield* conversations.messages(params.id)
          const lastUser = messages.findLastIndex((message) => message.role === "user")
          if (lastUser === -1) return yield* new BadRequest({ message: "There's nothing to regenerate yet." })
          const latest = messages.slice(lastUser + 1).filter((message) => message.role === "assistant")
          yield* conversations.deleteMessages(latest.map((message) => message.id))
          return { runId: yield* runner.start(params.id) }
        }))
      .handle("cancel", ({ params }) =>
        Effect.andThen(conversations.get(params.id), runner.cancelConversation(params.id)))
  })
)
