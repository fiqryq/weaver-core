import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AppConfig } from "../../../config/Config.ts"
import { nowIso } from "../../../platform/lib/util.ts"
import { BotNotFound } from "../../bots/Bot.ts"
import { BotRepo } from "../../bots/BotRepo.ts"
import { RunEvents } from "../../runs/RunEvents.ts"
import { applyPatch, type SkillPatch } from "../skills/edits.ts"
import { invalid, notFound, SkillExists, type SkillInvalid, type SkillNotFound, SkillStorageError } from "../skills/errors.ts"
import {
  archiveDir,
  blockedAt,
  copySkillDir,
  freeArchivePath,
  io,
  isSkillDir,
  type LocatedSkill,
  maxFileBytes,
  readOrUndefined,
  removeIfEmpty,
  scanSkills,
  skillFile,
  statOrUndefined,
  supportingFiles,
  validateFilePath,
  writeAtomic
} from "../skills/files.ts"
import { fieldText, parseFrontmatter, truncateDescription, validateCategory, validateName, validateSkillMd } from "../skills/frontmatter.ts"
import type { SkillIndexEntry } from "../skills/SkillStore.ts"
import { SkillStore } from "../skills/SkillStore.ts"
import { introducedThreat } from "../skills/threats.ts"
import { parseRecords, usageFile } from "../skills/usage.ts"
import { maxSkillBytes, maxSkillFiles, prepareBundle, reservedNames } from "./bundle.ts"
import {
  InstallResult,
  LibraryAuthor,
  LibrarySkillDetail,
  LibrarySkillSummary,
  type SkillBundle,
  SkillSource
} from "./LibrarySkill.ts"

export const libraryDir = "skills-library"

const LibraryRecord = Schema.Struct({
  createdBy: LibraryAuthor,
  source: Schema.NullOr(SkillSource),
  useCount: Schema.Int,
  viewCount: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String)
})
type LibraryRecord = typeof LibraryRecord.Type
type Records = Record<string, LibraryRecord>
const isLibraryRecord = Schema.is(LibraryRecord)

export interface InstallOptions {
  readonly name?: string | undefined
  readonly force?: boolean | undefined
  readonly assignBotIds?: ReadonlyArray<string> | undefined
  readonly createdBy: LibraryAuthor
  readonly source: SkillSource | null
}

const exists = (name: string) =>
  new SkillExists({ skill: name, message: `A skill named ${name} is already in your library.` })

/**
 * The shared skills library at `<dataDir>/skills-library/`: skills the person writes, imports or
 * installs and assigns to bots (`Bot.librarySkills`). Same SKILL.md format as a bot's own skills, but
 * supporting files may sit at any safe relative path. Bots can change the skills assigned to them
 * (the previous version is archived first) but can't create or delete library skills.
 */
