import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { nowIso } from "../../platform/lib/util.ts"
import { Team, TeamMember, TeamNotFound, type TeamStatus, TeamStatus as TeamStatusSchema, TeamTask } from "./Team.ts"

interface TeamRow {
  readonly id: string
  readonly name: string
  readonly purpose: string
  readonly manager_bot_id: string
  readonly members: string
  readonly parent_team_id: string | null
  readonly room_conversation_id: string
  readonly private_conversation_id: string | null
  readonly status: string
  readonly task: string | null
  readonly created_at: string
  readonly updated_at: string
}

const decodeMembers = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(TeamMember)))
const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(TeamTask))
const isStatus = Schema.is(TeamStatusSchema)

const attempt = <A>(decode: () => A, fallback: A): A => {
  try {
    return decode()
  } catch {
    return fallback
  }
}

const fromRow = (row: TeamRow): Team =>
  new Team({
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    managerBotId: row.manager_bot_id,
    members: attempt(() => decodeMembers(row.members), []),
    parentTeamId: row.parent_team_id,
    roomConversationId: row.room_conversation_id,
    privateConversationId: row.private_conversation_id,
    status: isStatus(row.status) ? row.status : "idle",
    task: row.task === null ? null : attempt(() => decodeTask(row.task), null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })

export interface NewTeam {
  readonly name: string
  readonly purpose: string
  readonly managerBotId: string
  readonly members: ReadonlyArray<TeamMember>
  readonly parentTeamId: string | null
  readonly roomConversationId: string
  readonly privateConversationId: string | null
}

export interface TeamPatch {
  readonly name?: string | undefined
  readonly purpose?: string | undefined
  readonly managerBotId?: string | undefined
  readonly members?: ReadonlyArray<TeamMember> | undefined
  readonly status?: TeamStatus
  readonly task?: TeamTask | null
}

export class TeamRepo extends Context.Service<TeamRepo, {
  readonly list: Effect.Effect<ReadonlyArray<Team>>
  get(id: string): Effect.Effect<Team, TeamNotFound>
  /** `id` is chosen by the caller, so the team's conversations can point at it before it exists. */
  create(id: string, input: NewTeam): Effect.Effect<Team>
  update(id: string, patch: TeamPatch): Effect.Effect<Team, TeamNotFound>
  /** Deletes the team and its subgroups (not their conversations). */
  remove(id: string): Effect.Effect<void>
  subgroupsOf(id: string): Effect.Effect<ReadonlyArray<Team>>
  /** Takes the bot off every team it's a member of; returns those teams as they are now. */
  removeMember(botId: string): Effect.Effect<ReadonlyArray<Team>>
  /**
   * After a restart: top-level teams that were working become interrupted, and subgroups (which only
   * work inside their parent's session) idle. Returns how many teams changed.
   */
  readonly markInterrupted: Effect.Effect<number>
}>()("weaver/TeamRepo") {
  static readonly layer = Layer.effect(
    TeamRepo,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const list = sql<TeamRow>`SELECT * FROM teams ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.orDie
      )

      const get = Effect.fn("TeamRepo.get")(function*(id: string) {
        const rows = yield* sql<TeamRow>`SELECT * FROM teams WHERE id = ${id}`.pipe(Effect.orDie)
        const row = rows[0]
        if (row === undefined) return yield* new TeamNotFound({ id })
        return fromRow(row)
      })

      const create = Effect.fn("TeamRepo.create")(function*(id: string, input: NewTeam) {
        const now = yield* nowIso
        yield* sql`INSERT INTO teams ${
          sql.insert({
            id,
            name: input.name,
            purpose: input.purpose,
            manager_bot_id: input.managerBotId,
            members: JSON.stringify(input.members),
            parent_team_id: input.parentTeamId,
            room_conversation_id: input.roomConversationId,
            private_conversation_id: input.privateConversationId,
            status: "idle",
            task: null,
            created_at: now,
            updated_at: now
          })
        }`.pipe(Effect.orDie)
        return yield* Effect.orDie(get(id))
      })

      const update = Effect.fn("TeamRepo.update")(function*(id: string, patch: TeamPatch) {
        yield* get(id)
        const changes: Record<string, string | null> = { updated_at: yield* nowIso }
        if (patch.name !== undefined) changes.name = patch.name
        if (patch.purpose !== undefined) changes.purpose = patch.purpose
        if (patch.managerBotId !== undefined) changes.manager_bot_id = patch.managerBotId
        if (patch.members !== undefined) changes.members = JSON.stringify(patch.members)
        if (patch.status !== undefined) changes.status = patch.status
        if (patch.task !== undefined) changes.task = patch.task === null ? null : JSON.stringify(patch.task)
        yield* sql`UPDATE teams SET ${sql.update(changes)} WHERE id = ${id}`.pipe(Effect.orDie)
        return yield* get(id)
      })

      const remove = (id: string) => sql`DELETE FROM teams WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie)

      const subgroupsOf = (id: string) =>
        sql<TeamRow>`SELECT * FROM teams WHERE parent_team_id = ${id} ORDER BY created_at`.pipe(
          Effect.map((rows) => rows.map(fromRow)),
          Effect.orDie
        )

      const removeMember = Effect.fn("TeamRepo.removeMember")(function*(botId: string) {
        const changed: Array<Team> = []
        for (const team of yield* list) {
          if (!team.members.some((member) => member.botId === botId)) continue
          changed.push(yield* Effect.orDie(update(team.id, { members: team.members.filter((member) => member.botId !== botId) })))
        }
        return changed
      })

      const markInterrupted = Effect.flatMap(nowIso, (now) =>
        sql<{ id: string }>`
          UPDATE teams SET
            status = CASE WHEN parent_team_id IS NULL THEN 'interrupted' ELSE 'idle' END,
            task = CASE WHEN parent_team_id IS NULL THEN task END,
            updated_at = ${now}
          WHERE status = 'working' RETURNING id`).pipe(
          Effect.map((rows) => rows.length),
          Effect.orDie
        )

      return TeamRepo.of({ list, get, create, update, remove, subgroupsOf, removeMember, markInterrupted })
    })
  )
}
