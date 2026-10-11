import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { BadRequest } from "../../platform/http/errors.ts"

const IdParams = { id: Schema.String }

export class RunsApi extends HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.post("cancel", "/runs/:id/cancel", { params: IdParams, success: HttpApiSchema.NoContent }),
    HttpApiEndpoint.post("approve", "/approvals/:id", {
      params: IdParams,
      payload: Schema.Struct({ approved: Schema.Boolean }),
      success: HttpApiSchema.NoContent,
      error: BadRequest
    })
  )
  .middleware(Authorization)
  .prefix("/v1")
{}
