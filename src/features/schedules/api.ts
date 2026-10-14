import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { Schedule, ScheduleNotFound } from "./Schedule.ts"

export class SchedulesApi extends HttpApiGroup.make("schedules")
  .add(
    HttpApiEndpoint.get("list", "/", {
      query: { conversationId: Schema.optional(Schema.String) },
      success: Schema.Array(Schedule)
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: ScheduleNotFound
    })
  )
  .middleware(Authorization)
  .prefix("/v1/schedules")
{}
