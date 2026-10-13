import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { BadRequest } from "../../platform/http/errors.ts"
import { newId } from "../../platform/lib/util.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import { ConversationRepo } from "../conversations/ConversationRepo.ts"
import { RunEvents } from "../runs/RunEvents.ts"
import { privateTitle, roleLimit, roomTitle, type Team, type TeamMember } from "./Team.ts"
import { TeamRepo } from "./TeamRepo.ts"
import { TeamSessions } from "./TeamSessions.ts"

interface Draft {
  readonly name: string
  readonly managerBotId: string
  readonly members: ReadonlyArray<TeamMember>
  readonly parentTeamId: string | null
}

export const TeamsHandlers = HttpApiBuilder.group(
  Api,
  "teams",
  Effect.fn(function*(handlers) {
    const teams = yield* TeamRepo
    const bots = yield* BotRepo
    const conversations = yield* ConversationRepo
    const sessions = yield* TeamSessions
    const events = yield* RunEvents

    const bad = (message: string) => Effect.fail(new BadRequest({ message }))
    const changed = (teamId: string) => events.publish({ type: "team-changed", teamId })

    /** Checks a team as it would be saved; `current` is the team being changed. */
    const check = (draft: Draft, current?: Team) =>
      Effect.gen(function*() {
        const name = draft.name.trim()
        if (name.length === 0) return yield* bad("Give the team a name.")
        const known = new Map((yield* bots.list).map((bot) => [bot.id, bot]))
        const unknown = [draft.managerBotId, ...draft.members.map((member) => member.botId)].filter((id) => !known.has(id))
        if (unknown.length > 0) return yield* bad(`Unknown bot: ${[...new Set(unknown)].join(", ")}`)
        const nameOf = (id: string) => known.get(id)!.name
        const manager = nameOf(draft.managerBotId)
        if (draft.members.some((member) => member.botId === draft.managerBotId)) {
          return yield* bad(`${manager} manages ${name}, so it can't also be a member.`)
        }
        const seen = new Set<string>()
        for (const member of draft.members) {
          if (seen.has(member.botId)) return yield* bad(`${nameOf(member.botId)} is listed twice.`)
          seen.add(member.botId)
          const role = member.role.trim()
          if (role.length === 0 || role.length > roleLimit) {
            return yield* bad(`Give ${nameOf(member.botId)} a role of 1 to ${roleLimit} characters.`)
          }
        }
        let parent: Team | undefined
        if (draft.parentTeamId !== null) {
          const found = yield* Effect.option(teams.get(draft.parentTeamId))
          if (Option.isNone(found)) return yield* bad(`Unknown parent team: ${draft.parentTeamId}`)
          parent = found.value
          if (parent.parentTeamId !== null) {
            return yield* bad(`${parent.name} is a subgroup itself; subgroups go only one level deep.`)
          }
          if (!parent.members.some((member) => member.botId === draft.managerBotId)) {
            return yield* bad(`${manager} must be a member of ${parent.name} to lead a subgroup of it.`)
          }
        }
        if (current !== undefined) {
          for (const subgroup of yield* teams.subgroupsOf(current.id)) {
            if (!draft.members.some((member) => member.botId === subgroup.managerBotId)) {
              return yield* bad(`${nameOf(subgroup.managerBotId)} leads ${subgroup.name}, so it has to stay a member of ${name}.`)
            }
          }
        }
        return {
          name,
          manager,
          parent,
          members: draft.members.map((member) => ({ botId: member.botId, role: member.role.trim() }))
        }
      })

    return handlers
      .handle("list", () => teams.list)
      .handle("get", ({ params }) => teams.get(params.id))
      .handle("create", ({ payload }) =>
        Effect.gen(function*() {
          const draft = yield* check({
            name: payload.name,
            managerBotId: payload.managerBotId,
            members: payload.members,
            parentTeamId: payload.parentTeamId ?? null
          })
          const id = newId()
          const botIds = [payload.managerBotId, ...draft.members.map((member) => member.botId)]
          const room = yield* conversations.create({
            title: roomTitle(draft.name, draft.parent?.name),
            botIds,
            team: { id, kind: "team-room" }
          })
          const privateChat = draft.parent === undefined
            ? yield* conversations.create({
              title: privateTitle(draft.name, draft.manager),
              botIds: [payload.managerBotId],
              team: { id, kind: "team-private" }
            })
            : undefined
          const team = yield* teams.create(id, {
            name: draft.name,
            purpose: payload.purpose?.trim() ?? "",
            managerBotId: payload.managerBotId,
            members: draft.members,
            parentTeamId: draft.parent?.id ?? null,
            roomConversationId: room.id,
            privateConversationId: privateChat?.id ?? null
          })
          yield* changed(id)
          return team
        }))
      .handle("update", ({ params, payload }) =>
        Effect.gen(function*() {
          const current = yield* teams.get(params.id)
          if (payload.parentTeamId !== undefined && payload.parentTeamId !== current.parentTeamId) {
            return yield* bad("A team can't move to another parent team.")
          }
          const draft = yield* check({
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
          yield* changed(params.id)
          return yield* teams.get(params.id)
        }))
      .handle("remove", ({ params }) => sessions.remove(params.id))
      .handle("stop", ({ params }) => sessions.stop(params.id))
      .handle("resume", ({ params }) => sessions.resume(params.id))
  })
)
