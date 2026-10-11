import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect"
import type { LanguageModel } from "effect/ai"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { nowIso } from "../../platform/lib/util.ts"
import { Settings } from "../profile/Settings.ts"
import { normalizeChatRequests } from "./chatRequest.ts"
import {
  findPreset,
  ProviderInfo,
  ProviderNotFound,
  providerPresets,
  ProviderTestResult,
  type ProviderUpdate
} from "./Provider.ts"

export interface ProviderEndpoint {
  readonly providerId: string
  readonly name: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {
  message: Schema.String
}) {}

/** Builds the `LanguageModel` for an endpoint. Tests swap this for a scripted model. */
export class LanguageModelFactory extends Context.Service<LanguageModelFactory, {
  make(endpoint: ProviderEndpoint): Layer.Layer<LanguageModel.LanguageModel>
}>()("weaver/LanguageModelFactory") {
  static readonly layer = Layer.succeed(
    LanguageModelFactory,
    LanguageModelFactory.of({
      make: (endpoint) =>
        OpenAiLanguageModel.layer({ model: endpoint.model, config: { strictJsonSchema: false } }).pipe(
          Layer.provide(OpenAiClient.layer({
            apiUrl: endpoint.baseUrl,
            apiKey: endpoint.apiKey.length > 0 ? Redacted.make(endpoint.apiKey) : undefined,
            transformClient: normalizeChatRequests
          })),
          Layer.provide(FetchHttpClient.layer)
        )
    })
  )
}

interface ProviderRow {
  readonly id: string
  readonly base_url: string
  readonly api_key: string
  readonly model: string
}

const ModelList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String }))
})

