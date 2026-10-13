import { Context, Duration, Effect, Layer, Redacted, Semaphore } from "effect"
import { AppConfig } from "../../../config/Config.ts"
import { type Lookup, publicUrl } from "../../../tools/builtin/UrlGuard.ts"
import { invalid, type SkillInvalid } from "../skills/errors.ts"
import { skillFile } from "../skills/files.ts"
import { fieldText, parseFrontmatter, validateName } from "../skills/frontmatter.ts"
import { limits, maxSkillBytes, maxSkillFiles } from "./bundle.ts"
import type { InstallOptions, LibraryStore } from "./LibraryStore.ts"
import { Catalog, type CatalogSkill, type SkillBundle, type SkillSource } from "./LibrarySkill.ts"
import { isZip, readZip } from "./zip.ts"

/** How skills are downloaded; tests swap in a fake. */
export const SkillHttp = Context.Reference<{
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  /** Resolves host names for the private-address check; the system resolver when undefined. */
  readonly lookup?: Lookup | undefined
  readonly githubApi: string
}>("weaver/SkillHttp", {
  defaultValue: () => ({ fetch: (url, init) => fetch(url, init), githubApi: "https://api.github.com" })
})

const requestTimeout = Duration.seconds(30)
const maxRedirects = 5
const catalogTtl = Duration.hours(1)
const githubHosts: ReadonlySet<string> = new Set(["api.github.com", "raw.githubusercontent.com"])

interface Downloaded {
  readonly status: number
  readonly bytes: Uint8Array
  readonly headers: Headers
}

interface CatalogSource {
  readonly owner: string
  readonly repo: string
  readonly path: string
  readonly ref: string
}

/** `owner/repo[/path][@ref]`, as in `WEAVER_SKILL_CATALOG`. */
export const parseCatalogSource = (entry: string): CatalogSource | undefined => {
  const [location = "", ref = ""] = entry.trim().split("@")
  const [owner, repo, ...path] = location.split("/").filter((part) => part.length > 0)
  if (owner === undefined || repo === undefined) return undefined
  return { owner, repo, path: path.join("/"), ref: ref.trim() || "HEAD" }
}

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/")
const join = (...parts: ReadonlyArray<string>): string => parts.filter((part) => part.length > 0).join("/")
const rawUrl = (owner: string, repo: string, ref: string, path: string) =>
  `https://raw.githubusercontent.com/${owner}/${repo}/${encodePath(ref)}/${encodePath(path)}`
export const treeUrl = (owner: string, repo: string, ref: string, path: string) =>
  `https://github.com/${owner}/${repo}/tree/${join(ref, path)}`

