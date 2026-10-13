import { Effect, Schema } from "effect"
import { chmod, chown, lstat, mkdir, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"

export const readLimit = 12_000
/** The most of a file that's read, and the largest file that can be written or edited. */
export const maxFileBytes = 1024 * 1024
const listLimit = 500
/** How much of a file is checked for NUL bytes to tell it's binary. */
const binarySniffBytes = 8 * 1024

export const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : bytes >= 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${bytes} bytes`

const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, binarySniffBytes).includes(0)

/** 
 * Reads at most `limit` bytes from the start of a regular file, with the file's full size.
 * Opens with O_NOFOLLOW and verifies the realpath to prevent symlink TOCTOU attacks.
 */
const readStart = async (target: string, limit: number, workspace: string): Promise<{ bytes: Uint8Array; size: number }> => {
  // Open with O_NOFOLLOW to fail if target is a symlink at the final component
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    // Now verify the resolved path is still inside the workspace
    const resolved = await realpath(target)
    if (!isInside(workspace, resolved)) {
      throw new Error("path resolves outside workspace")
    }
    
    const info = await handle.stat()
    if (info.isDirectory()) throw Object.assign(new Error("is a directory"), { code: "EISDIR" })
    if (!info.isFile()) throw new Error("not a regular file")
    
    const buffer = new Uint8Array(Math.min(info.size, limit))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return { bytes: buffer.subarray(0, bytesRead), size: info.size }
  } finally {
    await handle.close()
  }
}

const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const isMissing = (cause: unknown): boolean => {
  const code = (cause as { code?: string }).code
  return code === "ENOENT" || code === "ENOTDIR"
}

/**
 * Walks `target` from `root` one component at a time and checks every symlink on the way, so
 * neither a link to a folder nor a broken link (which a write would create) can lead outside.
 */
const checkLinks = async (root: string, target: string): Promise<"inside" | "outside" | "broken"> => {
  let current = root
  for (const segment of relative(root, target).split(sep).filter((part) => part.length > 0)) {
    current = join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch (cause) {
      if (isMissing(cause)) return "inside"
      throw cause
    }
    if (!info.isSymbolicLink()) continue
    let linked: string
    try {
      linked = await realpath(current)
    } catch (cause) {
      if (isMissing(cause)) return "broken"
      throw cause
    }
    if (!isInside(root, linked)) return "outside"
  }
  return "inside"
}

/**
 * Resolves a path the model gave against the bot's workspace and refuses anything outside it,
 * including through symlinks.
 */
export const resolveInWorkspace = (workspace: string, path: string): Effect.Effect<string, ToolFailure> =>
  Effect.tryPromise({
    try: async () => {
      const root = await realpath(workspace)
      const target = resolve(root, path.trim() || ".")
      if (!isInside(root, target)) return { target, check: "outside" as const }
      return { target, check: await checkLinks(root, target) }
    },
    catch: (cause) => new ToolFailure({ message: `Couldn't resolve ${path}: ${String(cause)}` })
  }).pipe(
    Effect.flatMap(({ check, target }) =>
      check === "inside"
        ? Effect.succeed(target)
        : Effect.fail(
          new ToolFailure({
            message: check === "broken"
              ? `${path} goes through a link to something that doesn't exist. Use paths inside ${workspace}.`
              : `${path} is outside your workspace. Use paths inside ${workspace}.`
          })
        )
    )
  )

const fsFailure = (path: string) => (cause: unknown) => {
  const code = (cause as { code?: string }).code
  const message = code === "ENOENT"
    ? `${path} doesn't exist.`
    : code === "EISDIR"
    ? `${path} is a directory.`
    : code === "ENOTDIR"
    ? `${path} is not a directory.`
    : `${path}: ${cause instanceof Error ? cause.message : String(cause)}`
  return new ToolFailure({ message })
}

const ReadParams = Schema.Struct({
  path: Schema.String.annotate({ description: "File path, relative to your workspace." }),
  offset: Schema.optional(Schema.Int).annotate({ description: "First line to read (1-based)." }),
  limit: Schema.optional(Schema.Int).annotate({ description: "Number of lines to read." })
})

const ListParams = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({ description: "Directory, relative to your workspace. Defaults to the workspace." })
})

const WriteParams = Schema.Struct({
  path: Schema.String.annotate({ description: "File path, relative to your workspace. Parent folders are created." }),
  content: Schema.String.annotate({ description: "The full new content of the file." })
})

