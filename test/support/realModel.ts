import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { AppConfig, type AppConfigShape } from "../../src/config/Config.ts"
import { LanguageModelFactory, ProviderRegistry } from "../../src/features/providers/ProviderRegistry.ts"
import { AppServices } from "../../src/main.ts"
import { DatabaseTest } from "../../src/platform/db/Database.ts"
import { tempDir } from "./layers.ts"

/** Every service the API uses, talking to models through the real OpenAI-compatible client. */
export const realModelLayer = (config: Partial<AppConfigShape> = {}) =>
  AppServices.pipe(
    Layer.provideMerge(LanguageModelFactory.layer),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(AppConfig.layerTest({
      dataDir: tempDir(),
      memory: Option.none(),
      browserCommand: [],
      reviewSkillInterval: 0,
      reviewMemoryInterval: 0,
      ...config
    }))
  )

/** Points the custom provider at `baseUrl` and makes it the default. */
export const useEndpoint = (baseUrl: string, model: string, apiKey = "sk-mock") =>
  Effect.gen(function*() {
    const providers = yield* ProviderRegistry
    yield* providers.update("custom", { baseUrl, apiKey, model, makeDefault: true })
  })