export class LibraryStore extends Context.Service<LibraryStore, {
  readonly list: Effect.Effect<ReadonlyArray<LibrarySkillSummary>, SkillStorageError>
  readonly names: Effect.Effect<ReadonlySet<string>, SkillStorageError>
  get(name: string): Effect.Effect<LibrarySkillDetail, SkillNotFound | SkillStorageError>
  summary(name: string): Effect.Effect<LibrarySkillSummary, SkillNotFound | SkillStorageError>
  readFile(name: string, path: string): Effect.Effect<Uint8Array, SkillNotFound | SkillInvalid | SkillStorageError>
  create(
    input: { readonly name: string; readonly content: string; readonly category?: string | undefined },
    assignBotIds?: ReadonlyArray<string>
  ): Effect.Effect<LibrarySkillDetail, SkillInvalid | SkillExists | SkillStorageError>
  /** The person replaces SKILL.md; the previous version is archived. */
  edit(name: string, content: string): Effect.Effect<LibrarySkillDetail, SkillNotFound | SkillInvalid | SkillStorageError>
  /** Archives the skill and takes it off every bot. */
  remove(name: string): Effect.Effect<void, SkillNotFound | SkillStorageError>
  /** Assigns the skill to exactly these bots. */
  setBots(name: string, botIds: ReadonlyArray<string>): Effect.Effect<LibrarySkillSummary, SkillNotFound | SkillInvalid | SkillStorageError>
  /** Adds a downloaded or uploaded skill; with threat-scan findings and no `force`, nothing is installed. */
  install(bundle: SkillBundle, options: InstallOptions): Effect.Effect<InstallResult, SkillInvalid | SkillExists | SkillStorageError>
  /** Moves a bot's own skill into the library and assigns it to that bot. */
  promote(botId: string, name: string): Effect.Effect<LibrarySkillDetail, BotNotFound | SkillNotFound | SkillExists | SkillInvalid | SkillStorageError>
  /** A bot's changes; each archives the skill first. */
  patch(name: string, patch: SkillPatch): Effect.Effect<number, SkillNotFound | SkillInvalid | SkillStorageError>
  replaceContent(name: string, content: string): Effect.Effect<void, SkillNotFound | SkillInvalid | SkillStorageError>
  writeFile(name: string, path: string, content: string): Effect.Effect<void, SkillNotFound | SkillInvalid | SkillStorageError>
  removeFile(name: string, path: string): Effect.Effect<void, SkillNotFound | SkillInvalid | SkillStorageError>
  recordView(name: string): Effect.Effect<void, SkillStorageError>
  /** The prompt index entries of these skills; names that aren't in the library are left out. */
  index(names: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<SkillIndexEntry>, SkillStorageError>
  fingerprint(name: string): Effect.Effect<string | undefined, SkillStorageError>
  folderOf(name: string): Effect.Effect<LocatedSkill | undefined, SkillStorageError>
}>()("weaver/LibraryStore") {
  static readonly layer = Layer.effect(
    LibraryStore,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const events = yield* RunEvents
      const bots = yield* BotRepo
      const skills = yield* SkillStore

      const root = join(config.dataDir, libraryDir)
      const writes = Semaphore.makeUnsafe(1)
      const usageLock = Semaphore.makeUnsafe(1)
      const changed = events.publish({ type: "skill-library-changed" })

      const ensureRoot = io(async () => {
        await mkdir(root, { recursive: true, mode: 0o700 })
        await chmod(root, 0o700)
      })

      const scan = io(() => scanSkills(root))
      const findSkill = (name: string) =>
        validateName(name) === undefined
          ? Effect.map(scan, (all) => all.find((skill) => skill.name === name))
          : Effect.succeed(undefined)
      const locate = (name: string) =>
        Effect.flatMap(findSkill(name), (found) => (found === undefined ? Effect.fail(notFound(name)) : Effect.succeed(found)))

      const readRecords = io(async () => parseRecords(await readOrUndefined(join(root, usageFile)), isLibraryRecord))
      const updateRecords = (update: (records: Records, now: string) => void) =>
        usageLock.withPermit(Effect.gen(function*() {
          const now = yield* nowIso
          const records = { ...(yield* readRecords) }
          update(records, now)
          yield* ensureRoot
          yield* io(() => writeAtomic(join(root, usageFile), `${JSON.stringify(records, null, 2)}\n`))
        }))
      const touch = (name: string) =>
        updateRecords((records, now) => {
          const record = records[name]
          if (record !== undefined) records[name] = { ...record, updatedAt: now }
        })
      const newRecord = (createdBy: LibraryAuthor, source: SkillSource | null, now: string, useCount = 0): LibraryRecord => ({
        createdBy,
        source,
        useCount,
        viewCount: 0,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null
      })

      const readSkillMd = (located: LocatedSkill) => io(async () => (await readOrUndefined(join(located.dir, skillFile))) ?? "")

      const summaryOf = (located: LocatedSkill, content: string, records: Records, botIds: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          const parsed = parseFrontmatter(content)
          const record = records[located.name]
          const updatedAt = record?.updatedAt ?? (yield* io(async () =>
            ((await statOrUndefined(join(located.dir, skillFile)))?.mtime ?? new Date(0)).toISOString()
          ))
          return new LibrarySkillSummary({
            name: located.name,
            description: typeof parsed === "string" ? "" : fieldText(parsed.fields.description),
            category: located.category.length > 0 ? located.category : null,
            createdBy: record?.createdBy ?? "user",
            source: record?.source ?? null,
            assignedBotIds: botIds,
            useCount: record?.useCount ?? 0,
            updatedAt,
            lastUsedAt: record?.lastUsedAt ?? null
          })
        })

      const assignments = Effect.map(bots.list, (all) => (name: string) =>
        all.filter((bot) => bot.librarySkills.includes(name)).map((bot) => bot.id)
      )

      const summary = Effect.fn("LibraryStore.summary")(function*(name: string) {
        const located = yield* locate(name)
        return yield* summaryOf(located, yield* readSkillMd(located), yield* readRecords, (yield* assignments)(name))
      })

      const detailOf = (located: LocatedSkill) =>
        Effect.gen(function*() {
          const content = yield* readSkillMd(located)
          const base = yield* summaryOf(located, content, yield* readRecords, (yield* assignments)(located.name))
          const files = yield* io(() => supportingFiles(located.dir, true))
          return new LibrarySkillDetail({ ...base, content, files })
        })

      const list = Effect.gen(function*() {
        const records = yield* readRecords
        const assigned = yield* assignments
        return yield* Effect.forEach(yield* scan, (located) =>
          Effect.flatMap(readSkillMd(located), (content) => summaryOf(located, content, records, assigned(located.name))))
      }).pipe(Effect.withSpan("LibraryStore.list"))

      const names = Effect.map(scan, (all) => new Set(all.map((skill) => skill.name)) as ReadonlySet<string>)

      const get = Effect.fn("LibraryStore.get")(function*(name: string) {
        return yield* detailOf(yield* locate(name))
      })

      /** Resolves a supporting file inside a skill, refusing symlinks on the way. */
      const supportingPath = (located: LocatedSkill, path: string) =>
        Effect.gen(function*() {
          const problem = validateFilePath(path, true)
          if (problem !== undefined) return yield* invalid(problem)
          const relative = path.split(/[/\\]/).join("/")
          const blocked = yield* io(() => blockedAt(located.dir, relative))
          if (blocked === "link") return yield* invalid(`"${path}" goes through a symbolic link, which skills can't use.`)
          if (blocked === "file") return yield* invalid(`"${path}" goes through a file as if it were a folder. Pick another path.`)
          return { relative, target: join(located.dir, relative) }
        })

      const existingFile = (located: LocatedSkill, path: string) =>
        Effect.gen(function*() {
          const { relative, target } = yield* supportingPath(located, path)
          const info = yield* io(() => statOrUndefined(target))
          if (info === undefined || !info.isFile()) {
            const files = yield* io(() => supportingFiles(located.dir, true))
            const available = files.length > 0 ? ` Its files: ${files.join(", ")}.` : " It has no supporting files."
            return yield* invalid(`There's no file "${path}" in skill "${located.name}".${available}`)
          }
          return { relative, target }
        })

      const readSkillFile = Effect.fn("LibraryStore.readFile")(function*(name: string, path: string) {
        const located = yield* locate(name)
        if (path === skillFile) return new TextEncoder().encode(yield* readSkillMd(located))
        const { target } = yield* existingFile(located, path)
        return new Uint8Array(yield* io(() => readFile(target)))
      })

      const stampOf = Effect.map(nowIso, (now) => now.replace(/[-:.]/g, ""))

      /** Copies the skill's current folder into `.archive/<name>-<stamp>/`. */
      const archive = (located: LocatedSkill) =>
        Effect.gen(function*() {
          const stamp = yield* stampOf
          yield* io(async () => copySkillDir(located.dir, await freeArchivePath(join(root, archiveDir), located.name, stamp)))
        })

      const checkBots = (botIds: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          const known = new Set((yield* bots.list).map((bot) => bot.id))
          const unknown = botIds.filter((id) => !known.has(id))
          if (unknown.length > 0) return yield* invalid(`Unknown bot: ${unknown.join(", ")}`)
        })

