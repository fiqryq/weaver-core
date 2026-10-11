import { Effect } from "effect"
import type { Dirent } from "node:fs"
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { SkillStorageError } from "./errors.ts"
import { validName } from "./frontmatter.ts"

export const maxFileBytes = 1_048_576
/** Each folder or file name in a supporting file's path; well under the 255-byte file name limit, with room for temp names. */
export const maxPathSegmentBytes = 100
export const maxFilePathBytes = 400
export const supportDirs: ReadonlyArray<string> = ["references", "templates", "scripts", "assets"]

export const skillFile = "SKILL.md"
export const archiveDir = ".archive"

/**
 * A path relative to the skill, under one of the supporting-file folders; `anywhere` (library skills)
 * also allows files at the top or in other folders.
 */
export const validateFilePath = (path: string, anywhere = false): string | undefined => {
  if (path.length === 0) return "file_path is required."
  if (Buffer.byteLength(path, "utf8") > maxFilePathBytes) return `file_path is longer than ${maxFilePathBytes} bytes.`
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    return `file_path must be relative to the skill, e.g. "references/api.md", not absolute.`
  }
  const segments = path.split(/[/\\]/)
  if (segments.includes("..")) return "file_path can't contain \"..\"."
  if (segments.some((segment) => segment === "" || segment === "." || segment.includes("\u0000"))) {
    return `"${path}" isn't a valid file path.`
  }
  if (segments.some((segment) => Buffer.byteLength(segment, "utf8") > maxPathSegmentBytes)) {
    return `Each folder and file name in file_path must be at most ${maxPathSegmentBytes} bytes.`
  }
  if (anywhere) {
    return segments.some((segment) => segment.startsWith("."))
      ? `"${path}" is hidden; file and folder names can't start with ".".`
      : undefined
  }
  if (!supportDirs.includes(segments[0]!)) {
    return `Supporting files must be under one of ${supportDirs.map((dir) => `${dir}/`).join(", ")}. Got "${path}".`
  }
  if (segments.length < 2) return `Give a file, not a folder, e.g. "${segments[0]}/notes.md".`
  return undefined
}

const isMissing = (cause: unknown): boolean => {
  const code = (cause as { code?: string }).code
  return code === "ENOENT" || code === "ENOTDIR"
}

export const statOrUndefined = async (path: string) => {
  try {
    return await lstat(path)
  } catch (cause) {
    if (isMissing(cause)) return undefined
    throw cause
  }
}

export const readOrUndefined = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8")
  } catch (cause) {
    if (isMissing(cause)) return undefined
    throw cause
  }
}

export const entriesOf = async (path: string): Promise<ReadonlyArray<Dirent>> => {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (cause) {
    if (isMissing(cause)) return []
    throw cause
  }
}

export const isSkillDir = async (dir: string): Promise<boolean> =>
  (await statOrUndefined(join(dir, skillFile)))?.isFile() === true

/** Writes through a temporary file and a rename, so a crash never leaves half a file. */
export const writeAtomic = async (path: string, content: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`)
  try {
    await writeFile(temp, content, typeof content === "string" ? { encoding: "utf8", flag: "wx" } : { flag: "wx" })
    await rename(temp, path)
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw cause
  }
}

/**
 * What's in the way between `base` and `base/relativePath`: a symlink (skills never need them, so any
 * link is refused) or a file where a folder should be.
 */
export const blockedAt = async (base: string, relativePath: string): Promise<"link" | "file" | undefined> => {
  const segments = relativePath.split(/[/\\]/)
  let current = base
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const info = await statOrUndefined(current)
    if (info === undefined) return undefined
    if (info.isSymbolicLink()) return "link"
    if (index < segments.length - 1 && !info.isDirectory()) return "file"
  }
  return undefined
}

/** A free `.archive/<name>-<stamp>[-n]` folder path. */
export const freeArchivePath = async (archive: string, name: string, stamp: string): Promise<string> => {
  await mkdir(archive, { recursive: true })
  let target = join(archive, `${name}-${stamp}`)
  for (let n = 2; (await statOrUndefined(target)) !== undefined; n++) target = join(archive, `${name}-${stamp}-${n}`)
  return target
}

const storageError = (cause: unknown) =>
  new SkillStorageError({
    message: `The skills folder couldn't be read or changed: ${cause instanceof Error ? cause.message : String(cause)}`
  })

export const io = <A>(run: () => Promise<A>): Effect.Effect<A, SkillStorageError> =>
  Effect.tryPromise({ try: run, catch: storageError })

/** Supporting files under the supporting-file folders, or with `anywhere` every file but SKILL.md; hidden ones are skipped. */
export const supportingFiles = async (dir: string, anywhere = false): Promise<Array<string>> => {
  const files: Array<string> = []
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await entriesOf(join(dir, relative))) {
      if (entry.name.startsWith(".")) continue
      const path = relative.length > 0 ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && path !== skillFile) files.push(path)
    }
  }
  if (anywhere) await walk("")
  else for (const sub of supportDirs) if ((await statOrUndefined(join(dir, sub)))?.isDirectory()) await walk(sub)
  return files.sort((a, b) => a.localeCompare(b))
}

export interface LocatedSkill {
  readonly name: string
  /** Empty when the skill isn't in a category. */
  readonly category: string
  readonly dir: string
}

/** Every `[category/]<name>/SKILL.md` under `root`. */
export const scanSkills = async (root: string): Promise<Array<LocatedSkill>> => {
  const found: Array<LocatedSkill> = []
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
}

/** Copies a skill folder without following symlinks; links and anything but files and folders are left out. */
export const copySkillDir = async (from: string, to: string): Promise<void> => {
  await mkdir(to, { recursive: true })
  for (const entry of await entriesOf(from)) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copySkillDir(source, target)
    else if (entry.isFile()) await writeFile(target, await readFile(source), { flag: "wx" })
  }
}

export const removeIfEmpty = async (dir: string): Promise<void> => {
  try {
    await rmdir(dir)
  } catch {
    // Not empty, or already gone.
  }
}
