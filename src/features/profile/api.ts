import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { Profile, ProfileUpdate } from "./Profile.ts"

export class ProfileApi extends HttpApiGroup.make("profile")
  .add(
    HttpApiEndpoint.get("get", "/", { success: Profile }),
    HttpApiEndpoint.put("update", "/", { payload: ProfileUpdate, success: Profile })
  )
  .middleware(Authorization)
  .prefix("/v1/profile")
{}