      /** The folder a new skill goes in, or why it can't. */
      const freeDir = (name: string, category: string) =>
        Effect.gen(function*() {
          if ((yield* findSkill(name)) !== undefined) return yield* exists(name)
          if (category.length > 0 && (yield* io(() => isSkillDir(join(root, category))))) {
            return yield* invalid(`"${category}" is a skill, not a category. Pick another category.`)
          }
          const relative = category.length > 0 ? `${category}/${name}` : name
          const blocked = yield* io(() => blockedAt(root, relative))
          if (blocked !== undefined) return yield* invalid(`"${relative}" is in the way in the library. Pick another name.`)
          if ((yield* io(() => statOrUndefined(join(root, relative)))) !== undefined) {
            return yield* invalid(`"${name}" is already used by a folder in the library. Pick another name.`)
          }
          return join(root, relative)
        })

      /** Writes a new skill folder in one rename, so a half-written skill never shows up. */
      const writeNew = (dir: string, content: string, files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>) =>
        Effect.gen(function*() {
          yield* ensureRoot
          yield* io(async () => {
            const temp = join(root, `.new-${crypto.randomUUID()}`)
            try {
              await writeAtomic(join(temp, skillFile), content)
              for (const file of files) await writeAtomic(join(temp, file.path), file.bytes)
              await mkdir(dirname(dir), { recursive: true })
              await rename(temp, dir)
            } finally {
              await rm(temp, { recursive: true, force: true })
            }
          })
        })

