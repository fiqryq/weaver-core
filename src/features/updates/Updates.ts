import { randomBytes } from "node:crypto"
import { access, constants, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Context, Duration, Effect, Layer, Redacted } from "effect"
import { AppConfig, builtAt, commit, version } from "../../config/Config.ts"
import { BadRequest } from "../../platform/http/errors.ts"
import {
  CurrentBuild,
  inProgressStates,
  isUpdateAvailable,
  NoUpdate,
  ReleaseInfo,
  UpdateChannel,
  UpdateCheck,
  UpdateInProgress,
  UpdatesUnsupported,
  type UpdateState,
  updateStates,
  UpdateStatus,
  validTag
} from "./Update.ts"

/** How release information is downloaded; tests swap in a fake. */
export const UpdateHttp = Context.Reference<{
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  readonly githubApi: string
}>("weaver/UpdateHttp", {
  defaultValue: () => ({ fetch: (url, init) => fetch(url, init), githubApi: "https://api.github.com" })
})

/** Files in the update folder shared with the root-side updater (see weaver-update). */
export const updateFiles = {
  request: "request",
  status: "status.json",
  marker: ".updater-installed"
} as const

const requestTimeout = Duration.seconds(15)
const checkTtl = Duration.toMillis(Duration.hours(1))
/** A failed check is retried sooner than a successful one is refreshed. */
const failedCheckTtl = Duration.toMillis(Duration.minutes(5))
/** A request the updater hasn't picked up in this long no longer counts as an update in progress. */
export const staleRequestMs = Duration.toMillis(Duration.minutes(10))
/** An update that hasn't reported progress in this long is taken to have died. */
export const staleProgressMs = Duration.toMillis(Duration.minutes(30))

const idle = new UpdateStatus({ state: "idle", message: null, tag: null, updatedAt: null })

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

class CheckFailed {
  readonly _tag = "CheckFailed"
  constructor(readonly message: string) {}
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/** release.json, leniently: anything missing comes from the GitHub release or stays empty. */
const releaseFromJson = (json: unknown, fallback: Partial<ReleaseInfo> = {}): ReleaseInfo | undefined => {
  const record = typeof json === "object" && json !== null ? json as Record<string, unknown> : {}
  const tag = text(record.tag) ?? fallback.tag
  const releaseVersion = text(record.version) ?? fallback.version
  if (tag === undefined || releaseVersion === undefined) return undefined
  return new ReleaseInfo({
    version: releaseVersion,
    commit: text(record.commit) ?? fallback.commit ?? "",
    tag,
    publishedAt: text(record.publishedAt) ?? fallback.publishedAt ?? "",
    notes: text(record.notes) ?? fallback.notes ?? ""
  })
}

/** `server-v1.2.3` and `v1.2.3` are version 1.2.3. */
export const versionFromTag = (tag: string): string => tag.replace(/^server-/, "").replace(/^v(?=\d)/, "")

interface Checked {
  readonly latest: ReleaseInfo | null
  readonly checkError: string | null
  readonly checkedAt: number
}

/**
 * Checks the release channels for a newer server and asks the root-side updater to install one. The
 * server never runs anything as root: it leaves the tag in `<updateDir>/request`, which a systemd path
 * unit (weaver-update.path) hands to `weaver-update --from-request`; that reports progress in
 * `<updateDir>/status.json`.
 */
export class Updates extends Context.Service<Updates, {
  /** The channel's newest release against the running build. Never fails; problems end up in `checkError`. */
  check(channel: UpdateChannel, refresh: boolean): Effect.Effect<UpdateCheck>
  /** Queues an update to `tag`, or to the channel's newest release when it's newer than this build. */
  request(
    channel: UpdateChannel,
    tag: string | undefined
  ): Effect.Effect<UpdateCheck, UpdatesUnsupported | UpdateInProgress | NoUpdate | BadRequest>
}>()("weaver/Updates") {
  static readonly layer = Layer.effect(
    Updates,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const http = yield* UpdateHttp
      const token = Redacted.value(config.githubToken)
      const current = new CurrentBuild({ version, commit, builtAt })
      const cache = new Map<UpdateChannel, Checked>()
      const file = (name: string) => join(config.updateDir, name)

      const getJson = (url: string, headers: Record<string, string> = {}) =>
        Effect.tryPromise({
          try: async (signal) => {
            const response = await http.fetch(url, {
              headers: { "user-agent": "weaver-update", accept: "application/json", ...headers },
              redirect: "follow",
              signal
            })
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined)
              return { status: response.status, json: undefined as unknown }
            }
            return { status: response.status, json: await response.json() as unknown }
          },
          catch: (cause) => new CheckFailed(`Couldn't reach ${new URL(url).host}: ${errorText(cause)}`)
        }).pipe(
          Effect.timeoutOrElse({
            duration: requestTimeout,
            orElse: () => Effect.fail(new CheckFailed(`${new URL(url).host} didn't answer within 15 seconds.`))
          })
        )

