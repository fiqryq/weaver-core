import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { ProviderInfo, ProviderNotFound, ProviderTestResult, ProviderUpdate } from "./Provider.ts"

const IdParams = { id: Schema.String }

export class ProvidersApi extends HttpApiGroup.make("providers")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(ProviderInfo) }),
    HttpApiEndpoint.get("get", "/:id", { params: IdParams, success: ProviderInfo, error: ProviderNotFound }),
    HttpApiEndpoint.put("update", "/:id", {
      params: IdParams,
      payload: ProviderUpdate,
      success: ProviderInfo,
      error: ProviderNotFound
    }),
    HttpApiEndpoint.post("test", "/:id/test", { params: IdParams, success: ProviderTestResult, error: ProviderNotFound })
  )
  .middleware(Authorization)
  .prefix("/v1/providers")
{}