      const assign = (name: string, botIds: ReadonlyArray<string> | undefined) =>
        botIds === undefined || botIds.length === 0 ? Effect.void : Effect.asVoid(bots.assignLibrarySkill(name, botIds, { only: false }))

      const create = Effect.fn("LibraryStore.create")(function*(
        input: { readonly name: string; readonly content: string; readonly category?: string | undefined },
        assignBotIds?: ReadonlyArray<string>
      ) {
        const name = input.name.trim()
        const category = input.category?.trim() ?? ""
        const problem = validateName(name) ?? validateCategory(category) ??
          (reservedNames.has(name) ? `"${name}" can't be used as a library skill name. Pick another name.` : undefined) ??
          validateSkillMd(name, input.content, false)
        if (problem !== undefined) return yield* invalid(problem)
        yield* checkBots(assignBotIds ?? [])
        const detail = yield* writes.withPermit(Effect.gen(function*() {
          const dir = yield* freeDir(name, category)
          yield* writeNew(dir, input.content, [])
          yield* updateRecords((records, now) => {
            records[name] = newRecord("user", null, now)
          })
          yield* assign(name, assignBotIds)
          return yield* detailOf({ name, category, dir })
        }))
        yield* changed
        return detail
      })

      const install = Effect.fn("LibraryStore.install")(function*(bundle: SkillBundle, options: InstallOptions) {
        const prepared = prepareBundle(bundle, options.name)
        if (typeof prepared === "string") return yield* invalid(prepared)
        if (prepared.warnings.length > 0 && options.force !== true) {
          return new InstallResult({ skill: null, warnings: prepared.warnings, installed: false })
        }
        yield* checkBots(options.assignBotIds ?? [])
        const skill = yield* writes.withPermit(Effect.gen(function*() {
          const dir = yield* freeDir(prepared.name, "")
          yield* writeNew(dir, prepared.content, prepared.files)
          yield* updateRecords((records, now) => {
            records[prepared.name] = newRecord(options.createdBy, options.source, now)
          })
          yield* assign(prepared.name, options.assignBotIds)
          return yield* detailOf({ name: prepared.name, category: "", dir })
        }))
        yield* changed
        return new InstallResult({ skill, warnings: prepared.warnings, installed: true })
      })

      const edit = Effect.fn("LibraryStore.edit")(function*(name: string, content: string) {
        const problem = validateSkillMd(name, content, false)
        if (problem !== undefined) return yield* invalid(problem)
        const detail = yield* writes.withPermit(Effect.gen(function*() {
          const located = yield* locate(name)
          if ((yield* readSkillMd(located)) !== content) {
            yield* archive(located)
            yield* io(() => writeAtomic(join(located.dir, skillFile), content))
            yield* touch(name)
          }
          return yield* detailOf(located)
        }))
        yield* changed
        return detail
      })

      const remove = Effect.fn("LibraryStore.remove")(function*(name: string) {
        yield* writes.withPermit(Effect.gen(function*() {
          const located = yield* locate(name)
          const stamp = yield* stampOf
          yield* io(async () => {
            await rename(located.dir, await freeArchivePath(join(root, archiveDir), located.name, stamp))
            if (located.category.length > 0) await removeIfEmpty(dirname(located.dir))
          })
          yield* updateRecords((records) => {
            delete records[name]
          })
          yield* bots.assignLibrarySkill(name, [])
        }))
        yield* changed
      })