      const releaseJsonUrl = (tag: string) => `${config.updateUrl}/${encodeURIComponent(tag)}/release.json`

      const latestBuild = Effect.gen(function*() {
        const { status, json } = yield* getJson(releaseJsonUrl("server-latest"))
        if (json === undefined) {
          return yield* Effect.fail(
            new CheckFailed(status === 404
              ? "The latest build has no release.json yet."
              : `Downloading the latest build's release.json failed (HTTP ${status}).`)
          )
        }
        const release = releaseFromJson(json, { tag: "server-latest" })
        if (release === undefined) return yield* Effect.fail(new CheckFailed("The latest build's release.json isn't valid."))
        return release
      })

      const stableRelease = Effect.gen(function*() {
        const headers: Record<string, string> = { accept: "application/vnd.github+json" }
        if (token.length > 0) headers.authorization = `Bearer ${token}`
        const { status, json } = yield* getJson(`${http.githubApi}/repos/${config.updateRepo}/releases/latest`, headers)
        if (json === undefined) {
          return yield* Effect.fail(
            new CheckFailed(status === 404
              ? `${config.updateRepo} has no stable release yet.`
              : `GitHub didn't list ${config.updateRepo}'s releases (HTTP ${status}).`)
          )
        }
        const record = typeof json === "object" && json !== null ? json as Record<string, unknown> : {}
        const tag = text(record.tag_name)
        if (tag === undefined || !validTag(tag)) {
          return yield* Effect.fail(new CheckFailed("GitHub's newest release has no usable tag."))
        }
        const fallback = {
          tag,
          version: versionFromTag(tag),
          publishedAt: text(record.published_at) ?? "",
          notes: text(record.body) ?? ""
        }
        const assets = Array.isArray(record.assets) ? record.assets as Array<Record<string, unknown>> : []
        if (!assets.some((asset) => asset.name === "release.json")) return releaseFromJson({}, fallback)!
        // Releases made before release.json existed (or a failed download of it) still give a version.
        const described = yield* getJson(releaseJsonUrl(tag)).pipe(Effect.orElseSucceed(() => ({ json: undefined })))
        return releaseFromJson(described.json ?? {}, fallback) ?? releaseFromJson({}, fallback)!
      })

      const fetchLatest = (channel: UpdateChannel) =>
        (channel === "latest" ? latestBuild : stableRelease).pipe(
          Effect.map((latest): Checked => ({ latest, checkError: null, checkedAt: Date.now() })),
          Effect.catch((failure: CheckFailed) =>
            Effect.succeed<Checked>({ latest: null, checkError: failure.message, checkedAt: Date.now() })
          )
        )

      const latestFor = (channel: UpdateChannel, refresh: boolean) =>
        Effect.gen(function*() {
          const cached = cache.get(channel)
          if (!refresh && cached !== undefined) {
            const ttl = cached.latest === null ? failedCheckTtl : checkTtl
            if (Date.now() - cached.checkedAt < ttl) return cached
          }
          const checked = yield* fetchLatest(channel)
          cache.set(channel, checked)
          return checked
        })

      const supported = Effect.promise(async () => {
        try {
          await stat(file(updateFiles.marker))
          await access(config.updateDir, constants.W_OK | constants.X_OK)
          return true
        } catch {
          return false
        }
      })