/** Reads at most `limit` bytes of a response body; undefined when it's longer. */
const readLimited = async (response: Response, limit: number): Promise<Uint8Array | undefined> => {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > limit) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** Fetches skills from GitHub and other https links, and lists the skills catalog. */
export class SkillSources extends Context.Service<SkillSources, {
  /** Downloads the skill a link points to. */
  fetch(url: string): Effect.Effect<{ readonly bundle: SkillBundle; readonly source: SkillSource }, SkillInvalid>
  /** Skills in the catalog sources, cached for an hour; `installed` is left false. Never fails. */
  readonly catalog: Effect.Effect<Catalog>
}>()("weaver/SkillSources") {
  static readonly layer = Layer.effect(
    SkillSources,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const http = yield* SkillHttp
      const token = Redacted.value(config.githubToken)
      const sources = config.skillCatalog.flatMap((entry) => {
        const parsed = parseCatalogSource(entry)
        return parsed === undefined ? [] : [parsed]
      })

      const guard = (raw: string) =>
        Effect.gen(function*() {
          const url = yield* publicUrl(raw, http.lookup).pipe(Effect.mapError((failure) => invalid(failure.message)))
          if (url.protocol !== "https:") return yield* invalid(`Only https links can be installed, not ${url.protocol} ones.`)
          return url
        })

      /** GETs a URL with every redirect checked, sending the GitHub token to GitHub only. */
      const download = (raw: string, maxBytes: number, accept = "*/*") =>
        Effect.gen(function*() {
          let url = yield* guard(raw)
          for (let hop = 0;; hop++) {
            const target = url
            const headers: Record<string, string> = { "user-agent": "weaver-skills", accept }
            if (token.length > 0 && githubHosts.has(target.hostname)) headers.authorization = `Bearer ${token}`
            const response = yield* Effect.tryPromise({
              try: (signal) => http.fetch(target.href, { headers, redirect: "manual", signal }),
              catch: (cause) => invalid(`Couldn't reach ${target.host}: ${errorText(cause)}`)
            })
            const location = response.headers.get("location")
            if (response.status >= 300 && response.status < 400 && location !== null) {
              yield* Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve())
              if (hop >= maxRedirects) return yield* invalid(`${raw} redirected too many times.`)
              url = yield* guard(new URL(location, target).href)
              continue
            }
            const bytes = yield* Effect.tryPromise({
              try: () => readLimited(response, maxBytes),
              catch: (cause) => invalid(`Couldn't download ${target.href}: ${errorText(cause)}`)
            })
            if (bytes === undefined) return yield* invalid(`${target.href} is larger than ${Math.round(maxBytes / 1048576)} MiB.`)
            return { status: response.status, bytes, headers: response.headers } satisfies Downloaded
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: requestTimeout,
            orElse: () => Effect.fail(invalid(`Downloading ${raw} took longer than 30 seconds.`))
          })
        )

      const githubFailure = (response: Downloaded, what: string) => {
        if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
          return invalid(
            `GitHub's rate limit was reached, so ${what} can't be read right now. Try again later` +
              (token.length > 0 ? "." : ", or set WEAVER_GITHUB_TOKEN on the server.")
          )
        }
        return invalid(`GitHub answered ${response.status} for ${what}.`)
      }

      interface TreeEntry {
        readonly path: string
        readonly mode: string
        readonly type: string
        readonly size?: number
      }

      /** The files under `path` at `ref`, from the git trees API; undefined when GitHub doesn't know that ref or path. */
      const treeOf = (owner: string, repo: string, ref: string, path: string) =>
        Effect.gen(function*() {
          const what = `${owner}/${repo}`
          const response = yield* download(
            `${http.githubApi}/repos/${owner}/${repo}/git/trees/${encodePath(path.length > 0 ? `${ref}:${path}` : ref)}?recursive=1`,
            8 * 1024 * 1024,
            "application/vnd.github+json"
          )
          if (response.status === 404 || response.status === 422) return undefined
          if (response.status !== 200) return yield* githubFailure(response, what)
          const body = yield* Effect.try({
            try: () => JSON.parse(new TextDecoder().decode(response.bytes)) as { tree?: Array<TreeEntry>; truncated?: boolean },
            catch: () => invalid(`GitHub sent an unreadable answer for ${what}.`)
          })
          if (body.truncated === true) return yield* invalid(`${what} has too many files to read through GitHub's API.`)
          return body.tree ?? []
        })

      /** Tries each split of `segments` into a ref and a path, since branch names can contain slashes. */
      const resolveTree = (owner: string, repo: string, segments: ReadonlyArray<string>, keep: number) =>
        Effect.gen(function*() {
          for (let refLength = 1; refLength <= Math.min(segments.length - keep, 6); refLength++) {
            const ref = segments.slice(0, refLength).join("/")
            const path = segments.slice(refLength, segments.length - keep).join("/")
            const tree = yield* treeOf(owner, repo, ref, path)
            if (tree !== undefined) return { ref, path, tree }
          }
          return yield* invalid(`Couldn't find that folder on GitHub. Check the link, and that the repository is public.`)
        })

      const fromGithubFolder = (owner: string, repo: string, ref: string, path: string, tree: ReadonlyArray<TreeEntry>) =>
        Effect.gen(function*() {
          const link = tree.find((entry) => entry.mode === "120000")
          if (link !== undefined) return yield* invalid(`"${link.path}" is a symbolic link, which skills can't contain.`)
          const blobs = tree.filter((entry) => entry.type === "blob" && !entry.path.split("/").some((part) => part.startsWith(".")))
          if (!blobs.some((entry) => entry.path === skillFile)) {
            return yield* invalid(`There's no ${skillFile} in ${owner}/${repo}/${path || "(top folder)"}. Link to the skill's own folder.`)
          }
          if (blobs.length > maxSkillFiles) return yield* invalid(`The skill has ${blobs.length} files; the limit is ${maxSkillFiles}.`)
          const big = blobs.find((entry) => (entry.size ?? 0) > limits.maxFileBytes)
          if (big !== undefined) return yield* invalid(`"${big.path}" is larger than 1 MiB.`)
          if (blobs.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > maxSkillBytes) return yield* invalid("The skill is larger than 10 MiB.")
          const files = yield* Effect.forEach(blobs, (entry) =>
            Effect.gen(function*() {
              const response = yield* download(rawUrl(owner, repo, ref, join(path, entry.path)), limits.maxFileBytes)
              if (response.status !== 200) return yield* githubFailure(response, entry.path)
              return { path: entry.path, bytes: response.bytes }
            }), { concurrency: 8 })
          return { files, folderName: path.split("/").at(-1) }
        })

      const fromBytes = (bytes: Uint8Array, folderName: string | undefined) =>
        Effect.gen(function*() {
          if (isZip(bytes)) {
            const files = readZip(bytes, limits)
            if (typeof files === "string") return yield* invalid(files)
            return { files, folderName } satisfies SkillBundle
          }
          if (bytes.subarray(0, 8192).includes(0) || !new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().startsWith("---")) {
            return yield* invalid(`That link isn't a ${skillFile} or a .zip of a skill folder.`)
          }
          return { files: [{ path: skillFile, bytes }], folderName } satisfies SkillBundle
        })

      const catalogSourceOf = (owner: string, repo: string, path: string) =>
        sources.some((source) =>
          source.owner.toLowerCase() === owner.toLowerCase() && source.repo.toLowerCase() === repo.toLowerCase() &&
          (source.path.length === 0 || path === source.path || path.startsWith(`${source.path}/`))
        )

      const fetchSkill = Effect.fn("SkillSources.fetch")(function*(raw: string) {
        const url = yield* guard(raw.trim())
        const segments = url.pathname.split("/").filter((part) => part.length > 0).map(decodeURIComponent)
        if (url.hostname === "github.com" || url.hostname === "www.github.com") {
          const [owner, repo, kind, ...rest] = segments
          if (owner === undefined || repo === undefined) return yield* invalid("Link to a skill's folder on GitHub.")
          const repoName = repo.replace(/\.git$/, "")
          if (kind === undefined || kind === "tree" || kind === "blob") {
            const isBlob = kind === "blob"
            if (isBlob && rest.at(-1) !== skillFile) return yield* invalid(`Link to the skill's folder or its ${skillFile}.`)
            const { path, ref, tree } = kind === undefined
              ? { ref: "HEAD", path: "", tree: (yield* treeOf(owner, repoName, "HEAD", "")) ?? [] }
              : yield* resolveTree(owner, repoName, rest, isBlob ? 1 : 0)
            const bundle = yield* fromGithubFolder(owner, repoName, ref, path, tree)
            const kindOf = catalogSourceOf(owner, repoName, path) ? "catalog" as const : "github" as const
            return { bundle, source: { kind: kindOf, url: treeUrl(owner, repoName, ref, path), ref } }
          }
        }
        const response = yield* download(url.href, maxSkillBytes)
        if (response.status !== 200) return yield* invalid(`${url.host} answered ${response.status}.`)
        const folder = url.hostname === "raw.githubusercontent.com" ? segments.at(-2) : undefined
        const bundle = yield* fromBytes(response.bytes, folder ?? segments.at(-1)?.replace(/\.zip$/i, ""))
        const kind = url.hostname === "raw.githubusercontent.com" ? "github" as const : "url" as const
        return { bundle, source: { kind, url: url.href } }
      })

      const listSource = (source: CatalogSource) =>
        Effect.gen(function*() {
          const tree = yield* treeOf(source.owner, source.repo, source.ref, source.path)
          if (tree === undefined) return yield* invalid(`Couldn't find ${source.owner}/${source.repo}/${source.path} on GitHub.`)
          const folders = tree.flatMap((entry) => {
            const match = /^([^/.][^/]*)\/SKILL\.md$/.exec(entry.path)
            return entry.type === "blob" && match !== null ? [match[1]!] : []
          })
          return yield* Effect.forEach(folders, (folder) =>
            Effect.gen(function*() {
              const path = join(source.path, folder)
              const response = yield* Effect.option(download(rawUrl(source.owner, source.repo, source.ref, `${path}/${skillFile}`), 256 * 1024))
              const parsed = response._tag === "Some" && response.value.status === 200
                ? parseFrontmatter(new TextDecoder().decode(response.value.bytes))
                : undefined
              const fields = parsed === undefined || typeof parsed === "string" ? {} : parsed.fields
              const declared = fieldText(fields.name)
              return {
                name: validateName(declared) === undefined ? declared : folder,
                description: fieldText(fields.description),
                source: `${source.owner}/${source.repo}`,
                url: treeUrl(source.owner, source.repo, source.ref, path),
                installed: false
              } satisfies CatalogSkill
            }), { concurrency: 8 })
        })

      const loadCatalog = Effect.gen(function*() {
        const skills: Array<CatalogSkill> = []
        const errors: Array<string> = []
        for (const source of sources) {
          const listed = yield* Effect.result(listSource(source))
          if (listed._tag === "Success") skills.push(...listed.success)
          else errors.push(listed.failure.message)
        }
        if (config.skillCatalog.length > sources.length) errors.push("Some WEAVER_SKILL_CATALOG entries aren't owner/repo[/path][@ref].")
        return new Catalog({
          skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
          sources: [...new Set(sources.map((source) => `${source.owner}/${source.repo}`))],
          ...(errors.length > 0 ? { error: errors.join(" ") } : {})
        })
      })

      const lock = Semaphore.makeUnsafe(1)
      let cached: { readonly at: number; readonly catalog: Catalog } | undefined
      const catalog = lock.withPermit(Effect.gen(function*() {
        if (cached !== undefined && Date.now() - cached.at < Duration.toMillis(catalogTtl)) return cached.catalog
        const loaded = yield* loadCatalog
        if (loaded.error === undefined) cached = { at: Date.now(), catalog: loaded }
        return loaded
      }))

      return SkillSources.of({ fetch: fetchSkill, catalog })
    })
  )
}

/**
 * Downloads the skill a link points to (a catalog entry's `url`, say) and adds it to the library,
 * as `POST /v1/skills/install` does.
 */
export const installFromUrl = (
  sources: SkillSources["Service"],
  library: LibraryStore["Service"],
  url: string,
  options: Omit<InstallOptions, "createdBy" | "source"> = {}
) =>
  Effect.flatMap(
    sources.fetch(url),
    ({ bundle, source }) => library.install(bundle, { ...options, createdBy: "import", source })
  )
