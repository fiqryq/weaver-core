import { Effect, Layer, Option, Redacted } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AppConfig, version } from "../../config/Config.ts"
import { BotsHandlers } from "../../features/bots/handlers.ts"
import { ConversationsHandlers } from "../../features/conversations/handlers.ts"
import { IntegrationsHandlers } from "../../features/integrations/handlers.ts"
import { SkillsHandlers } from "../../features/learning/handlers.ts"
import { ProfileHandlers } from "../../features/profile/handlers.ts"
import { Health } from "../../features/profile/Profile.ts"
import { ProvidersHandlers } from "../../features/providers/handlers.ts"
import { RunsHandlers } from "../../features/runs/handlers.ts"
import { Api } from "./Api.ts"
import { Authorization, tokensMatch, Unauthorized } from "./Authorization.ts"

export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function*() {
    const config = yield* AppConfig
    const expected = Redacted.value(config.token)
    return Authorization.of({
      bearer: (httpEffect, { credential }) =>
        tokensMatch(Redacted.value(credential), expected)
          ? httpEffect
          : Effect.fail(new Unauthorized({ message: "Missing or invalid bearer token." }))
    })
  })
)

const SystemHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function*(handlers) {
    const config = yield* AppConfig
    return handlers.handle("health", () =>
      Effect.succeed(
        new Health({
          status: "ok",
          version,
          memory: Option.isSome(config.memory),
          browser: config.browserCommand.length > 0
        })
      ))
  })
)

export const ApiHandlers = Layer.mergeAll(
  SystemHandlers,
  ProfileHandlers,
  BotsHandlers,
  SkillsHandlers,
  ConversationsHandlers,
  RunsHandlers,
  ProvidersHandlers,
  IntegrationsHandlers
)