      const readStatusFile = async (): Promise<UpdateStatus> => {
        const raw = await readFile(file(updateFiles.status), "utf8").catch(() => undefined)
        if (raw === undefined) return idle
        let json: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(raw)
          if (typeof parsed !== "object" || parsed === null) return idle
          json = parsed as Record<string, unknown>
        } catch {
          return idle
        }
        const state = text(json.state)
        if (state === undefined || !updateStates.includes(state as UpdateState)) return idle
        return new UpdateStatus({
          state: state as UpdateState,
          message: text(json.message) || null,
          tag: text(json.tag) || null,
          updatedAt: text(json.updatedAt) || null
        })
      }

      /** The request waiting for the updater, if any, and the updater's last status. */
      const status = Effect.promise(async (): Promise<UpdateStatus> => {
        const now = Date.now()
        const reported = await readStatusFile()
        const reportedAt = reported.updatedAt === null ? Number.NaN : Date.parse(reported.updatedAt)
        const pending = await stat(file(updateFiles.request)).catch(() => undefined)
        if (pending?.isFile() === true) {
          const tag = (await readFile(file(updateFiles.request), "utf8").catch(() => "")).trim().split("\n")[0] ?? ""
          const requestedAt = new Date(pending.mtimeMs).toISOString()
          if (now - pending.mtimeMs < staleRequestMs) {
            return new UpdateStatus({ state: "requested", message: null, tag: tag || null, updatedAt: requestedAt })
          }
          // Nothing took the request. A later run of weaver-update by hand still has the last word.
          if (reportedAt > pending.mtimeMs && !inProgressStates.has(reported.state)) return reported
          return new UpdateStatus({
            state: "failed",
            message: "The updater didn't pick up the update request. Run `sudo weaver-update` once on the bots' computer.",
            tag: tag || null,
            updatedAt: requestedAt
          })
        }
        if (inProgressStates.has(reported.state) && !(now - reportedAt < staleProgressMs)) {
          return new UpdateStatus({
            ...reported,
            state: "failed",
            message: "The update stopped without finishing. Check `journalctl -u weaver-update-request` on the bots' computer."
          })
        }
        return reported
      })

      const check = (channel: UpdateChannel, refresh: boolean) =>
        Effect.gen(function*() {
          const checked = yield* latestFor(channel, refresh)
          return new UpdateCheck({
            current,
            channel,
            latest: checked.latest,
            available: isUpdateAvailable(channel, current, checked.latest),
            checkedAt: new Date(checked.checkedAt).toISOString(),
            checkError: checked.checkError,
            supported: yield* supported,
            status: yield* status
          })
        })

      /** Writes the request next to its final name and renames it in, so the updater never reads half of it. */
      const writeRequest = (tag: string) =>
        Effect.tryPromise({
          try: async () => {
            const staged = file(`.request-${randomBytes(6).toString("hex")}`)
            try {
              await writeFile(staged, `${tag}\n`, { mode: 0o640 })
              await rename(staged, file(updateFiles.request))
            } finally {
              await rm(staged, { force: true })
            }
          },
          catch: (cause) =>
            new UpdatesUnsupported({ message: `Couldn't hand the update to the updater: ${errorText(cause)}` })
        })

      const request = (channel: UpdateChannel, tag: string | undefined) =>
        Effect.gen(function*() {
          if (!(yield* supported)) {
            return yield* new UpdatesUnsupported({
              message: "One-click updates aren't set up on this server. Run `sudo weaver-update` once on the bots' computer to turn them on."
            })
          }
          const before = yield* status
          if (inProgressStates.has(before.state)) {
            return yield* new UpdateInProgress({
              message: `An update${before.tag === null ? "" : ` to ${before.tag}`} is already ${before.state}.`
            })
          }
          let target = tag?.trim() ?? ""
          if (target.length === 0) {
            const checked = yield* check(channel, false)
            if (checked.latest === null) {
              return yield* new NoUpdate({ message: checked.checkError ?? `No release was found on the ${channel} channel.` })
            }
            if (!checked.available) {
              return yield* new NoUpdate({ message: `This server is already up to date with the ${channel} channel.` })
            }
            target = checked.latest.tag
          }
          if (!validTag(target)) {
            return yield* new BadRequest({ message: "A release tag has only letters, digits, '.', '_' and '-'." })
          }
          yield* writeRequest(target)
          yield* Effect.logInfo(`Asked the updater to install ${target}.`)
          return yield* check(channel, false)
        })

      return Updates.of({ check, request })
    })
  )
}
