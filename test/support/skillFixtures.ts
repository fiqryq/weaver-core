import { deflateRawSync } from "node:zlib"

export interface ZipEntry {
  readonly path: string
  readonly content: string | Uint8Array
  /** Unix mode stored in the entry, e.g. 0o120777 for a symlink. */
  readonly mode?: number
  readonly stored?: boolean
  /** The uncompressed size the zip claims, when it should lie. */
  readonly declaredSize?: number
}

const bytesOf = (content: string | Uint8Array) => (typeof content === "string" ? new TextEncoder().encode(content) : content)

/** A zip file with the given entries, deflated unless `stored`. */
export const makeZip = (entries: ReadonlyArray<ZipEntry>): Uint8Array => {
  const locals: Array<Uint8Array> = []
  const centrals: Array<Uint8Array> = []
  let offset = 0
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path)
    const raw = bytesOf(entry.content)
    const data = entry.stored === true ? raw : new Uint8Array(deflateRawSync(raw))
    const crc = Bun.hash.crc32(raw)
    const local = new Uint8Array(30 + name.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, entry.stored === true ? 0 : 8, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, entry.declaredSize ?? raw.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(data, 30 + name.length)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, (3 << 8) | 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, entry.stored === true ? 0 : 8, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, entry.declaredSize ?? raw.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(38, ((entry.mode ?? 0o100644) << 16) >>> 0, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const all = [...locals, ...centrals, end]
  const zip = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of all) {
    zip.set(part, at)
    at += part.length
  }
  return zip
}

export interface FakeRepoFile {
  readonly content: string | Uint8Array
  readonly symlink?: boolean
}

/**
 * A fake of GitHub (the git trees API and raw.githubusercontent.com) plus any other https URLs, for
 * `SkillHttp`. Repos are `owner/repo` → ref → path → file. Every request URL is recorded.
 */
export const fakeHttp = (options: {
  readonly repos?: Record<string, Record<string, Record<string, string | FakeRepoFile>>>
  readonly urls?: Record<string, () => Response>
  readonly rateLimited?: () => boolean
}) => {
  const requests: Array<{ url: string; authorization: string | null }> = []
  const fileOf = (value: string | FakeRepoFile): FakeRepoFile => (typeof value === "string" ? { content: value } : value)
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    requests.push({ url, authorization: new Headers(init.headers).get("authorization") })
    const parsed = new URL(url)
    if (parsed.hostname === "api.github.com") {
      if (options.rateLimited?.() === true) {
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
      }
      const match = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/.exec(parsed.pathname)
      if (match === null) return new Response("{}", { status: 404 })
      const treeish = decodeURIComponent(match[3]!)
      const [ref, path = ""] = treeish.includes(":") ? treeish.split(/:(.*)/s) as [string, string] : [treeish, ""]
      const files = options.repos?.[`${match[1]}/${match[2]}`]?.[ref]
      if (files === undefined) return new Response("{}", { status: 404 })
      const prefix = path.length > 0 ? `${path}/` : ""
      const inside = Object.entries(files).filter(([file]) => file.startsWith(prefix))
      if (inside.length === 0) return new Response("{}", { status: 404 })
      const tree = new Map<string, unknown>()
      for (const [file, value] of inside) {
        const relative = file.slice(prefix.length)
        const parts = relative.split("/")
        for (let index = 1; index < parts.length; index++) {
          const dir = parts.slice(0, index).join("/")
          tree.set(dir, { path: dir, mode: "040000", type: "tree" })
        }
        const { content, symlink } = fileOf(value)
        tree.set(relative, {
          path: relative,
          mode: symlink === true ? "120000" : "100644",
          type: "blob",
          size: bytesOf(content).length
        })
      }
      return Response.json({ sha: "x", tree: [...tree.values()], truncated: false })
    }
    if (parsed.hostname === "raw.githubusercontent.com") {
      const [owner, repo, ...rest] = parsed.pathname.slice(1).split("/").map(decodeURIComponent)
      const refs = options.repos?.[`${owner}/${repo}`] ?? {}
      for (const [ref, files] of Object.entries(refs)) {
        const refParts = ref.split("/")
        if (rest.slice(0, refParts.length).join("/") !== ref) continue
        const file = files[rest.slice(refParts.length).join("/")]
        if (file !== undefined) return new Response(bytesOf(fileOf(file).content))
      }
      return new Response("404: Not Found", { status: 404 })
    }
    const handler = options.urls?.[url]
    return handler === undefined ? new Response("not found", { status: 404 }) : handler()
  }
  return { fetch, requests }
}

/** Resolves every host to a public address, so the private-address check passes without DNS. */
export const publicLookup = async () => ["93.184.216.34"]
