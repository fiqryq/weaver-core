import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { Settings } from "./Settings.ts"

export const ProfileHandlers = HttpApiBuilder.group(
  Api,
  "profile",
  Effect.fn(function*(handlers) {
    const settings = yield* Settings
    return handlers
      .handle("get", () => settings.profile)
      .handle("update", ({ payload }) => settings.updateProfile(payload))
  })
)
