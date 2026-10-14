import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { newId, nowIso, orDieWithLog } from "../../platform/lib/util.ts"
import { Schedule, ScheduleNotFound } from "./Schedule.ts"

interface ScheduleRow {
  readonly id: string
  readonly conversation_id: string
  readonly bot_id: string
  readonly title: string
  readonly prompt: string
  readonly every_minutes: number
  readonly next_run_at: string
  readonly last_run_at: string | null
  readonly created_at: string
}

const fromRow = (row: ScheduleRow): Schedule =>
  new Schedule({
    id: row.id,
    conversationId: row.conversation_id,
    botId: row.bot_id,
    title: row.title,
    prompt: row.prompt,
    everyMinutes: row.every_minutes,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at
  })

export interface NewSchedule {
  readonly conversationId: string
  readonly botId: string
  readonly title: string
  readonly prompt: string
  readonly everyMinutes: number
  readonly nextRunAt: string
}

export class ScheduleRepo extends Context.Service<ScheduleRepo, {
  /** Every schedule, or one conversation's, soonest first. */
  list(conversationId?: string): Effect.Effect<ReadonlyArray<Schedule>>
  get(id: string): Effect.Effect<Schedule, ScheduleNotFound>
  create(input: NewSchedule): Effect.Effect<Schedule>
  remove(id: string): Effect.Effect<void>
  /** Deletes the schedules the bot set up; returns them. */
  removeForBot(botId: string): Effect.Effect<ReadonlyArray<Schedule>>
  /** Schedules whose next run is at or before `now` (ISO-8601). */
  due(now: string): Effect.Effect<ReadonlyArray<Schedule>>
  /** Moves the next run; `ranAt` also records a run. */
  reschedule(id: string, nextRunAt: string, ranAt?: string): Effect.Effect<void>
}>()("weaver/ScheduleRepo") {
  static readonly layer = Layer.effect(
    ScheduleRepo,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const list = (conversationId?: string) =>
        (conversationId === undefined
          ? sql<ScheduleRow>`SELECT * FROM schedules ORDER BY next_run_at`
          : sql<ScheduleRow>`SELECT * FROM schedules WHERE conversation_id = ${conversationId} ORDER BY next_run_at`).pipe(
            Effect.map((rows) => rows.map(fromRow)),
            orDieWithLog
          )

      const get = Effect.fn("ScheduleRepo.get")(function*(id: string) {
        const rows = yield* sql<ScheduleRow>`SELECT * FROM schedules WHERE id = ${id}`.pipe(orDieWithLog)
        const row = rows[0]
        if (row === undefined) return yield* new ScheduleNotFound({ id })
        return fromRow(row)
      })

      const create = Effect.fn("ScheduleRepo.create")(function*(input: NewSchedule) {
        const id = newId()
        yield* sql`INSERT INTO schedules ${
          sql.insert({
            id,
            conversation_id: input.conversationId,
            bot_id: input.botId,
            title: input.title,
            prompt: input.prompt,
            every_minutes: input.everyMinutes,
            next_run_at: input.nextRunAt,
            last_run_at: null,
            created_at: yield* nowIso
          })
        }`.pipe(orDieWithLog)
        return yield* orDieWithLog(get(id))
      })

      const remove = (id: string) => sql`DELETE FROM schedules WHERE id = ${id}`.pipe(Effect.asVoid, orDieWithLog)

      const removeForBot = (botId: string) =>
        sql<ScheduleRow>`DELETE FROM schedules WHERE bot_id = ${botId} RETURNING *`.pipe(
          Effect.map((rows) => rows.map(fromRow)),
          orDieWithLog
        )

      const due = (now: string) =>
        sql<ScheduleRow>`SELECT * FROM schedules WHERE next_run_at <= ${now} ORDER BY next_run_at`.pipe(
          Effect.map((rows) => rows.map(fromRow)),
          orDieWithLog
        )

      const reschedule = (id: string, nextRunAt: string, ranAt?: string) =>
        (ranAt === undefined
          ? sql`UPDATE schedules SET next_run_at = ${nextRunAt} WHERE id = ${id}`
          : sql`UPDATE schedules SET next_run_at = ${nextRunAt}, last_run_at = ${ranAt} WHERE id = ${id}`).pipe(
            Effect.asVoid,
            orDieWithLog
          )

      return ScheduleRepo.of({ list, get, create, remove, removeForBot, due, reschedule })
    })
  )
}
