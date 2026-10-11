import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import { BotNotFound } from "../bots/Bot.ts"
import { SkillDetail, SkillNotFound, SkillSummary } from "./skills/SkillStore.ts"

const IdParams = { id: Schema.String }
const SkillParams = { id: Schema.String, name: Schema.String }

export const SkillPut = Schema.Struct({
  content: Schema.String,
  category: Schema.optional(Schema.String)
})

export const SkillCreate = Schema.Struct({
  name: Schema.String,
  content: Schema.String,
  category: Schema.optional(Schema.String)
})

/** A bot's skills, under the bot's path. */
export class SkillsApi extends HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("list", "/:id/skills", {
      params: IdParams,
      success: Schema.Struct({ skills: Schema.Array(SkillSummary) }),
      error: BotNotFound
    }),
    HttpApiEndpoint.post("create", "/:id/skills", {
      params: IdParams,
      payload: SkillCreate,
      success: SkillDetail,
      error: [BotNotFound, BadRequest, Conflict]
    }),
    HttpApiEndpoint.get("get", "/:id/skills/:name", {
      params: SkillParams,
      success: SkillDetail,
      error: [BotNotFound, SkillNotFound]
    }),
    HttpApiEndpoint.put("put", "/:id/skills/:name", {
      params: SkillParams,
      payload: SkillPut,
      success: SkillDetail,
      error: [BotNotFound, SkillNotFound, BadRequest]
    }),
    HttpApiEndpoint.delete("remove", "/:id/skills/:name", {
      params: SkillParams,
      success: HttpApiSchema.NoContent,
      error: [BotNotFound, SkillNotFound]
    })
  )
  .middleware(Authorization)
  .prefix("/v1/bots")
{}
