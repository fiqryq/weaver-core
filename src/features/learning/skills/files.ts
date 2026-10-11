import { Effect } from "effect"
import type { Dirent } from "node:fs"
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { SkillStorageError } from "./errors.ts"

export const maxFileBytes = 1_048_576
/** Each folder or file name in a supporting file's path; well under the 255-byte file name limit, with room for temp names. */
export const maxPathSegmentBytes = 100
export const maxFilePathBytes = 400
export const supportDirs: ReadonlyArray<string> = ["references", "templates", "scripts", "assets"]

export const skillFile = "SKILL.md"
export const archiveDir = ".archive"

/** A path relative to the skill, under one of the supporting-file folders. */
export const validateFilePath = (path: string): string | undefined => {
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
export const writeAtomic = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`)
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" })
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

export const supportingFiles = async (dir: string): Promise<Array<string>> => {
  const files: Array<string> = []
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await entriesOf(join(dir, relative))) {
      if (entry.name.startsWith(".")) continue
      const path = `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  for (const sub of supportDirs) if ((await statOrUndefined(join(dir, sub)))?.isDirectory()) await walk(sub)
  return files.sort((a, b) => a.localeCompare(b))
}

export const removeIfEmpty = async (dir: string): Promise<void> => {
  try {
    await rmdir(dir)
  } catch {
    // Not empty, or already gone.
  }
}
