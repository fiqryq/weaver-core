import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { Updates } from "./Updates.ts"

const truthy = (value: string | undefined) => value !== undefined && ["1", "true", "yes"].includes(value.trim().toLowerCase())

export const UpdatesHandlers = HttpApiBuilder.group(
  Api,
  "updates",
  Effect.fn(function*(handlers) {
    const updates = yield* Updates
    return handlers
      .handle("check", ({ query }) => updates.check(query.channel ?? "stable", truthy(query.refresh)))
      .handle("install", ({ payload }) => updates.request(payload.channel ?? "stable", payload.tag))
  })
)
