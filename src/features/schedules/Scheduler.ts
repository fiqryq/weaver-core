import { Cause, Clock, Context, Duration, Effect, Layer, Option } from "effect"
import { ConversationRepo } from "../conversations/ConversationRepo.ts"
import { AgentRunner } from "../runs/AgentRunner.ts"
import { RunEvents } from "../runs/RunEvents.ts"
import { scheduledMessage } from "./Schedule.ts"
import { ScheduleRepo } from "./ScheduleRepo.ts"

/** How often the scheduler looks for due schedules. */
export const tickInterval = Duration.seconds(30)
/** How long a due schedule waits when its conversation is busy replying. */
export const busyRetry = Duration.minutes(1)

/**
 * Runs due schedules: posts each one's prompt in its conversation as the person's message and starts
 * the bots, like `POST /v1/conversations/:id/messages`. A schedule missed while the server was down
 * runs once when it's back, not once per missed interval.
 */
export class Scheduler extends Context.Service<Scheduler, {
  /** Runs every due schedule now; returns how many started. */
  readonly tick: Effect.Effect<number>
}>()("weaver/Scheduler") {
  static readonly layer = Layer.effect(
    Scheduler,
    Effect.gen(function*() {
      const schedules = yield* ScheduleRepo
      const conversations = yield* ConversationRepo
      const runner = yield* AgentRunner
      const events = yield* RunEvents

      const iso = (millis: number) => new Date(millis).toISOString()

      const tick = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        let started = 0
        for (const schedule of yield* schedules.due(iso(now))) {
          const conversation = yield* Effect.option(conversations.get(schedule.conversationId))
          if (Option.isNone(conversation)) {
            yield* schedules.remove(schedule.id)
            continue
          }
          // Starting a run replaces the one in progress, so a busy conversation (e.g. the person
          // chatting) isn't interrupted; the schedule tries again shortly.
          if (yield* runner.isRunning(schedule.conversationId)) {
            yield* schedules.reschedule(schedule.id, iso(now + Duration.toMillis(busyRetry)))
            continue
          }
          yield* schedules.reschedule(schedule.id, iso(now + schedule.everyMinutes * 60_000), iso(now))
          const message = yield* conversations.insertMessage({
            conversationId: schedule.conversationId,
            role: "user",
            parts: [{ type: "text", text: scheduledMessage(schedule) }]
          })
          yield* events.publish({ type: "message-created", conversationId: schedule.conversationId, message })
          yield* runner.start(schedule.conversationId)
          yield* events.publish({ type: "schedules-changed", conversationId: schedule.conversationId })
          started++
        }
        return started
      })

      yield* Effect.sleep(tickInterval).pipe(
        Effect.andThen(tick),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning("Scheduled tasks failed to run", cause)
        ),
        Effect.forever,
        Effect.forkScoped
      )

      return Scheduler.of({ tick })
    })
  )
}
