import { Schema } from "effect"

export const TeamMember = Schema.Struct({
  botId: Schema.String,
  /** e.g. "Android developer"; 1 to 60 characters. */
  role: Schema.String
})
export type TeamMember = typeof TeamMember.Type

/** `waiting`: paused until the person answers in the private chat; `interrupted`: the server restarted mid-session. */
export const TeamStatus = Schema.Literals(["idle", "working", "waiting", "interrupted"])
export type TeamStatus = typeof TeamStatus.Type

export const TeamTask = Schema.Struct({
  title: Schema.String,
  startedAt: Schema.String
})
export type TeamTask = typeof TeamTask.Type

export const roleLimit = 60

/**
 * Bots led by a manager. A top-level team has a room (manager and members) and a private chat (the
 * person and the manager); a subgroup (`parentTeamId`) has only a room, and its manager, the lead,
 * is a member of the parent team.
 */
export class Team extends Schema.Class<Team>("Team")({
  id: Schema.String,
  name: Schema.String,
  purpose: Schema.String,
  managerBotId: Schema.String,
  /** Excludes the manager. */
  members: Schema.Array(TeamMember),
  parentTeamId: Schema.NullOr(Schema.String),
  roomConversationId: Schema.String,
  /** Null for subgroups. */
  privateConversationId: Schema.NullOr(Schema.String),
  status: TeamStatus,
  /** The current or last task while the team isn't idle. */
  task: Schema.NullOr(TeamTask),
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

export const TeamCreate = Schema.Struct({
  name: Schema.String,
  purpose: Schema.optional(Schema.String),
  managerBotId: Schema.String,
  members: Schema.Array(TeamMember),
  parentTeamId: Schema.optional(Schema.NullOr(Schema.String))
})
export type TeamCreate = typeof TeamCreate.Type

export const TeamUpdate = Schema.Struct({
  name: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
  managerBotId: Schema.optional(Schema.String),
  members: Schema.optional(Schema.Array(TeamMember)),
  /** Can't change; sent only to be checked. */
  parentTeamId: Schema.optional(Schema.NullOr(Schema.String))
})
export type TeamUpdate = typeof TeamUpdate.Type

export class TeamNotFound extends Schema.TaggedError<TeamNotFound>()("TeamNotFound", {
  id: Schema.String
}, { httpApiStatus: 404 }) {}

export const roomTitle = (team: string, parent?: string): string =>
  parent === undefined ? `${team} room` : `${parent} / ${team} room`

export const privateTitle = (team: string, manager: string): string => `${team} · ${manager}`

/** For memory folders and tags, e.g. "Team Delta!" → "team-delta". */
export const teamSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "team"
