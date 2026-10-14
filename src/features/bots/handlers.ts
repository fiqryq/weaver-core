import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AppConfig } from "../../config/Config.ts"
import { Api } from "../../platform/http/Api.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import { BotUsers, isValidBotId } from "../../platform/os/BotUsers.ts"
import { Camofox } from "../../tools/builtin/Camofox.ts"
import { handoffTitle } from "../../tools/builtin/AskBot.ts"
import { ConversationRepo } from "../conversations/ConversationRepo.ts"
import { IntegrationRepo } from "../integrations/IntegrationRepo.ts"
import { LibraryStore } from "../learning/library/LibraryStore.ts"
import { SelfReview } from "../learning/review/SelfReview.ts"
import { SkillStore } from "../learning/skills/SkillStore.ts"
import { AgentRunner } from "../runs/AgentRunner.ts"
import { RunEvents } from "../runs/RunEvents.ts"
import { ScheduleRepo } from "../schedules/ScheduleRepo.ts"
import { TeamRepo } from "../teams/TeamRepo.ts"
import { TeamSessions } from "../teams/TeamSessions.ts"
import { BotRepo } from "./BotRepo.ts"

export const BotsHandlers = HttpApiBuilder.group(
  Api,
  "bots",
  Effect.fn(function*(handlers) {
    const config = yield* AppConfig
    const bots = yield* BotRepo
    const conversations = yield* ConversationRepo
    const integrations = yield* IntegrationRepo
    const skills = yield* SkillStore
    const selfReview = yield* SelfReview
    const runner = yield* AgentRunner
    const botUsers = yield* BotUsers
    const camofox = yield* Camofox
    const library = yield* LibraryStore
    const events = yield* RunEvents
    const teams = yield* TeamRepo
    const teamSessions = yield* TeamSessions
    const schedules = yield* ScheduleRepo

    const checkIntegrations = (ids: ReadonlyArray<string> | undefined) =>
      Effect.gen(function*() {
        if (ids === undefined) return
        const known = new Set((yield* integrations.list).map((integration) => integration.id))
        const unknown = ids.filter((id) => !known.has(id))
        if (unknown.length > 0) return yield* new BadRequest({ message: `Unknown integration: ${unknown.join(", ")}` })
      })

    const checkTeammates = (ids: ReadonlyArray<string> | undefined, botId?: string) =>
      Effect.gen(function*() {
        if (ids === undefined) return
        if (botId !== undefined && ids.includes(botId)) {
          return yield* new BadRequest({ message: "A bot can't be its own teammate." })
        }
        const known = new Set((yield* bots.list).map((bot) => bot.id))
        const unknown = ids.filter((id) => !known.has(id))
        if (unknown.length > 0) return yield* new BadRequest({ message: `Unknown teammate: ${unknown.join(", ")}` })
      })

    /** Names already on the bot are let through, so a skill removed from the library doesn't block other changes. */
    const checkLibrarySkills = (names: ReadonlyArray<string> | undefined, current: ReadonlyArray<string> = []) =>
      Effect.gen(function*() {
        if (names === undefined) return
        const known = yield* Effect.orDie(library.names)
        const unknown = names.filter((name) => !known.has(name) && !current.includes(name))
        if (unknown.length > 0) return yield* new BadRequest({ message: `Unknown library skill: ${unknown.join(", ")}` })
      })
    const libraryChanged = events.publish({ type: "skill-library-changed" })

    /** Keeps "<Requester> → <Target>" titles current after a bot is renamed. */
    const retitleHandoffs = (botId: string) =>
      Effect.gen(function*() {
        for (const conversation of yield* conversations.handoffsOf(botId)) {
          const requesterId = conversation.requesterBotId
          const targetId = conversation.botIds.find((id) => id !== requesterId)
          if (requesterId === null || targetId === undefined) continue
          const requester = yield* Effect.option(bots.get(requesterId))
          const target = yield* Effect.option(bots.get(targetId))
          if (requester._tag === "None" || target._tag === "None") continue
          const title = handoffTitle(requester.value.name, target.value.name)
          if (title !== conversation.title) yield* Effect.orDie(conversations.update(conversation.id, { title }))
        }
      })

    /** Deletes everything the bot kept on disk, its workspace included. */
    const removeFiles = (botId: string) => {
      if (!isValidBotId(botId)) return Effect.void
      const dir = join(config.dataDir, "bots", botId)
      return Effect.tryPromise(() => rm(dir, { recursive: true, force: true })).pipe(
        Effect.catch((error) => Effect.logWarning(`Couldn't delete ${dir} of deleted bot ${botId}`, error.cause))
      )
    }

    return handlers
      .handle("list", () => bots.list)
      .handle("get", ({ params }) => bots.get(params.id))
      .handle("create", ({ payload }) =>
        Effect.gen(function*() {
          yield* checkIntegrations(payload.integrationIds)
          yield* checkTeammates(payload.teammateIds)
          yield* checkLibrarySkills(payload.librarySkills)
          const bot = yield* bots.create(payload)
          if (bot.librarySkills.length > 0) yield* libraryChanged
          return bot
        }))
      .handle("update", ({ params, payload }) =>
        Effect.gen(function*() {
          yield* checkIntegrations(payload.integrationIds)
          yield* checkTeammates(payload.teammateIds, params.id)
          const before = yield* bots.get(params.id)
          yield* checkLibrarySkills(payload.librarySkills, before.librarySkills)
          const bot = yield* bots.update(params.id, payload)
          if (payload.name !== undefined) {
            yield* retitleHandoffs(bot.id)
            yield* teamSessions.botRenamed(bot.id)
          }
          if (payload.librarySkills !== undefined && bot.librarySkills.join("\n") !== before.librarySkills.join("\n")) {
            yield* libraryChanged
          }
          return bot
        }))
      .handle("remove", ({ params }) =>
        Effect.gen(function*() {
          const bot = yield* bots.get(params.id)
          const managed = (yield* teams.list).find((team) => team.managerBotId === params.id)
          if (managed !== undefined) {
            return yield* new Conflict({ message: `${bot.name} manages ${managed.name}. Choose another manager first.` })
          }
          yield* runner.cancelBot(params.id)
          const handoffs = yield* conversations.handoffsOf(params.id)
          yield* bots.remove(params.id)
          yield* teamSessions.botRemoved(params.id)
          const cancelled = yield* schedules.removeForBot(params.id)
          for (const conversationId of new Set(cancelled.map((schedule) => schedule.conversationId))) {
            yield* events.publish({ type: "schedules-changed", conversationId })
          }
          if (config.browser === "camofox") {
            yield* camofox.removeBot(params.id)
            for (const handoff of handoffs) yield* camofox.closeConversation(handoff.id, handoff.botIds)
          }
          yield* selfReview.cancel(params.id)
          yield* Effect.orDie(skills.removeBot(params.id))
          yield* botUsers.remove(params.id)
          yield* removeFiles(params.id)
          if (bot.librarySkills.length > 0) yield* libraryChanged
        }))
  })
)