const EditParams = Schema.Struct({
  path: Schema.String.annotate({ description: "File path, relative to your workspace." }),
  old_text: Schema.String.annotate({ description: "Exact text to replace. It must appear exactly once in the file." }),
  new_text: Schema.String.annotate({ description: "The replacement text." })
})

const pathTitle = (verb: string, params: unknown): string => {
  const path = typeof (params as { path?: unknown })?.path === "string" ? (params as { path: string }).path : ""
  return path ? `${verb} ${shorten(path, 60)}` : verb
}

export const fileTools = (options: {
  readonly workspace: string
  readonly writesNeedApproval: boolean
  readonly allowWrites: boolean
}): ReadonlyArray<AgentTool> => {
  const { workspace } = options

  const readTool: AgentTool = {
    name: "read_file",
    description:
      `Read a text file in your workspace (${workspace}). Long files are cut to about ${readLimit} characters; use offset and limit to page through them. ` +
      `Only the first ${formatBytes(maxFileBytes)} of a file can be read.`,
    parameters: jsonSchemaOf(ReadParams),
    needsApproval: false,
    activity: "Reading a file",
    title: (params) => pathTitle("Read", params),
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(ReadParams, raw)
        const target = yield* resolveInWorkspace(workspace, params.path)
        const file = yield* Effect.tryPromise({ try: () => readStart(target, maxFileBytes, workspace), catch: fsFailure(params.path) })
        if (isBinary(file.bytes)) return `${params.path} is a binary file (${formatBytes(file.size)}); read_file only shows text.`
        const truncated = file.size > file.bytes.length
        const content = new TextDecoder().decode(file.bytes, { stream: truncated })
        const note = truncated
          ? `\n… (only the first ${formatBytes(maxFileBytes)} of this ${formatBytes(file.size)} file can be read)`
          : ""
        let lines = content.split("\n")
        const start = Math.max((params.offset ?? 1) - 1, 0)
        if (params.offset !== undefined || params.limit !== undefined) {
          lines = lines.slice(start, params.limit !== undefined ? start + Math.max(params.limit, 0) : undefined)
        }
        const text = lines.join("\n")
        if (text.length <= readLimit) return `${text.length > 0 ? text : truncated ? "(nothing at this offset)" : "(empty file)"}${note}`
        const total = `${truncated ? "more than " : ""}${content.split("\n").length} lines in total`
        return `${text.slice(0, readLimit)}\n… (cut; ${total}, use offset and limit to read more)${note}`
      })
  }

  const listTool: AgentTool = {
    name: "list_files",
    description: `List a directory in your workspace (${workspace}). Folders end with "/".`,
    parameters: jsonSchemaOf(ListParams),
    needsApproval: false,
    activity: "Looking at files",
    title: (params) => pathTitle("Listed", { path: (params as { path?: string })?.path ?? "." }),
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(ListParams, raw)
        const path = params.path ?? "."
        const target = yield* resolveInWorkspace(workspace, path)
        const entries = yield* Effect.tryPromise({
          try: () => readdir(target, { withFileTypes: true }),
          catch: fsFailure(path)
        })
        const names = entries
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort((a, b) => a.localeCompare(b))
        if (names.length === 0) return "(empty directory)"
        const shown = names.slice(0, listLimit).join("\n")
        return names.length > listLimit ? `${shown}\n… and ${names.length - listLimit} more` : shown
      })
  }

  const writeTool: AgentTool = {
    name: "write_file",
    description: `Create or overwrite a text file in your workspace (${workspace}), up to ${formatBytes(maxFileBytes)}.`,
    parameters: jsonSchemaOf(WriteParams),
    needsApproval: options.writesNeedApproval,
    activity: "Writing a file",
    title: (params) => pathTitle("Wrote", params),
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(WriteParams, raw)
        const size = Buffer.byteLength(params.content, "utf8")
        if (size > maxFileBytes) {
          return yield* new ToolFailure({
            message: `content is ${formatBytes(size)}; write_file takes at most ${formatBytes(maxFileBytes)}. Split it into smaller files.`
          })
        }
        const target = yield* resolveInWorkspace(workspace, params.path)
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, params.content, "utf8")
          },
          catch: fsFailure(params.path)
        })
        return `Wrote ${params.content.length} characters to ${params.path.trim()}.`
      })
  }

  const editTool: AgentTool = {
    name: "edit_file",
    description: `Replace one exact piece of text in a file in your workspace (${workspace}). Read the file first so old_text matches exactly.`,
    parameters: jsonSchemaOf(EditParams),
    needsApproval: options.writesNeedApproval,
    activity: "Editing a file",
    title: (params) => pathTitle("Edited", params),
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(EditParams, raw)
        const target = yield* resolveInWorkspace(workspace, params.path)
        const file = yield* Effect.tryPromise({ try: () => readStart(target, maxFileBytes + 1, workspace), catch: fsFailure(params.path) })
        if (file.size > maxFileBytes) {
          return yield* new ToolFailure({
            message: `${params.path} is ${formatBytes(file.size)}; edit_file only edits files up to ${formatBytes(maxFileBytes)}.`
          })
        }
        if (isBinary(file.bytes)) return yield* new ToolFailure({ message: `${params.path} is a binary file; edit_file only edits text.` })
        const content = new TextDecoder().decode(file.bytes)
        const first = content.indexOf(params.old_text)
        if (params.old_text.length === 0 || first === -1) {
          return yield* new ToolFailure({ message: `old_text wasn't found in ${params.path}.` })
        }
        if (content.indexOf(params.old_text, first + 1) !== -1) {
          return yield* new ToolFailure({
            message: `old_text appears more than once in ${params.path}; include more surrounding text.`
          })
        }
        const updated = content.slice(0, first) + params.new_text + content.slice(first + params.old_text.length)
        const size = Buffer.byteLength(updated, "utf8")
        if (size > maxFileBytes) {
          return yield* new ToolFailure({
            message: `The edit would make ${params.path} ${formatBytes(size)}; files can be at most ${formatBytes(maxFileBytes)}.`
          })
        }
        yield* Effect.tryPromise({ try: () => writeFile(target, updated, "utf8"), catch: fsFailure(params.path) })
        return `Edited ${params.path}.`
      })
  }

  return options.allowWrites ? [readTool, listTool, writeTool, editTool] : [readTool, listTool]
}

