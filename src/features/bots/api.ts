import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import { Bot, BotCreate, BotNotFound, BotUpdate } from "./Bot.ts"

const IdParams = { id: Schema.String }

export class BotsApi extends HttpApiGroup.make("bots")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(Bot) }),
    HttpApiEndpoint.get("get", "/:id", { params: IdParams, success: Bot, error: BotNotFound }),
    HttpApiEndpoint.post("create", "/", { payload: BotCreate, success: Bot, error: BadRequest }),
    HttpApiEndpoint.patch("update", "/:id", {
      params: IdParams,
      payload: BotUpdate,
      success: Bot,
      error: [BotNotFound, BadRequest]
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      params: IdParams,
      success: HttpApiSchema.NoContent,
      error: [BotNotFound, Conflict]
    })
  )
  .middleware(Authorization)
  .prefix("/v1/bots")
{}
