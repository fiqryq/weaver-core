import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { AppConfig, version } from "./config/Config.ts"
import { BotRepo } from "./features/bots/BotRepo.ts"
import { ConversationRepo } from "./features/conversations/ConversationRepo.ts"
import { IntegrationRepo } from "./features/integrations/IntegrationRepo.ts"
import { McpHub } from "./features/integrations/McpHub.ts"
import { SelfReview } from "./features/learning/review/SelfReview.ts"
import { SkillStore } from "./features/learning/skills/SkillStore.ts"
import { Settings } from "./features/profile/Settings.ts"
import { LanguageModelFactory, ProviderRegistry } from "./features/providers/ProviderRegistry.ts"
import { AgentRunnerLive } from "./features/runs/AgentRunnerLive.ts"
import { Approvals } from "./features/runs/Approvals.ts"
import { RunEvents } from "./features/runs/RunEvents.ts"
import { EventsRoutes } from "./features/runs/sse.ts"
import { Toolbox } from "./features/runs/Toolbox.ts"
import { DatabaseLive } from "./platform/db/Database.ts"
import { Api } from "./platform/http/Api.ts"
import { ApiHandlers, AuthorizationLive } from "./platform/http/handlers.ts"

/** Everything the API needs, given a migrated database, config, a model factory and platform services. */
export const AppServices = AgentRunnerLive.pipe(
  Layer.provideMerge(SelfReview.layer),
  Layer.provideMerge(Toolbox.layer),
  Layer.provideMerge(SkillStore.layer),
  Layer.provideMerge(Layer.mergeAll(McpHub.layer, RunEvents.layer, Approvals.layer)),
  Layer.provideMerge(ProviderRegistry.layer),
  Layer.provideMerge(Layer.mergeAll(BotRepo.layer, ConversationRepo.layer, IntegrationRepo.layer, Settings.layer))
)

const Startup = Layer.effectDiscard(Effect.gen(function*() {
  const conversations = yield* ConversationRepo
  const config = yield* AppConfig
  const interrupted = yield* conversations.markInterrupted
  if (interrupted > 0) yield* Effect.logWarning(`Marked ${interrupted} unfinished replies as failed after a restart.`)
  yield* Effect.logInfo(`Weaver agent server ${version} listening on ${config.host}:${config.port}`)
}))

export const AppRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(Api, { openapiPath: "/v1/openapi.json" }).pipe(
    Layer.provide(ApiHandlers),
    Layer.provide(AuthorizationLive)
  ),
  EventsRoutes
)

const HttpServerLive = Layer.unwrap(Effect.gen(function*() {
  const config = yield* AppConfig
  return BunHttpServer.layer({ hostname: config.host, port: config.port, idleTimeout: 0 })
}))

const MainLayer = HttpRouter.serve(AppRoutes, { disableListenLog: true }).pipe(
  Layer.provide(Startup),
  Layer.provide(HttpServerLive),
  Layer.provide(AppServices),
  Layer.provide(LanguageModelFactory.layer),
  Layer.provide(DatabaseLive),
  Layer.provide(BunServices.layer),
  Layer.provide(AppConfig.layer)
)

if (import.meta.main) {
  Layer.launch(MainLayer).pipe(BunRuntime.runMain)
}
