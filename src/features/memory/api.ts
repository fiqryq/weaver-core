import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Authorization } from "../../platform/http/Authorization.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import {
  MemoryGraph,
  MemoryNoteNotFound,
  MemoryProject,
  MemoryProjectNotFound,
  MemoryProjects,
  MemoryUnavailable,
  MemoryVersionNotFound,
  NoteHistory,
  NoteVersion,
  NoteVersionContent
} from "./Memory.ts"

const IdParams = { id: Schema.String }
/** Empty or left out means the shared project. */
const Project = Schema.optional(Schema.String)

/** Basic Memory as the person sees it: projects, each project's knowledge graph, and note history. */
export class MemoryApi extends HttpApiGroup.make("memory")
  .add(
    HttpApiEndpoint.get("projects", "/projects", { success: MemoryProjects, error: MemoryUnavailable }),
    HttpApiEndpoint.post("createProject", "/projects", {
      payload: Schema.Struct({ name: Schema.String }),
      success: MemoryProject,
      error: [MemoryUnavailable, BadRequest, Conflict]
    }),
    HttpApiEndpoint.delete("removeProject", "/projects/:name", {
      params: { name: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [MemoryUnavailable, MemoryProjectNotFound, BadRequest]
    }),
    HttpApiEndpoint.get("graph", "/graph", {
      query: { project: Project, refresh: Schema.optional(Schema.String) },
      success: MemoryGraph,
      error: MemoryUnavailable
    }),
    HttpApiEndpoint.get("history", "/history", {
      query: { identifier: Schema.String, project: Project },
      success: NoteHistory,
      error: [MemoryUnavailable, MemoryNoteNotFound]
    }),
    HttpApiEndpoint.get("version", "/versions/:id", { params: IdParams, success: NoteVersionContent, error: MemoryVersionNotFound }),
    HttpApiEndpoint.post("restore", "/versions/:id/restore", {
      params: IdParams,
      payload: Schema.Struct({ source: Schema.optional(Schema.String) }),
      success: NoteVersion,
      error: [MemoryUnavailable, MemoryVersionNotFound]
    }),
    /** Saves a version of a note someone changed without the server, e.g. the Mac app before and after an edit. */
    HttpApiEndpoint.post("capture", "/capture", {
      payload: Schema.Struct({ identifier: Schema.String, project: Project, source: Schema.optional(Schema.String) }),
      success: HttpApiSchema.NoContent
    })
  )
  .middleware(Authorization)
  .prefix("/v1/memory")
{}
