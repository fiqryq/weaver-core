import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import { BotNotFound } from "../bots/Bot.ts"
import { Catalog, InstallResult, LibrarySkillDetail, LibrarySkillSummary } from "./library/LibrarySkill.ts"
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

const NameParams = { name: Schema.String }
const BotIds = Schema.optional(Schema.Array(Schema.String))

export const LibraryCreate = Schema.Struct({
  name: Schema.String,
  content: Schema.String,
  category: Schema.optional(Schema.String),
  assignBotIds: BotIds
})

export const LibraryInstall = Schema.Struct({
  url: Schema.String,
  assignBotIds: BotIds,
  force: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String)
})

export const LibraryImport = Schema.Struct({
  zipBase64: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String, contentBase64: Schema.String }))),
  assignBotIds: BotIds,
  force: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String)
})

/** The shared skills library, assigned to bots through `Bot.librarySkills`. */
export class LibraryApi extends HttpApiGroup.make("library")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Struct({ skills: Schema.Array(LibrarySkillSummary) }) }),
    HttpApiEndpoint.get("catalog", "/catalog", { success: Catalog }),
    HttpApiEndpoint.post("create", "/", { payload: LibraryCreate, success: LibrarySkillDetail, error: [BadRequest, Conflict] }),
    HttpApiEndpoint.post("install", "/install", { payload: LibraryInstall, success: InstallResult, error: [BadRequest, Conflict] }),
    HttpApiEndpoint.post("import", "/import", { payload: LibraryImport, success: InstallResult, error: [BadRequest, Conflict] }),
    HttpApiEndpoint.post("promote", "/promote", {
      payload: Schema.Struct({ botId: Schema.String, name: Schema.String }),
      success: LibrarySkillDetail,
      error: [BotNotFound, SkillNotFound, BadRequest, Conflict]
    }),
    HttpApiEndpoint.get("get", "/:name", { params: NameParams, success: LibrarySkillDetail, error: SkillNotFound }),
    HttpApiEndpoint.get("file", "/:name/file", {
      params: NameParams,
      query: { path: Schema.String },
      success: Schema.Struct({ path: Schema.String, content: Schema.String }),
      error: [SkillNotFound, BadRequest]
    }),
    HttpApiEndpoint.put("put", "/:name", {
      params: NameParams,
      payload: Schema.Struct({ content: Schema.String }),
      success: LibrarySkillDetail,
      error: [SkillNotFound, BadRequest]
    }),
    HttpApiEndpoint.delete("remove", "/:name", { params: NameParams, success: HttpApiSchema.NoContent, error: SkillNotFound }),
    HttpApiEndpoint.put("bots", "/:name/bots", {
      params: NameParams,
      payload: Schema.Struct({ botIds: Schema.Array(Schema.String) }),
      success: LibrarySkillSummary,
      error: [SkillNotFound, BadRequest]
    })
  )
  .middleware(Authorization)
  .prefix("/v1/skills")
{}
