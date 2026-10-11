import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import { Team, TeamCreate, TeamNotFound, TeamUpdate } from "./Team.ts"

const IdParams = { id: Schema.String }

export class TeamsApi extends HttpApiGroup.make("teams")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(Team) }),
    HttpApiEndpoint.get("get", "/:id", { params: IdParams, success: Team, error: TeamNotFound }),
    HttpApiEndpoint.post("create", "/", { payload: TeamCreate, success: Team, error: BadRequest }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: IdParams,
      payload: TeamUpdate,
      success: Team,
      error: [TeamNotFound, BadRequest]
    }),
    HttpApiEndpoint.delete("remove", "/:id", { params: IdParams, success: HttpApiSchema.NoContent, error: TeamNotFound }),
    HttpApiEndpoint.post("stop", "/:id/stop", { params: IdParams, success: Team, error: TeamNotFound }),
    HttpApiEndpoint.post("resume", "/:id/resume", { params: IdParams, success: Team, error: [TeamNotFound, Conflict] })
  )
  .middleware(Authorization)
  .prefix("/v1/teams")
{}
