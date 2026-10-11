import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { BadRequest, Conflict } from "../../platform/http/errors.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import type { LibraryImport } from "./api.ts"
import { limits, maxSkillBytes, maxSkillFiles } from "./library/bundle.ts"
import { LibraryStore } from "./library/LibraryStore.ts"
import { Catalog, type SkillBundle } from "./library/LibrarySkill.ts"
import { SkillSources } from "./library/SkillSources.ts"
import { isZip, readZip } from "./library/zip.ts"
import { type SkillExists, type SkillInvalid, type SkillStorageError, SkillStore } from "./skills/SkillStore.ts"

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

const maxBase64Chars = Math.ceil(maxSkillBytes / 3) * 4 + 4

const decodeBase64 = (text: string, what: string) =>
  text.length > maxBase64Chars
    ? Effect.fail(new BadRequest({ message: `${what} is larger than 10 MiB.` }))
    : Effect.succeed(new Uint8Array(Buffer.from(text, "base64")))

export const LibraryHandlers = HttpApiBuilder.group(
  Api,
  "library",
  Effect.fn(function*(handlers) {
    const library = yield* LibraryStore
    const sources = yield* SkillSources

    const badRequest = (error: SkillInvalid) => Effect.fail(new BadRequest({ message: error.message }))
    const conflict = (error: SkillExists) => Effect.fail(new Conflict({ message: error.message }))
    const die = (error: SkillStorageError) => Effect.die(error)
    const changeErrors = { SkillInvalid: badRequest, SkillStorageError: die }
    const addErrors = { SkillInvalid: badRequest, SkillExists: conflict, SkillStorageError: die }

    const importFiles = (payload: typeof LibraryImport.Type) =>
      Effect.gen(function*() {
        if ((payload.zipBase64 === undefined) === (payload.files === undefined)) {
          return yield* new BadRequest({ message: "Send either zipBase64 or files." })
        }
        if (payload.zipBase64 !== undefined) {
          const bytes = yield* decodeBase64(payload.zipBase64, "The zip")
          if (!isZip(bytes)) return yield* new BadRequest({ message: "zipBase64 isn't a zip file." })
          const files = readZip(bytes, limits)
          if (typeof files === "string") return yield* new BadRequest({ message: files })
          return { files } satisfies SkillBundle
        }
        const files = payload.files ?? []
        if (files.length > maxSkillFiles * 2) return yield* new BadRequest({ message: `The skill has more than ${maxSkillFiles} files.` })
        return {
          files: yield* Effect.forEach(files, (file) =>
            Effect.map(decodeBase64(file.contentBase64, file.path), (bytes) => ({ path: file.path, bytes })))
        } satisfies SkillBundle
      })

    return handlers
      .handle("list", () => Effect.map(Effect.orDie(library.list), (skills) => ({ skills })))
      .handle("catalog", () =>
        Effect.gen(function*() {
          const catalog = yield* sources.catalog
          const installed = yield* Effect.orDie(library.names)
          return new Catalog({ ...catalog, skills: catalog.skills.map((skill) => ({ ...skill, installed: installed.has(skill.name) })) })
        }))
      .handle("get", ({ params }) => library.get(params.name).pipe(Effect.catchTag("SkillStorageError", Effect.die)))
      .handle("file", ({ params, query }) =>
        Effect.gen(function*() {
          const bytes = yield* library.readFile(params.name, query.path).pipe(Effect.catchTags(changeErrors))
          const content = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: () => new BadRequest({ message: `${query.path} is a binary file.` })
          })
          if (content.includes("\u0000")) return yield* new BadRequest({ message: `${query.path} is a binary file.` })
          return { path: query.path, content }
        }))
      .handle("create", ({ payload }) =>
        library.create({ name: payload.name, content: payload.content, category: payload.category }, payload.assignBotIds).pipe(
          Effect.catchTags(addErrors)
        ))
      .handle("put", ({ params, payload }) => library.edit(params.name, payload.content).pipe(Effect.catchTags(changeErrors)))
      .handle("remove", ({ params }) => library.remove(params.name).pipe(Effect.catchTag("SkillStorageError", Effect.die)))
      .handle("bots", ({ params, payload }) => library.setBots(params.name, payload.botIds).pipe(Effect.catchTags(changeErrors)))
      .handle("install", ({ payload }) =>
        Effect.gen(function*() {
          const { bundle, source } = yield* sources.fetch(payload.url).pipe(Effect.catchTag("SkillInvalid", badRequest))
          return yield* library.install(bundle, {
            name: payload.name,
            force: payload.force,
            assignBotIds: payload.assignBotIds,
            createdBy: "import",
            source
          }).pipe(Effect.catchTags(addErrors))
        }))
      .handle("import", ({ payload }) =>
        Effect.gen(function*() {
          const bundle = yield* importFiles(payload)
          return yield* library.install(bundle, {
            name: payload.name,
            force: payload.force,
            assignBotIds: payload.assignBotIds,
            createdBy: "import",
            source: { kind: "file" }
          }).pipe(Effect.catchTags(addErrors))
        }))
      .handle("promote", ({ payload }) => library.promote(payload.botId, payload.name).pipe(Effect.catchTags(addErrors)))
  })
)
