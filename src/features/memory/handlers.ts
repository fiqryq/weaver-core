import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { KnowledgeBase } from "./KnowledgeBase.ts"

export const MemoryHandlers = HttpApiBuilder.group(
  Api,
  "memory",
  Effect.fn(function*(handlers) {
    const knowledge = yield* KnowledgeBase

    return handlers
      .handle("projects", () => knowledge.projects)
      .handle("createProject", ({ payload }) => knowledge.createProject(payload.name))
      .handle("removeProject", ({ params }) => knowledge.removeProject(params.name))
      .handle("graph", ({ query }) => knowledge.graph(query.project ?? "", query.refresh !== undefined))
      .handle("history", ({ query }) => knowledge.history(query.project ?? "", query.identifier))
      .handle("version", ({ params }) => knowledge.version(params.id))
      .handle("restore", ({ params, payload }) => knowledge.restore(params.id, payload.source?.trim() || "You"))
      .handle("capture", ({ payload }) =>
        knowledge.capture(payload.project ?? "", payload.identifier, payload.source?.trim() || "You"))
  })
)
