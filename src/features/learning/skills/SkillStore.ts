import { Context, Effect, Layer, Semaphore } from "effect"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AppConfig } from "../../../config/Config.ts"
import { nowIso } from "../../../platform/lib/util.ts"
import { RunEvents } from "../../runs/RunEvents.ts"
import { invalid, notFound, SkillExists, type SkillInvalid, type SkillNotFound, SkillStorageError } from "./errors.ts"
import {
  archiveDir,
  blockedAt,
  entriesOf,
  freeArchivePath,
  io,
  isSkillDir,
  maxFileBytes,
  readOrUndefined,
  removeIfEmpty,
  skillFile,
  statOrUndefined,
  supportingFiles,
  validateFilePath,
  writeAtomic
} from "./files.ts"
import {
  fieldText,
  parseFrontmatter,
  truncateDescription,
  validateCategory,
  validateName,
  validateSkillMd,
  validName
} from "./frontmatter.ts"
import { type SkillAuthor, SkillDetail, SkillSummary } from "./Skill.ts"
import { introducedThreat } from "./threats.ts"
import { parseUsage, type Usage, usageFile } from "./usage.ts"

export { SkillExists, SkillInvalid, SkillNotFound, SkillStorageError } from "./errors.ts"
export { maxFileBytes, maxFilePathBytes, maxPathSegmentBytes, supportDirs, validateFilePath } from "./files.ts"
export {
  indexDescriptionLength,
  maxDescriptionLength,
  maxNameLength,
  maxSkillChars,
  parseFrontmatter,
  truncateDescription,
  validateCategory,
  validateName,
  validateSkillMd
} from "./frontmatter.ts"
export { SkillAuthor, SkillDetail, SkillSummary } from "./Skill.ts"
export { introducedThreat, scanThreats } from "./threats.ts"

export interface SkillIndexEntry {
  readonly name: string
  readonly description: string
  readonly category: string
}

export interface SkillPatch {
  readonly old_string: string
  readonly new_string: string
  readonly replace_all?: boolean | undefined
  readonly file_path?: string | undefined
}

const countOf = (text: string, search: string): number => {
  let count = 0
  for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) count++
  return count
}

interface Located {
  readonly name: string
  readonly category: string
  readonly dir: string
}

/** Permits on a bot's lock: every change takes one, and deleting the bot takes them all. */
const botPermits = 1024

/**
 * Each bot's skills: reusable instructions it writes for itself, kept at `<dataDir>/bots/<id>/skills/`
 * as `[category/]<name>/SKILL.md` with optional supporting files. That's beside the bot's workspace, so
 * its file tools can't reach them, and changes through the skill tools and API are validated here. It's
 * only a boundary against run_command when commands run as a separate bot user (`WEAVER_BOT_USER`).
 */