export class ProviderRegistry extends Context.Service<ProviderRegistry, {
  readonly list: Effect.Effect<ReadonlyArray<ProviderInfo>>
  get(id: string): Effect.Effect<ProviderInfo, ProviderNotFound>
  update(id: string, input: ProviderUpdate): Effect.Effect<ProviderInfo, ProviderNotFound>
  test(id: string): Effect.Effect<ProviderTestResult, ProviderNotFound>
  /** Where a bot's requests go. An empty id means the default provider, an empty model its default model. */
  endpoint(providerId: string, model: string): Effect.Effect<ProviderEndpoint, ProviderUnavailable>
  languageModel(endpoint: ProviderEndpoint): Layer.Layer<LanguageModel.LanguageModel>
}>()("weaver/ProviderRegistry") {
  static readonly layer = Layer.effect(
    ProviderRegistry,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const settings = yield* Settings
      const factory = yield* LanguageModelFactory

      const stored = (id: string) =>
        sql<ProviderRow>`SELECT * FROM providers WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie
        )

      const info = Effect.fn("ProviderRegistry.info")(function*(id: string) {
        const preset = findPreset(id)
        if (preset === undefined) return yield* new ProviderNotFound({ id })
        const row = yield* stored(id)
        const defaultId = yield* settings.defaultProviderId
        return new ProviderInfo({
          id: preset.id,
          name: preset.name,
          baseUrl: row?.base_url || preset.defaultBaseUrl,
          defaultBaseUrl: preset.defaultBaseUrl,
          altBaseUrl: preset.altBaseUrl ?? null,
          model: row?.model || preset.defaultModel,
          defaultModel: preset.defaultModel,
          suggestedModels: preset.suggestedModels,
          keyPageUrl: preset.keyPageUrl ?? null,
          requiresKey: preset.requiresKey,
          hasKey: (row?.api_key ?? "").length > 0,
          isDefault: defaultId === preset.id
        })
      })

      const list = Effect.forEach(providerPresets, (preset) => Effect.orDie(info(preset.id)))

      const update = Effect.fn("ProviderRegistry.update")(function*(id: string, input: ProviderUpdate) {
        if (findPreset(id) === undefined) return yield* new ProviderNotFound({ id })
        const row = yield* stored(id)
        const now = yield* nowIso
        const next = {
          id,
          base_url: input.baseUrl !== undefined ? input.baseUrl.trim() : row?.base_url ?? "",
          api_key: input.apiKey !== undefined ? input.apiKey.trim() : row?.api_key ?? "",
          model: input.model !== undefined ? input.model.trim() : row?.model ?? "",
          updated_at: now
        }
        yield* sql`INSERT INTO providers ${sql.insert(next)}
          ON CONFLICT (id) DO UPDATE SET
            base_url = excluded.base_url, api_key = excluded.api_key,
            model = excluded.model, updated_at = excluded.updated_at`.pipe(Effect.orDie)
        if (input.makeDefault === true) yield* settings.setDefaultProviderId(id)
        return yield* info(id)
      })

      const endpoint = Effect.fn("ProviderRegistry.endpoint")(function*(providerId: string, model: string) {
        const id = providerId || (yield* settings.defaultProviderId)
        const preset = findPreset(id)
        if (preset === undefined) {
          return yield* new ProviderUnavailable({ message: `Unknown model provider "${id}".` })
        }
        const row = yield* stored(id)
        const baseUrl = (row?.base_url || preset.defaultBaseUrl).replace(/\/+$/, "")
        const apiKey = row?.api_key ?? ""
        const resolvedModel = model || row?.model || preset.defaultModel
        if (baseUrl.length === 0) {
          return yield* new ProviderUnavailable({ message: `${preset.name} has no API URL yet. Add it in Settings > Models.` })
        }
        if (preset.requiresKey && apiKey.length === 0) {
          return yield* new ProviderUnavailable({ message: `${preset.name} needs an API key. Add it in Settings > Models.` })
        }
        if (resolvedModel.length === 0) {
          return yield* new ProviderUnavailable({ message: `Pick a model for ${preset.name} in Settings > Models.` })
        }
        return { providerId: id, name: preset.name, baseUrl, apiKey, model: resolvedModel }
      })

      const test = Effect.fn("ProviderRegistry.test")(function*(id: string) {
        const current = yield* info(id)
        const row = yield* stored(id)
        const apiKey = row?.api_key ?? ""
        if (current.baseUrl.length === 0) {
          return new ProviderTestResult({ ok: false, models: [], error: "No API URL set." })
        }
        if (current.requiresKey && apiKey.length === 0) {
          return new ProviderTestResult({ ok: false, models: [], error: "No API key saved." })
        }
        const client = yield* HttpClient.HttpClient
        const request = HttpClientRequest.get(`${current.baseUrl.replace(/\/+$/, "")}/models`).pipe(
          apiKey.length > 0 ? HttpClientRequest.bearerToken(apiKey) : (request) => request
        )
        return yield* client.execute(request).pipe(
          Effect.flatMap((response) => {
            // Some compatible APIs don't list models; reaching them is enough.
            if (response.status === 404 || response.status === 405) {
              return Effect.succeed(new ProviderTestResult({ ok: true, models: [], error: null }))
            }
            if (response.status >= 400) {
              return Effect.map(response.text, (body) =>
                new ProviderTestResult({
                  ok: false,
                  models: [],
                  error: `HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`
                }))
            }
            return HttpClientResponse.schemaBodyJson(ModelList)(response).pipe(
              Effect.map((body) =>
                new ProviderTestResult({ ok: true, models: body.data.map((model) => model.id).sort(), error: null })
              ),
              Effect.orElseSucceed(() => new ProviderTestResult({ ok: true, models: [], error: null }))
            )
          }),
          Effect.timeout(Duration.seconds(20)),
          Effect.catch((error) =>
            Effect.succeed(new ProviderTestResult({ ok: false, models: [], error: String(error) }))
          )
        )
      }, Effect.provide(FetchHttpClient.layer))

      return ProviderRegistry.of({
        list,
        get: info,
        update,
        test,
        endpoint,
        languageModel: factory.make
      })
    })
  )
}
