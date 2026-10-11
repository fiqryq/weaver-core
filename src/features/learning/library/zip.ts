import { inflateRawSync } from "node:zlib"

export interface ZipLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

const endSignature = 0x06054b50
const centralSignature = 0x02014b50
const localSignature = 0x04034b50

export const isZip = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)

/** Entries a zip from macOS or a repository carries that aren't part of a skill; `..` isn't junk but refused later. */
export const isJunkPath = (path: string): boolean =>
  path.split("/").some((segment) => (segment.startsWith(".") && segment !== "..") || segment === "__MACOSX")

/**
 * The files in a zip, or why it can't be read. Only stored and deflated entries are supported; symbolic
 * links, encryption and ZIP64 are refused, and sizes are held to `limits` while inflating, so a small
 * zip can't expand into a huge one.
 */
export const readZip = (data: Uint8Array, limits: ZipLimits): Array<{ path: string; bytes: Uint8Array }> | string => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let end = -1
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 22 - 0xffff); offset--) {
    if (view.getUint32(offset, true) === endSignature) {
      end = offset
      break
    }
  }
  if (end === -1) return "The zip file is damaged or isn't a zip."
  const count = view.getUint16(end + 10, true)
  const centralOffset = view.getUint32(end + 16, true)
  if (count === 0xffff || centralOffset === 0xffffffff) return "ZIP64 archives aren't supported; zip the skill folder again."

  const decoder = new TextDecoder()
  const files: Array<{ path: string; bytes: Uint8Array }> = []
  let total = 0
  let offset = centralOffset
  for (let index = 0; index < count; index++) {
    if (offset + 46 > data.length || view.getUint32(offset, true) !== centralSignature) return "The zip file is damaged."
    const madeBy = view.getUint8(offset + 5)
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const mode = view.getUint32(offset + 38, true) >>> 16
    const localOffset = view.getUint32(offset + 42, true)
    const path = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/g, "/")
    offset += 46 + nameLength + extraLength + commentLength

    if (path.endsWith("/") || isJunkPath(path)) continue
    if (madeBy === 3 && (mode & 0o170000) === 0o120000) return `"${path}" is a symbolic link, which skills can't contain.`
    if ((flags & 1) !== 0) return "Encrypted zip files aren't supported."
    if (files.length >= limits.maxFiles) return `The zip has more than ${limits.maxFiles} files.`
    if (size > limits.maxFileBytes) return `"${path}" is larger than 1 MiB.`
    total += size
    if (total > limits.maxTotalBytes) return "The skill would be larger than 10 MiB."

    if (localOffset + 30 > data.length || view.getUint32(localOffset, true) !== localSignature) return "The zip file is damaged."
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    const compressed = data.subarray(start, start + compressedSize)
    if (compressed.length !== compressedSize) return "The zip file is damaged."
    let bytes: Uint8Array
    if (method === 0) {
      bytes = compressed
    } else if (method === 8) {
      try {
        bytes = inflateRawSync(compressed, { maxOutputLength: limits.maxFileBytes })
      } catch {
        return `"${path}" couldn't be unpacked, or is larger than 1 MiB.`
      }
    } else {
      return `"${path}" uses a compression method that isn't supported (${method}); zip it again with standard compression.`
    }
    if (bytes.length !== size) return "The zip file is damaged."
    files.push({ path, bytes })
  }
  return files
}