export class SkillStore extends Context.Service<SkillStore, {
  list(botId: string): Effect.Effect<ReadonlyArray<SkillSummary>, SkillStorageError>
  get(botId: string, name: string): Effect.Effect<SkillDetail, SkillNotFound | SkillStorageError>
  readFile(botId: string, name: string, path: string): Effect.Effect<string, SkillNotFound | SkillInvalid | SkillStorageError>
  create(
    botId: string,
    input: { readonly name: string; readonly content: string; readonly category?: string | undefined },
    by: SkillAuthor
  ): Effect.Effect<SkillDetail, SkillInvalid | SkillExists | SkillStorageError>
  /** Edits SKILL.md, or a supporting file with `file_path`; returns how many replacements were made. */
  patch(botId: string, name: string, patch: SkillPatch): Effect.Effect<number, SkillNotFound | SkillInvalid | SkillStorageError>
  /** Replaces SKILL.md; a different `category` moves the skill. */
  replaceContent(
    botId: string,
    name: string,
    content: string,
    by: SkillAuthor,
    category?: string
  ): Effect.Effect<SkillDetail, SkillNotFound | SkillInvalid | SkillStorageError>
  writeFile(
    botId: string,
    name: string,
    path: string,
    content: string
  ): Effect.Effect<void, SkillNotFound | SkillInvalid | SkillStorageError>
  removeFile(botId: string, name: string, path: string): Effect.Effect<void, SkillNotFound | SkillInvalid | SkillStorageError>
  /** Moves the skill to `skills/.archive/`; nothing is deleted. */
  remove(botId: string, name: string): Effect.Effect<void, SkillNotFound | SkillStorageError>
  recordView(botId: string, name: string): Effect.Effect<void, SkillStorageError>
  /** Deletes all of a bot's skills when the bot itself is deleted, and refuses any later change to them. */
  removeBot(botId: string): Effect.Effect<void, SkillStorageError>
  /** Name, short description and category of every skill, for the system prompt. */
  index(botId: string): Effect.Effect<ReadonlyArray<SkillIndexEntry>, SkillStorageError>
  /** Identifies the current SKILL.md content; undefined when there's no such skill. */
  fingerprint(botId: string, name: string): Effect.Effect<string | undefined, SkillStorageError>
}>()("weaver/SkillStore") {
  static readonly layer = Layer.effect(
    SkillStore,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const events = yield* RunEvents

      const locks = new Map<string, Semaphore.Semaphore>()
      const removedBots = new Set<string>()
      const lockFor = (botId: string, key: string, permits = 1) => {
        const id = `${botId}\u0000${key}`
        let lock = locks.get(id)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(permits)
          locks.set(id, lock)
        }
        return lock
      }
      const botLock = (botId: string) => lockFor(botId, "bot", botPermits)
      /** Runs a change to a bot's skills unless the bot was deleted; `removeBot` waits for changes in flight. */
      const changing = <A, E>(botId: string, effect: Effect.Effect<A, E>) =>
        botLock(botId).withPermits(1)(Effect.suspend((): Effect.Effect<A, E | SkillStorageError> =>
          removedBots.has(botId)
            ? Effect.fail(new SkillStorageError({ message: "This bot was deleted, so its skills can't change." }))
            : effect
        ))
      const withSkillLock = <A, E>(botId: string, name: string, effect: Effect.Effect<A, E>) =>
        changing(botId, lockFor(botId, `skill:${name}`).withPermit(effect))

      const rootOf = (botId: string) => join(config.dataDir, "bots", botId, "skills")
      const changed = (botId: string) => events.publish({ type: "skills-changed", botId })

      const scan = (botId: string) =>
        io(async () => {
          const root = rootOf(botId)
          const found: Array<Located> = []
          for (const entry of await entriesOf(root)) {
            if (!entry.isDirectory() || !validName.test(entry.name)) continue
            const dir = join(root, entry.name)
            if (await isSkillDir(dir)) {
              found.push({ name: entry.name, category: "", dir })
              continue
            }
            for (const sub of await entriesOf(dir)) {
              if (!sub.isDirectory() || !validName.test(sub.name)) continue
              const skillDir = join(dir, sub.name)
              if (await isSkillDir(skillDir)) found.push({ name: sub.name, category: entry.name, dir: skillDir })
            }
          }
          return found.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
        })

      const locate = (botId: string, name: string) =>
        Effect.gen(function*() {
          if (validateName(name) !== undefined) return yield* notFound(name)
          const found = (yield* scan(botId)).find((skill) => skill.name === name)
          return found ?? (yield* notFound(name))
        })

      const usageLock = (botId: string) => lockFor(botId, usageFile)
      const readUsage = (botId: string) => io(async () => parseUsage(await readOrUndefined(join(rootOf(botId), usageFile))))
      const updateUsage = (botId: string, update: (usage: Usage, now: string) => void) =>
        usageLock(botId).withPermit(Effect.gen(function*() {
          const now = yield* nowIso
          const usage = yield* readUsage(botId)
          update(usage, now)
          yield* io(() => writeAtomic(join(rootOf(botId), usageFile), `${JSON.stringify(usage, null, 2)}\n`))
        }))
      const touch = (botId: string, name: string, by: SkillAuthor) =>
        updateUsage(botId, (usage, now) => {
          const record = usage[name]
          usage[name] = record === undefined
            ? { createdBy: by, useCount: 0, viewCount: 0, createdAt: now, updatedAt: now, lastUsedAt: null }
            : { ...record, updatedAt: now }
        })

      const summaryOf = (located: Located, content: string, usage: Usage) =>
        Effect.gen(function*() {
          const parsed = parseFrontmatter(content)
          const record = usage[located.name]
          const updatedAt = record?.updatedAt ?? (yield* io(async () => {
            const info = await statOrUndefined(join(located.dir, skillFile))
            return (info?.mtime ?? new Date(0)).toISOString()
          }))
          return new SkillSummary({
            name: located.name,
            description: typeof parsed === "string" ? "" : fieldText(parsed.fields.description),
            category: located.category,
            createdBy: record?.createdBy ?? "user",
            useCount: record?.useCount ?? 0,
            updatedAt,
            lastUsedAt: record?.lastUsedAt ?? null
          })
        })

      const readSkillMd = (located: Located) =>
        io(async () => (await readOrUndefined(join(located.dir, skillFile))) ?? "")

      const detailOf = (botId: string, located: Located) =>
        Effect.gen(function*() {
          const content = yield* readSkillMd(located)
          const summary = yield* summaryOf(located, content, yield* readUsage(botId))
          const files = yield* io(() => supportingFiles(located.dir))
          return new SkillDetail({ ...summary, content, files })
        })

      /** Resolves a supporting file inside a skill, refusing symlinks on the way. */
      const supportingPath = (located: Located, path: string) =>
        Effect.gen(function*() {
          const problem = validateFilePath(path)
          if (problem !== undefined) return yield* invalid(problem)
          const relative = path.split(/[/\\]/).join("/")
          const blocked = yield* io(() => blockedAt(located.dir, relative))
          if (blocked === "link") return yield* invalid(`"${path}" goes through a symbolic link, which skills can't use.`)
          if (blocked === "file") return yield* invalid(`"${path}" goes through a file as if it were a folder. Pick another path.`)
          return { relative, target: join(located.dir, relative) }
        })

      const missingFile = (located: Located, path: string) =>
        Effect.gen(function*() {
          const files = yield* io(() => supportingFiles(located.dir))
          const available = files.length > 0 ? ` Its files: ${files.join(", ")}.` : " It has no supporting files."
          return yield* invalid(`There's no file "${path}" in skill "${located.name}".${available}`)
        })

      const readExisting = (located: Located, path: string) =>
        Effect.gen(function*() {
          const { relative, target } = yield* supportingPath(located, path)
          const info = yield* io(() => statOrUndefined(target))
          if (info === undefined || !info.isFile()) return yield* missingFile(located, path)
          return { relative, target, content: yield* io(() => readFile(target, "utf8")) }
        })

      /** Copies a file of a skill the user wrote into `.archive/<name>-<stamp>/` before the bot changes it. */
      const backUpUserFile = (botId: string, located: Located, relative: string, content: string) =>
        Effect.gen(function*() {
          const usage = yield* readUsage(botId)
          if ((usage[located.name]?.createdBy ?? "user") !== "user") return
          const stamp = (yield* nowIso).replace(/[-:.]/g, "")
          yield* io(async () => {
            const target = join(await freeArchivePath(join(rootOf(botId), archiveDir), located.name, stamp), relative)
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, content, { encoding: "utf8", flag: "wx" })
          })
        })

      const list = Effect.fn("SkillStore.list")(function*(botId: string) {
        const usage = yield* readUsage(botId)
        return yield* Effect.forEach(yield* scan(botId), (located) =>
          Effect.flatMap(readSkillMd(located), (content) => summaryOf(located, content, usage)))
      })

      const get = Effect.fn("SkillStore.get")(function*(botId: string, name: string) {
        return yield* detailOf(botId, yield* locate(botId, name))
      })

      const readSkillFile = Effect.fn("SkillStore.readFile")(function*(botId: string, name: string, path: string) {
        const located = yield* locate(botId, name)
        if (path === skillFile) return yield* readSkillMd(located)
        return (yield* readExisting(located, path)).content
      })

      const create = Effect.fn("SkillStore.create")(function*(
        botId: string,
        input: { readonly name: string; readonly content: string; readonly category?: string | undefined },
        by: SkillAuthor
      ) {
        const name = input.name.trim()
        const category = input.category?.trim() ?? ""
        const problem = validateName(name) ?? validateCategory(category) ??
          validateSkillMd(name, input.content, by === "agent") ??
          (by === "agent" ? introducedThreat("", input.content) : undefined)
        if (problem !== undefined) return yield* invalid(problem)

        return yield* withSkillLock(botId, name, Effect.gen(function*() {
          const root = rootOf(botId)
          if ((yield* scan(botId)).some((skill) => skill.name === name)) {
            return yield* new SkillExists({
              skill: name,
              message: `A skill called "${name}" already exists. Use patch or edit to change it.`
            })
          }
          if (category.length > 0 && (yield* io(() => isSkillDir(join(root, category))))) {
            return yield* invalid(`"${category}" is a skill, not a category. Pick another category.`)
          }
          const dir = category.length > 0 ? join(root, category, name) : join(root, name)
          const blocked = yield* io(() => blockedAt(root, category.length > 0 ? `${category}/${name}` : name))
          if (blocked === "link") {
            return yield* invalid(`"${category || name}" is a symbolic link in your skills folder. Pick another name.`)
          }
          if (blocked === "file") return yield* invalid(`"${category}" is a file in your skills folder. Pick another category.`)
          const existing = yield* io(async () => {
            const info = await statOrUndefined(dir)
            if (info === undefined) return "free"
            return info.isDirectory() && (await entriesOf(dir)).length === 0 ? "free" : "taken"
          })
          if (existing === "taken") return yield* invalid(`"${name}" is already used by a folder in your skills. Pick another name.`)
          yield* io(() => writeAtomic(join(dir, skillFile), input.content))
          yield* updateUsage(botId, (usage, now) => {
            usage[name] = { createdBy: by, useCount: 0, viewCount: 0, createdAt: now, updatedAt: now, lastUsedAt: null }
          })
          yield* changed(botId)
          return yield* detailOf(botId, { name, category, dir })
        }))
      })

      const patch = Effect.fn("SkillStore.patch")(function*(botId: string, name: string, input: SkillPatch) {
        if (input.old_string.length === 0) return yield* invalid("old_string is required; give the exact text to replace.")
        return yield* withSkillLock(botId, name, Effect.gen(function*() {
          const located = yield* locate(botId, name)
          const filePath = input.file_path === undefined || input.file_path === skillFile ? undefined : input.file_path
          const { content, relative, target } = filePath === undefined
            ? { content: yield* readSkillMd(located), relative: skillFile, target: join(located.dir, skillFile) }
            : yield* readExisting(located, filePath)
          const label = filePath ?? skillFile

          const count = countOf(content, input.old_string)
          if (count === 0) return yield* invalid(`old_string wasn't found in ${label}. Load it with skill_view and copy the text exactly.`)
          if (count > 1 && input.replace_all !== true) {
            return yield* invalid(`old_string appears ${count} times in ${label}; include more surrounding text, or set replace_all.`)
          }
          const updated = input.replace_all === true
            ? content.split(input.old_string).join(input.new_string)
            : content.replace(input.old_string, () => input.new_string)

          const problem = filePath === undefined
            ? validateSkillMd(name, updated, false)
            : Buffer.byteLength(updated, "utf8") > maxFileBytes
            ? `${label} would be larger than 1 MiB.`
            : undefined
          if (problem !== undefined) return yield* invalid(filePath === undefined ? `This patch would break SKILL.md: ${problem}` : problem)
          const threat = introducedThreat(content, updated)
          if (threat !== undefined) return yield* invalid(threat)

          if (updated !== content) yield* backUpUserFile(botId, located, relative, content)
          yield* io(() => writeAtomic(target, updated))
          yield* touch(botId, name, "agent")
          yield* changed(botId)
          return input.replace_all === true ? count : 1
        }))
      })

      const replaceContent = Effect.fn("SkillStore.replaceContent")(function*(
        botId: string,
        name: string,
        content: string,
        by: SkillAuthor,
        category?: string
      ) {
        const newCategory = category?.trim()
        const problem = validateSkillMd(name, content, false) ??
          (newCategory === undefined ? undefined : validateCategory(newCategory))
        if (problem !== undefined) return yield* invalid(problem)
        return yield* withSkillLock(botId, name, Effect.gen(function*() {
          let located = yield* locate(botId, name)
          if (by === "agent") {
            const before = yield* readSkillMd(located)
            const threat = introducedThreat(before, content)
            if (threat !== undefined) return yield* invalid(threat)
            if (before !== content) yield* backUpUserFile(botId, located, skillFile, before)
          }
          if (newCategory !== undefined && newCategory !== located.category) {
            const root = rootOf(botId)
            if (newCategory.length > 0 && (yield* io(() => isSkillDir(join(root, newCategory))))) {
              return yield* invalid(`"${newCategory}" is a skill, not a category. Pick another category.`)
            }
            const dir = newCategory.length > 0 ? join(root, newCategory, name) : join(root, name)
            const taken = yield* io(async () =>
              (await statOrUndefined(dir)) !== undefined ||
              (await blockedAt(root, newCategory.length > 0 ? `${newCategory}/${name}` : name)) !== undefined
            )
            if (taken) {
              return yield* invalid(`"${name}" is already used by a folder in category "${newCategory}".`)
            }
            const from = located.dir
            yield* io(async () => {
              await mkdir(dirname(dir), { recursive: true })
              await rename(from, dir)
              if (located.category.length > 0) await removeIfEmpty(dirname(from))
            })
            located = { name, category: newCategory, dir }
          }
          yield* io(() => writeAtomic(join(located.dir, skillFile), content))
          yield* touch(botId, name, by)
          yield* changed(botId)
          return yield* detailOf(botId, located)
        }))
      })

      const writeSkillFile = Effect.fn("SkillStore.writeFile")(function*(
        botId: string,
        name: string,
        path: string,
        content: string
      ) {
        if (path === skillFile) return yield* invalid("Use edit or patch to change SKILL.md.")
        const bytes = Buffer.byteLength(content, "utf8")
        if (bytes > maxFileBytes) {
          return yield* invalid(`The file is ${bytes.toLocaleString("en-US")} bytes (limit 1 MiB). Split it into smaller files.`)
        }
        yield* withSkillLock(botId, name, Effect.gen(function*() {
          const located = yield* locate(botId, name)
          const { relative, target } = yield* supportingPath(located, path)
          const info = yield* io(() => statOrUndefined(target))
          if (info !== undefined && !info.isFile()) return yield* invalid(`"${path}" is a folder.`)
          const before = info === undefined ? "" : yield* io(() => readFile(target, "utf8"))
          const threat = introducedThreat(before, content)
          if (threat !== undefined) return yield* invalid(threat)
          if (info !== undefined && before !== content) yield* backUpUserFile(botId, located, relative, before)
          yield* io(() => writeAtomic(target, content))
          yield* touch(botId, name, "agent")
          yield* changed(botId)
        }))
      })

      const removeSkillFile = Effect.fn("SkillStore.removeFile")(function*(botId: string, name: string, path: string) {
        if (path === skillFile) return yield* invalid("SKILL.md can't be removed; delete the skill instead.")
        yield* withSkillLock(botId, name, Effect.gen(function*() {
          const located = yield* locate(botId, name)
          const { target } = yield* readExisting(located, path)
          yield* io(async () => {
            await rm(target)
            for (let dir = dirname(target); dir !== located.dir; dir = dirname(dir)) await removeIfEmpty(dir)
          })
          yield* touch(botId, name, "agent")
          yield* changed(botId)
        }))
      })

      const remove = Effect.fn("SkillStore.remove")(function*(botId: string, name: string) {
        yield* withSkillLock(botId, name, Effect.gen(function*() {
          const located = yield* locate(botId, name)
          const stamp = (yield* nowIso).replace(/[-:.]/g, "")
          yield* io(async () => {
            await rename(located.dir, await freeArchivePath(join(rootOf(botId), archiveDir), located.name, stamp))
            if (located.category.length > 0) await removeIfEmpty(dirname(located.dir))
          })
          yield* updateUsage(botId, (usage) => {
            delete usage[name]
          })
          yield* changed(botId)
        }))
      })

      const findSkill = (botId: string, name: string) =>
        locate(botId, name).pipe(Effect.catchTag("SkillNotFound", () => Effect.succeed(undefined)))

      const recordView = Effect.fn("SkillStore.recordView")(function*(botId: string, name: string) {
        if ((yield* findSkill(botId, name)) === undefined) return
        yield* changing(
          botId,
          updateUsage(botId, (usage, now) => {
            const record = usage[name] ??
              { createdBy: "user" as const, useCount: 0, viewCount: 0, createdAt: now, updatedAt: now, lastUsedAt: null }
            usage[name] = { ...record, useCount: record.useCount + 1, viewCount: record.viewCount + 1, lastUsedAt: now }
          })
        )
        yield* changed(botId)
      })

      const removeBot = Effect.fn("SkillStore.removeBot")(function*(botId: string) {
        if (botId.length === 0 || botId.includes("/") || botId.includes("\\") || botId.startsWith(".")) return
        yield* botLock(botId).withPermits(botPermits)(Effect.suspend(() => {
          removedBots.add(botId)
          return io(() => rm(rootOf(botId), { recursive: true, force: true }))
        }))
        for (const key of locks.keys()) if (key.startsWith(`${botId}\u0000`)) locks.delete(key)
        yield* changed(botId)
      })

      const fingerprint = Effect.fn("SkillStore.fingerprint")(function*(botId: string, name: string) {
        const located = yield* findSkill(botId, name)
        if (located === undefined) return undefined
        return Bun.hash(yield* readSkillMd(located)).toString(36)
      })

      const index = Effect.fn("SkillStore.index")(function*(botId: string) {
        const all = yield* list(botId)
        return all.map((skill) => ({
          name: skill.name,
          description: truncateDescription(skill.description),
          category: skill.category
        }))
      })

      return SkillStore.of({
        list,
        get,
        readFile: readSkillFile,
        create,
        patch,
        replaceContent,
        writeFile: writeSkillFile,
        removeFile: removeSkillFile,
        remove,
        recordView,
        removeBot,
        index,
        fingerprint
      })
    })
  )
}