      const setBots = Effect.fn("LibraryStore.setBots")(function*(name: string, botIds: ReadonlyArray<string>) {
        yield* locate(name)
        yield* checkBots(botIds)
        yield* bots.assignLibrarySkill(name, botIds)
        yield* changed
        return yield* summary(name)
      })

      const promote = Effect.fn("LibraryStore.promote")(function*(botId: string, name: string) {
        yield* bots.get(botId)
        const own = yield* skills.get(botId, name)
        const ownDir = yield* skills.folderOf(botId, name)
        if (ownDir === undefined) return yield* notFound(name)
        if (reservedNames.has(name)) return yield* invalid(`"${name}" can't be used as a library skill name. Rename it first.`)
        const files = yield* io(() => supportingFiles(ownDir.dir, true))
        if (files.length + 1 > maxSkillFiles) return yield* invalid(`The skill has more than ${maxSkillFiles} files.`)
        const detail = yield* writes.withPermit(Effect.gen(function*() {
          const dir = yield* freeDir(name, ownDir.category)
          yield* ensureRoot
          yield* io(async () => {
            const temp = join(root, `.new-${crypto.randomUUID()}`)
            try {
              await copySkillDir(ownDir.dir, temp)
              await mkdir(dirname(dir), { recursive: true })
              await rename(temp, dir)
            } finally {
              await rm(temp, { recursive: true, force: true })
            }
          })
          yield* updateRecords((records, now) => {
            records[name] = newRecord(own.createdBy, { kind: "bot", botId }, now, own.useCount)
          })
          yield* bots.assignLibrarySkill(name, [botId], { only: false })
          yield* skills.remove(botId, name).pipe(Effect.catchTag("SkillNotFound", () => Effect.void))
          return yield* detailOf({ name, category: ownDir.category, dir })
        }))
        yield* changed
        return detail
      })

      /** A bot's change: the skill is archived first, then changed, and everyone is told. */
      const botChange = <A, E>(name: string, change: (located: LocatedSkill) => Effect.Effect<A | undefined, E>, write: (located: LocatedSkill, value: A) => Effect.Effect<void, SkillStorageError>) =>
        Effect.gen(function*() {
          const result = yield* writes.withPermit(Effect.gen(function*() {
            const located = yield* locate(name)
            const value = yield* change(located)
            if (value === undefined) return false
            yield* archive(located)
            yield* write(located, value)
            yield* touch(name)
            return true
          }))
          if (result) yield* changed
        })

      const patch = Effect.fn("LibraryStore.patch")(function*(name: string, input: SkillPatch) {
        if (input.old_string.length === 0) return yield* invalid("old_string is required; give the exact text to replace.")
        let count = 0
        yield* botChange(
          name,
          (located) =>
            Effect.gen(function*() {
              const filePath = input.file_path === undefined || input.file_path === skillFile ? undefined : input.file_path
              const { target } = filePath === undefined ? { target: join(located.dir, skillFile) } : yield* existingFile(located, filePath)
              const label = filePath ?? skillFile
              const content = yield* io(() => readFile(target, "utf8"))
              const applied = applyPatch(content, input, label)
              if (typeof applied === "string") return yield* invalid(applied)
              const problem = filePath === undefined
                ? validateSkillMd(name, applied.updated, false)
                : Buffer.byteLength(applied.updated, "utf8") > maxFileBytes
                ? `${label} would be larger than 1 MiB.`
                : undefined
              if (problem !== undefined) return yield* invalid(filePath === undefined ? `This patch would break SKILL.md: ${problem}` : problem)
              const threat = introducedThreat(content, applied.updated)
              if (threat !== undefined) return yield* invalid(threat)
              count = applied.count
              return applied.updated === content ? undefined : { target, content: applied.updated }
            }),
          (_, value) => io(() => writeAtomic(value.target, value.content))
        )
        return count
      })

