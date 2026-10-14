import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { RunEvents } from "../runs/RunEvents.ts"
import { ScheduleRepo } from "./ScheduleRepo.ts"

export const SchedulesHandlers = HttpApiBuilder.group(
  Api,
  "schedules",
  Effect.fn(function*(handlers) {
    const schedules = yield* ScheduleRepo
    const events = yield* RunEvents
    return handlers
      .handle("list", ({ query }) => schedules.list(query.conversationId))
      .handle("remove", ({ params }) =>
        Effect.gen(function*() {
          const schedule = yield* schedules.get(params.id)
          yield* schedules.remove(schedule.id)
          yield* events.publish({ type: "schedules-changed", conversationId: schedule.conversationId })
        }))
  })
)
