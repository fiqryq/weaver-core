import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { BadRequest } from "../../platform/http/errors.ts"
import {
  Integration,
  IntegrationCreate,
  IntegrationNotFound,
  IntegrationTestResult,
  IntegrationUpdate,
  OAuthFinishRequest,
  OAuthStart,
  OAuthStartRequest
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
    HttpApiEndpoint.post("testConfig", "/test", { payload: IntegrationCreate, success: IntegrationTestResult }),
    HttpApiEndpoint.post("oauthStart", "/:id/oauth/start", {
      params: IdParams,
      payload: OAuthStartRequest,
      success: OAuthStart,
      error: [IntegrationNotFound, BadRequest]
    }),
    HttpApiEndpoint.post("oauthFinish", "/:id/oauth/finish", {
      params: IdParams,
      payload: OAuthFinishRequest,
      success: IntegrationTestResult,
      error: [IntegrationNotFound, BadRequest]
    }),
    HttpApiEndpoint.delete("oauthSignOut", "/:id/oauth", {
      params: IdParams,
      success: HttpApiSchema.NoContent,
      error: [IntegrationNotFound, BadRequest]
    })
  )
  .middleware(Authorization)
  .prefix("/v1/integrations")
{}