      const replaceContent = Effect.fn("LibraryStore.replaceContent")(function*(name: string, content: string) {
        const problem = validateSkillMd(name, content, false)
        if (problem !== undefined) return yield* invalid(problem)
        yield* botChange(
          name,
          (located) =>
            Effect.gen(function*() {
              const before = yield* readSkillMd(located)
              const threat = introducedThreat(before, content)
              if (threat !== undefined) return yield* invalid(threat)
              return before === content ? undefined : content
            }),
          (located, value) => io(() => writeAtomic(join(located.dir, skillFile), value))
        )
      })

      const sizeOf = (dir: string) =>
        io(async () => {
          let total = 0
          const files = await supportingFiles(dir, true)
          for (const file of [skillFile, ...files]) total += (await statOrUndefined(join(dir, file)))?.size ?? 0
          return { total, count: files.length + 1 }
        })

      const writeSkillFile = Effect.fn("LibraryStore.writeFile")(function*(name: string, path: string, content: string) {
        if (path === skillFile) return yield* invalid("Use edit or patch to change SKILL.md.")
        const bytes = Buffer.byteLength(content, "utf8")
        if (bytes > maxFileBytes) {
          return yield* invalid(`The file is ${bytes.toLocaleString("en-US")} bytes (limit 1 MiB). Split it into smaller files.`)
        }
        yield* botChange(
          name,
          (located) =>
            Effect.gen(function*() {
              const { target } = yield* supportingPath(located, path)
              const info = yield* io(() => statOrUndefined(target))
              if (info !== undefined && !info.isFile()) return yield* invalid(`"${path}" is a folder.`)
              const before = info === undefined ? "" : yield* io(() => readFile(target, "utf8"))
              const threat = introducedThreat(before, content)
              if (threat !== undefined) return yield* invalid(threat)
              const size = yield* sizeOf(located.dir)
              if (info === undefined && size.count + 1 > maxSkillFiles) return yield* invalid(`A skill can have at most ${maxSkillFiles} files.`)
              if (size.total - (info?.size ?? 0) + bytes > maxSkillBytes) return yield* invalid("The skill would be larger than 10 MiB.")
              return before === content && info !== undefined ? undefined : target
            }),
          (_, target) => io(() => writeAtomic(target, content))
        )
      })

      const removeSkillFile = Effect.fn("LibraryStore.removeFile")(function*(name: string, path: string) {
        if (path === skillFile) return yield* invalid("SKILL.md can't be removed; only the person can delete library skills.")
        yield* botChange(
          name,
          (located) => Effect.map(existingFile(located, path), ({ target }) => target),
          (located, target) =>
            io(async () => {
              await rm(target)
              for (let dir = dirname(target); dir !== located.dir; dir = dirname(dir)) await removeIfEmpty(dir)
            })
        )
      })

      const recordView = Effect.fn("LibraryStore.recordView")(function*(name: string) {
        if ((yield* findSkill(name)) === undefined) return
        yield* updateRecords((records, now) => {
          const record = records[name] ?? newRecord("user", null, now)
          records[name] = { ...record, useCount: record.useCount + 1, viewCount: record.viewCount + 1, lastUsedAt: now }
        })
      })

      const index = Effect.fn("LibraryStore.index")(function*(wanted: ReadonlyArray<string>) {
        if (wanted.length === 0) return []
        const all = yield* scan
        const entries: Array<SkillIndexEntry> = []
        for (const located of all.filter((skill) => wanted.includes(skill.name))) {
          const parsed = parseFrontmatter(yield* readSkillMd(located))
          entries.push({
            name: located.name,
            description: truncateDescription(typeof parsed === "string" ? "" : fieldText(parsed.fields.description)),
            category: located.category,
            library: true
          })
        }
        return entries
      })

      const fingerprint = Effect.fn("LibraryStore.fingerprint")(function*(name: string) {
        const located = yield* findSkill(name)
        if (located === undefined) return undefined
        return Bun.hash(yield* readSkillMd(located)).toString(36)
      })

      return LibraryStore.of({
        list,
        names,
        get,
        summary,
        readFile: readSkillFile,
        create,
        edit,
        remove,
        setBots,
        install,
        promote,
        patch,
        replaceContent,
        writeFile: writeSkillFile,
        removeFile: removeSkillFile,
        recordView,
        index,
        fingerprint,
        folderOf: findSkill
      })
    })
  )
}