/** Looks up a group's ID in /etc/group; a number is taken as the ID itself. */
export const groupId = async (group: string, groupFile = "/etc/group"): Promise<number | undefined> => {
  if (/^\d+$/.test(group)) return Number(group)
  const lines = await readFile(groupFile, "utf8").catch(() => "")
  for (const line of lines.split("\n")) {
    const [name, , gid] = line.split(":")
    if (name === group && gid !== undefined && /^\d+$/.test(gid)) return Number(gid)
  }
  return undefined
}

/**
 * Lets the bot user reach its workspace and nothing else of the bot's: the folders above it can be
 * passed through but not listed, the workspace belongs to the shared group (setgid, so new files do
 * too), and the skills folder stays the server's alone.
 */
const shareWorkspace = async (dataDir: string, botId: string, workspace: string, group: string) => {
  const gid = await groupId(group)
  if (gid === undefined) throw new Error(`there's no group called ${group}`)
  await chmod(join(dataDir, "bots"), 0o711)
  await chmod(join(dataDir, "bots", botId), 0o711)
  const info = await stat(workspace)
  // A workspace handed to the bot's own user is weaver-bot-user's to manage (only its owner may chmod it).
  const ours = info.uid === process.getuid?.()
  if (ours && (info.gid !== gid || (info.mode & 0o7777) !== 0o2770)) {
    await chown(workspace, info.uid, gid)
    await chmod(workspace, 0o2770)
  }
  await chmod(join(dataDir, "bots", botId, "skills"), 0o700).catch((cause) => {
    if (!isMissing(cause)) throw cause
  })
}

/**
 * Creates (if needed) and returns a bot's workspace directory. With `shareWith`, also sets it up for
 * commands that run as a separate bot user in that group.
 */
export const ensureWorkspace = (
  dataDir: string,
  botId: string,
  shareWith?: { readonly group: string }
): Effect.Effect<string> =>
  Effect.gen(function*() {
    const path = join(dataDir, "bots", botId, "workspace")
    yield* Effect.promise(() => mkdir(path, { recursive: true }))
    if (shareWith !== undefined) {
      yield* Effect.tryPromise(() => shareWorkspace(dataDir, botId, path, shareWith.group)).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Couldn't share ${path} with group ${shareWith.group}, so the bot's commands may not be able to use it`,
            error.cause
          )
        )
      )
    }
    return path
  })
