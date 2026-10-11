import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { ProviderRegistry } from "./ProviderRegistry.ts"

export const ProvidersHandlers = HttpApiBuilder.group(
  Api,
  "providers",
  Effect.fn(function*(handlers) {
    const providers = yield* ProviderRegistry
    return handlers
      .handle("list", () => providers.list)
      .handle("get", ({ params }) => providers.get(params.id))
      .handle("update", ({ params, payload }) => providers.update(params.id, payload))
      .handle("test", ({ params }) => providers.test(params.id))
  })
)
