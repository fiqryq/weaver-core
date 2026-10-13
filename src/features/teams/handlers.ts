import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { BadRequest } from "../../platform/http/errors.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import { ConversationRepo } from "../conversations/ConversationRepo.ts"
import { RunEvents } from "../runs/RunEvents.ts"
import { TeamRepo } from "./TeamRepo.ts"
import { TeamSessions } from "./TeamSessions.ts"
import { checkTeam, createTeam, teamChanged, type TeamSetup } from "./teamSetup.ts"

export const TeamsHandlers = HttpApiBuilder.group(
  Api,
  "teams",
  Effect.fn(function*(handlers) {
    const teams = yield* TeamRepo
    const bots = yield* BotRepo
    const conversations = yield* ConversationRepo
    const sessions = yield* TeamSessions
    const events = yield* RunEvents

    const setup: TeamSetup = { teams, bots, conversations, events }
    const bad = (message: string) => Effect.fail(new BadRequest({ message }))

    return handlers
      .handle("list", () => teams.list)
      .handle("get", ({ params }) => teams.get(params.id))
      .handle("create", ({ payload }) =>
        createTeam(setup, {
          name: payload.name,
          purpose: payload.purpose,
          managerBotId: payload.managerBotId,
          members: payload.members,
          parentTeamId: payload.parentTeamId ?? null
        }))
      .handle("update", ({ params, payload }) =>
        Effect.gen(function*() {
          const current = yield* teams.get(params.id)
          if (payload.parentTeamId !== undefined && payload.parentTeamId !== current.parentTeamId) {
            return yield* bad("A team can't move to another parent team.")
          }
          const draft = yield* checkTeam(setup, {
            name: payload.name ?? current.name,
            managerBotId: payload.managerBotId ?? current.managerBotId,
            members: payload.members ?? current.members,
            parentTeamId: current.parentTeamId
          }, current)
          yield* teams.update(params.id, {
            name: draft.name,
            purpose: payload.purpose?.trim(),
            managerBotId: payload.managerBotId,
            members: draft.members
          })
          yield* sessions.sync(params.id)
          yield* teamChanged(setup, params.id)
          return yield* teams.get(params.id)
        }))
      .handle("remove", ({ params }) => sessions.remove(params.id))
      .handle("stop", ({ params }) => sessions.stop(params.id))
      .handle("resume", ({ params }) => sessions.resume(params.id))
  })
)
