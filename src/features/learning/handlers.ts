import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import { type SkillInvalid, type SkillStorageError, SkillStore } from "./skills/SkillStore.ts"

export const SkillsHandlers = HttpApiBuilder.group(
  Api,
  "skills",
  Effect.fn(function*(handlers) {
    const bots = yield* BotRepo
    const skills = yield* SkillStore

    const skillErrors = {
      SkillInvalid: (error: SkillInvalid) => Effect.fail(new BadRequest({ message: error.message })),
      SkillStorageError: (error: SkillStorageError) => Effect.die(error)
    }

    return handlers
      .handle("list", ({ params }) =>
        Effect.andThen(bots.get(params.id), Effect.map(Effect.orDie(skills.list(params.id)), (list) => ({ skills: list }))))
      .handle("get", ({ params }) =>
        Effect.andThen(bots.get(params.id), skills.get(params.id, params.name).pipe(Effect.catchTag("SkillStorageError", Effect.die))))
      .handle("create", ({ params, payload }) =>
        Effect.gen(function*() {
          yield* bots.get(params.id)
          return yield* skills.create(params.id, payload, "user").pipe(
            Effect.catchTags({
              ...skillErrors,
              SkillExists: (error) => Effect.fail(new Conflict({ message: `There's already a skill called ${error.skill}.` }))
            })
          )
        }))
      .handle("put", ({ params, payload }) =>
        Effect.gen(function*() {
          yield* bots.get(params.id)
          const existing = yield* Effect.option(skills.get(params.id, params.name))
          if (existing._tag === "Some") {
            return yield* skills.replaceContent(params.id, params.name, payload.content, "user", payload.category).pipe(
              Effect.catchTags(skillErrors)
            )
          }
          return yield* skills.create(params.id, { name: params.name, content: payload.content, category: payload.category }, "user")
            .pipe(Effect.catchTags({ ...skillErrors, SkillExists: (error) => Effect.fail(new BadRequest({ message: error.message })) }))
        }))
      .handle("remove", ({ params }) =>
        Effect.andThen(bots.get(params.id), skills.remove(params.id, params.name).pipe(Effect.catchTag("SkillStorageError", Effect.die))))
  })
)
