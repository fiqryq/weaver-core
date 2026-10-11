import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { BadRequest } from "../../platform/http/errors.ts"
import { IntegrationRepo } from "../integrations/IntegrationRepo.ts"
import { SelfReview } from "../learning/review/SelfReview.ts"
import { SkillStore } from "../learning/skills/SkillStore.ts"
import { BotRepo } from "./BotRepo.ts"

export const BotsHandlers = HttpApiBuilder.group(
  Api,
  "bots",
  Effect.fn(function*(handlers) {
    const bots = yield* BotRepo
    const integrations = yield* IntegrationRepo
    const skills = yield* SkillStore
    const selfReview = yield* SelfReview

    const checkIntegrations = (ids: ReadonlyArray<string> | undefined) =>
      Effect.gen(function*() {
        if (ids === undefined) return
        const known = new Set((yield* integrations.list).map((integration) => integration.id))
        const unknown = ids.filter((id) => !known.has(id))
        if (unknown.length > 0) return yield* new BadRequest({ message: `Unknown integration: ${unknown.join(", ")}` })
      })

    return handlers
      .handle("list", () => bots.list)
      .handle("get", ({ params }) => bots.get(params.id))
      .handle("create", ({ payload }) =>
        Effect.andThen(checkIntegrations(payload.integrationIds), bots.create(payload)))
      .handle("update", ({ params, payload }) =>
        Effect.andThen(checkIntegrations(payload.integrationIds), bots.update(params.id, payload)))
      .handle("remove", ({ params }) =>
        Effect.gen(function*() {
          yield* bots.remove(params.id)
          yield* selfReview.cancel(params.id)
          yield* Effect.orDie(skills.removeBot(params.id))
        }))
  })
)
