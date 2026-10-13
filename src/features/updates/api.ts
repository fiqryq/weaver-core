import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { BadRequest } from "../../platform/http/errors.ts"
import { NoUpdate, UpdateChannel, UpdateCheck, UpdateInProgress, UpdateRequest, UpdatesUnsupported } from "./Update.ts"

/** The server's own updates: what's newer on a release channel, and installing it through the root-side updater. */
export class UpdatesApi extends HttpApiGroup.make("updates")
  .add(
    HttpApiEndpoint.get("check", "/", {
      query: { channel: Schema.optional(UpdateChannel), refresh: Schema.optional(Schema.String) },
      success: UpdateCheck
    }),
    HttpApiEndpoint.post("install", "/", {
      payload: UpdateRequest,
      success: UpdateCheck.pipe(HttpApiSchema.status(202)),
      error: [UpdatesUnsupported, UpdateInProgress, NoUpdate, BadRequest]
    })
  )
  .middleware(Authorization)
  .prefix("/v1/update")
{}
