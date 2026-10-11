import { Effect, Option } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { AppConfig } from "../../config/Config.ts"
import { Api } from "../../platform/http/Api.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import { nowIso } from "../../platform/lib/util.ts"
import { Camofox } from "../../tools/builtin/Camofox.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import { AgentRunner } from "../runs/AgentRunner.ts"
import { RunEvents } from "../runs/RunEvents.ts"
import { TeamRepo } from "../teams/TeamRepo.ts"
import { type Conversation, MessageNotFound, SendResult } from "./Conversation.ts"
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
    const config = yield* AppConfig
    const camofox = yield* Camofox
    const teams = yield* TeamRepo

    const closeTabs = (conversationId: string, botIds: ReadonlyArray<string>) =>
      config.browser === "camofox" ? camofox.closeConversation(conversationId, botIds) : Effect.void

    const checkBots = (ids: ReadonlyArray<string> | undefined) =>
      Effect.gen(function*() {
        if (ids === undefined) return
        const known = new Set((yield* bots.list).map((bot) => bot.id))
        const unknown = ids.filter((id) => !known.has(id))
        if (unknown.length > 0) return yield* new BadRequest({ message: `Unknown bot: ${unknown.join(", ")}` })
      })

    /** The manager the person instructs a team through: the top-level team's. */
    const instructedManager = (teamId: string | null) =>
      Effect.gen(function*() {
        const team = teamId === null ? undefined : Option.getOrUndefined(yield* Effect.option(teams.get(teamId)))
        const top = team?.parentTeamId == null ? team : Option.getOrUndefined(yield* Effect.option(teams.get(team.parentTeamId)))
        const manager = top === undefined ? undefined : Option.getOrUndefined(yield* Effect.option(bots.get(top.managerBotId)))
        return manager?.name ?? "the team's manager"
      })

    const notWatchOnly = (conversation: Conversation, action: string) =>
      Effect.gen(function*() {
        if (conversation.kind === "handoff") {
          return yield* new Conflict({ message: `You can watch handoffs but not ${action} in them.` })
        }
        if (conversation.kind === "team-room") {
          const manager = yield* instructedManager(conversation.teamId)
          return yield* new Conflict({
            message: `You can watch the team room but not post in it. Give instructions to ${manager} in your private chat.`
          })
        }
      })

    const isTeamConversation = (conversation: Conversation) =>
      conversation.kind === "team-room" || conversation.kind === "team-private"

    return handlers
      .handle("list", () => withServerNow(conversations.list))
      .handle("get", ({ params }) => conversations.get(params.id))
      .handle("create", ({ payload }) =>
        Effect.andThen(
          checkBots(payload.botIds),
          conversations.create({ title: payload.title ?? "", botIds: payload.botIds })
        ))
      .handle("update", ({ params, payload }) =>
        Effect.gen(function*() {
          const conversation = yield* conversations.get(params.id)
          if (conversation.kind === "handoff" && payload.botIds !== undefined) {
            return yield* new BadRequest({ message: "A handoff keeps the two bots it's between." })
          }
          if (isTeamConversation(conversation) && payload.botIds !== undefined) {
            return yield* new BadRequest({ message: "A team's conversations follow its members; change the team instead." })
          }
          yield* checkBots(payload.botIds)
          return yield* conversations.update(params.id, payload)
        }))
      .handle("remove", ({ params }) =>
        Effect.gen(function*() {
          const conversation = yield* Effect.option(conversations.get(params.id))
          if (Option.isSome(conversation) && isTeamConversation(conversation.value)) {
            return yield* new Conflict({ message: "This conversation belongs to a team; delete the team instead." })
          }
          yield* runner.whileStopped(params.id, conversations.remove(params.id))
          if (Option.isSome(conversation)) yield* closeTabs(params.id, conversation.value.botIds)
        }))
      .handle("messages", ({ params, query }) =>
        withServerNow(Effect.andThen(conversations.get(params.id), conversations.messages(params.id, query.after))))
      .handle("clearMessages", ({ params }) =>
        Effect.gen(function*() {
          const conversation = yield* conversations.get(params.id)
          yield* runner.whileStopped(
            params.id,
            Effect.flatMap(conversations.messages(params.id), (messages) =>
              conversations.deleteMessages(messages.map((message) => message.id)))
          )
          yield* closeTabs(params.id, conversation.botIds)
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
          yield* notWatchOnly(yield* conversations.get(params.id), "reply")
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
          yield* notWatchOnly(yield* conversations.get(params.id), "regenerate replies")
          if (yield* runner.isRunning(params.id)) {
            return yield* new Conflict({ message: "The bots are still replying." })
          }
          const messages = yield* conversations.messages(params.id)
          const lastUser = messages.findLastIndex((message) => message.role === "user")
          if (lastUser === -1) return yield* new BadRequest({ message: "There's nothing to regenerate yet." })
          // A team's reports in its private chat aren't the manager's reply; they stay.
          const latest = messages.slice(lastUser + 1).filter((message) =>
            message.role === "assistant" && !message.parts.some((part) => part.type === "report")
          )
          yield* conversations.deleteMessages(latest.map((message) => message.id))
          return { runId: yield* runner.start(params.id) }
        }))
      .handle("cancel", ({ params }) =>
        Effect.andThen(conversations.get(params.id), runner.cancelConversation(params.id)))
  })
)
