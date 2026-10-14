import { Clock, Effect, Predicate, Schema } from "effect"
import {
  describeEvery,
  maxEveryMinutes,
  maxPerConversation,
  minEveryMinutes,
  type Schedule
} from "../../features/schedules/Schedule.ts"
import type { ScheduleRepo } from "../../features/schedules/ScheduleRepo.ts"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"

export const scheduleToolNames = { create: "schedule_task", manage: "scheduled_tasks" } as const

const stringArg = (params: unknown, key: string): string => {
  const value = Predicate.isObject(params) ? (params as Record<string, unknown>)[key] : undefined
  return Predicate.isString(value) ? value : ""
}

const fail = (message: string) => Effect.fail(new ToolFailure({ message }))

const line = (schedule: Schedule): string =>
  `- ${schedule.id}: "${schedule.title}", ${describeEvery(schedule.everyMinutes)}, next run ${schedule.nextRunAt}` +
  (schedule.lastRunAt === null ? "" : `, last ran ${schedule.lastRunAt}`)

const CreateParams = Schema.Struct({
  title: Schema.String.annotate({ description: "A short label for the task, e.g. \"Remote job scrape\"." }),
  prompt: Schema.String.annotate({
    description: "The instruction to carry out on every run, written as the person would ask it and self-contained: " +
      "sources, filters, and how to report. It's posted in this chat as the person's message each time."
  }),
  every_minutes: Schema.Int.annotate({
    description: `How often to run, in minutes (${minEveryMinutes} to ${maxEveryMinutes}), e.g. 300 for every 5 hours, 1440 for daily.`
  }),
  first_run_at: Schema.optional(Schema.String.annotate({
    description: "When to run first, as an ISO-8601 time with a timezone offset, e.g. a daily task's first 9:00. " +
      "Leave it out to run first one interval from now."
  }))
})

const ManageParams = Schema.Struct({
  action: Schema.Literals(["list", "cancel"]),
  id: Schema.optional(Schema.String.annotate({ description: "The schedule to cancel (from list)." }))
})

export interface ScheduleToolsOptions {
  readonly repo: typeof ScheduleRepo.Service
  readonly botId: string
  readonly conversationId: string
  /** Called after schedules are added or cancelled, so clients can refresh. */
  readonly changed: Effect.Effect<void>
  readonly needsApproval: boolean
}

/** Lets a bot repeat a task in the current conversation on an interval, and list or cancel what's scheduled. */
export const scheduleTools = (options: ScheduleToolsOptions): ReadonlyArray<AgentTool> => {
  const { repo, conversationId } = options

  const create: AgentTool = {
    name: scheduleToolNames.create,
    description: "Repeat a task in this chat on a schedule, e.g. \"scrape remote jobs every 5 hours\". On each run the " +
      "prompt is posted here as the person's message and you carry it out with your tools, so the results land in this " +
      "chat. Use this instead of crontab or background scripts, which can't reach you or this chat. If the person also " +
      "wants results now, do the task now as well. Messages starting with \"⏰ Scheduled task\" are runs of a schedule: " +
      "carry them out and don't schedule them again.",
    parameters: jsonSchemaOf(CreateParams),
    needsApproval: options.needsApproval,
    activity: "Scheduling a task",
    title: (params) => {
      const title = shorten(stringArg(params, "title"), 60)
      const every = Predicate.isObject(params) ? (params as Record<string, unknown>).every_minutes : undefined
      const when = Predicate.isNumber(every) ? ` ${describeEvery(every)}` : ""
      return title.length > 0 ? `Scheduled "${title}"${when}` : `Scheduled a task${when}`
    },
    validate: (raw) => Effect.asVoid(checkCreate(raw)),
    run: (raw) =>
      Effect.gen(function*() {
        const { params, firstRun } = yield* checkCreate(raw)
        const existing = yield* repo.list(conversationId)
        if (existing.length >= maxPerConversation) {
          return yield* fail(`This chat already has ${maxPerConversation} scheduled tasks; cancel one first.`)
        }
        const schedule = yield* repo.create({
          conversationId,
          botId: options.botId,
          title: params.title.trim(),
          prompt: params.prompt.trim(),
          everyMinutes: params.every_minutes,
          nextRunAt: firstRun
        })
        yield* options.changed
        return `Scheduled "${schedule.title}" ${describeEvery(schedule.everyMinutes)} (id ${schedule.id}). ` +
          `First run: ${schedule.nextRunAt}. The person can cancel it by asking you, or in the app.`
      })
  }

  const checkCreate = (raw: unknown) =>
    Effect.gen(function*() {
      const params = yield* decodeParams(CreateParams, raw)
      if (params.title.trim().length === 0) return yield* fail("The title is empty.")
      if (params.prompt.trim().length === 0) return yield* fail("The prompt is empty.")
      if (params.every_minutes < minEveryMinutes || params.every_minutes > maxEveryMinutes) {
        return yield* fail(`every_minutes must be between ${minEveryMinutes} and ${maxEveryMinutes}.`)
      }
      const now = yield* Clock.currentTimeMillis
      let first = now + params.every_minutes * 60_000
      if (params.first_run_at !== undefined) {
        const parsed = Date.parse(params.first_run_at)
        if (Number.isNaN(parsed)) return yield* fail(`first_run_at isn't a valid time: ${params.first_run_at}`)
        if (parsed < now - 60_000) return yield* fail("first_run_at is in the past.")
        if (parsed > now + maxEveryMinutes * 60_000) return yield* fail("first_run_at is more than 30 days away.")
        first = Math.max(parsed, now)
      }
      return { params, firstRun: new Date(first).toISOString() }
    })

  const manage: AgentTool = {
    name: scheduleToolNames.manage,
    description: "List this chat's scheduled tasks, or cancel one by id.",
    parameters: jsonSchemaOf(ManageParams),
    needsApproval: false,
    activity: "Checking scheduled tasks",
    title: (params) => (stringArg(params, "action") === "cancel" ? "Cancelled a scheduled task" : "Checked scheduled tasks"),
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(ManageParams, raw)
        const schedules = yield* repo.list(conversationId)
        if (params.action === "list") {
          return schedules.length === 0 ? "No scheduled tasks in this chat." : schedules.map(line).join("\n")
        }
        const id = params.id?.trim() ?? ""
        const schedule = schedules.find((s) => s.id === id)
        if (schedule === undefined) {
          return yield* fail(id.length === 0 ? "Give the id of the schedule to cancel." : `No scheduled task ${id} in this chat.`)
        }
        yield* repo.remove(schedule.id)
        yield* options.changed
        return `Cancelled "${schedule.title}".`
      })
  }

  return [create, manage]
}
