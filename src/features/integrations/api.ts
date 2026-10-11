import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { BadRequest } from "../../platform/http/errors.ts"
import {
  Integration,
  IntegrationCreate,
  IntegrationNotFound,
  IntegrationTestResult,
  IntegrationUpdate
} from "./Integration.ts"

const IdParams = { id: Schema.String }

export class IntegrationsApi extends HttpApiGroup.make("integrations")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(Integration) }),
    HttpApiEndpoint.post("create", "/", { payload: IntegrationCreate, success: Integration, error: BadRequest }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: IdParams,
      payload: IntegrationUpdate,
      success: Integration,
      error: [IntegrationNotFound, BadRequest]
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: IdParams,
      success: HttpApiSchema.NoContent,
      error: IntegrationNotFound
    }),
    HttpApiEndpoint.post("test", "/:id/test", {
      params: IdParams,
      success: IntegrationTestResult,
      error: IntegrationNotFound
    }),
    HttpApiEndpoint.post("testConfig", "/test", { payload: IntegrationCreate, success: IntegrationTestResult })
  )
  .middleware(Authorization)
  .prefix("/v1/integrations")
{}
