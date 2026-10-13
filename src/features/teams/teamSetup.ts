import { Effect, Option } from "effect"
import { BadRequest } from "../../platform/http/errors.ts"
import { newId } from "../../platform/lib/util.ts"
import type { BotRepo } from "../bots/BotRepo.ts"
import type { ConversationRepo } from "../conversations/ConversationRepo.ts"
import type { RunEvents } from "../runs/RunEvents.ts"
import { privateTitle, roleLimit, roomTitle, type Team, type TeamMember } from "./Team.ts"
import type { TeamRepo } from "./TeamRepo.ts"

/** What checking and creating teams needs, shared by the HTTP API and the `propose_team` tool. */
export interface TeamSetup {
  readonly teams: TeamRepo["Service"]
  readonly bots: BotRepo["Service"]
  readonly conversations: ConversationRepo["Service"]
  readonly events: RunEvents["Service"]
}

export interface TeamDraft {
  readonly name: string
  readonly managerBotId: string
  readonly members: ReadonlyArray<TeamMember>
  readonly parentTeamId: string | null
}

export interface NewTeamInput extends TeamDraft {
  readonly purpose?: string | undefined
}

const bad = (message: string) => Effect.fail(new BadRequest({ message }))

/** Tells clients to pull the team again. */
export const teamChanged = (setup: TeamSetup, teamId: string) => setup.events.publish({ type: "team-changed", teamId })

/** Checks a team as it would be saved; `current` is the team being changed. */
export const checkTeam = (setup: TeamSetup, draft: TeamDraft, current?: Team) =>
  Effect.gen(function*() {
    const { teams, bots } = setup
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

/** Checks and creates a team with its room and, for a top-level team, its private chat. */
export const createTeam = (setup: TeamSetup, input: NewTeamInput) =>
  Effect.gen(function*() {
    const { teams, conversations } = setup
    const draft = yield* checkTeam(setup, input)
    const id = newId()
    const botIds = [input.managerBotId, ...draft.members.map((member) => member.botId)]
    const room = yield* conversations.create({
      title: roomTitle(draft.name, draft.parent?.name),
      botIds,
      team: { id, kind: "team-room" }
    })
    const privateChat = draft.parent === undefined
      ? yield* conversations.create({
        title: privateTitle(draft.name, draft.manager),
        botIds: [input.managerBotId],
        team: { id, kind: "team-private" }
      })
      : undefined
    const team = yield* teams.create(id, {
      name: draft.name,
      purpose: input.purpose?.trim() ?? "",
      managerBotId: input.managerBotId,
      members: draft.members,
      parentTeamId: draft.parent?.id ?? null,
      roomConversationId: room.id,
      privateConversationId: privateChat?.id ?? null
    })
    yield* teamChanged(setup, id)
    return team
  })
