import { statfs } from "node:fs/promises"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AppConfig, builtAt, commit, version } from "../../config/Config.ts"
import { BotsHandlers } from "../../features/bots/handlers.ts"
import { ConversationsHandlers } from "../../features/conversations/handlers.ts"
import { IntegrationsHandlers } from "../../features/integrations/handlers.ts"
import { LibraryHandlers, SkillsHandlers } from "../../features/learning/handlers.ts"
import { MemoryHandlers } from "../../features/memory/handlers.ts"
import { ProfileHandlers } from "../../features/profile/handlers.ts"
import { Health } from "../../features/profile/Profile.ts"
import { ProvidersHandlers } from "../../features/providers/handlers.ts"
import { RunsHandlers } from "../../features/runs/handlers.ts"
import { TeamsHandlers } from "../../features/teams/handlers.ts"
import { UpdatesHandlers } from "../../features/updates/handlers.ts"
import { Camofox } from "../../tools/builtin/Camofox.ts"
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

const startedAt = Date.now()

/** Bytes free for unprivileged writes on the data folder's filesystem, or undefined if it can't be read. */
const freeBytes = (path: string) =>
  Effect.promise(() => statfs(path).then((stats) => stats.bavail * stats.bsize, () => undefined))

const SystemHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function*(handlers) {
    const config = yield* AppConfig
    const camofox = yield* Camofox
    return handlers.handle("health", () =>
      Effect.gen(function*() {
        const dataDirFreeBytes = yield* freeBytes(config.dataDir)
        const browser = config.browser === "camofox"
          ? yield* camofox.available
          : config.browser === "playwright" && config.browserCommand.length > 0
        return new Health({
          status: "ok",
          version,
          commit,
          builtAt,
          memory: Option.isSome(config.memory),
          browser,
          browserEngine: config.browser === "off" ? "none" : config.browser,
          web: true,
          handoffs: true,
          skillsLibrary: true,
          memoryApi: true,
          teams: true,
          oauthIntegrations: true,
          updates: true,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          ...(dataDirFreeBytes === undefined ? {} : { dataDirFreeBytes })
        })
      }))
  })
)

export const ApiHandlers = Layer.mergeAll(
  SystemHandlers,
  ProfileHandlers,
  BotsHandlers,
  SkillsHandlers,
  LibraryHandlers,
  ConversationsHandlers,
  RunsHandlers,
  ProvidersHandlers,
  IntegrationsHandlers,
  MemoryHandlers,
  TeamsHandlers,
  UpdatesHandlers
)
