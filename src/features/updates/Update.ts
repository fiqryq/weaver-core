import { Schema } from "effect"

export const updateChannels = ["stable", "latest"] as const
export const UpdateChannel = Schema.Literals(updateChannels)
export type UpdateChannel = typeof UpdateChannel.Type

export const updateStates = [
  "idle",
  "requested",
  "downloading",
  "verifying",
  "installing",
  "restarting",
  "done",
  "failed",
  "rolled-back"
] as const
export type UpdateState = typeof updateStates[number]

/** States in which an update is on its way; another can't be requested until it ends. */
export const inProgressStates: ReadonlySet<UpdateState> = new Set([
  "requested",
  "downloading",
  "verifying",
  "installing",
  "restarting"
])

/** Release tags weaver-update accepts. */
export const validTag = (tag: string): boolean => /^[A-Za-z0-9._-]+$/.test(tag) && tag.length <= 128

export class UpdatesUnsupported extends Schema.TaggedError<UpdatesUnsupported>()("UpdatesUnsupported", {
  message: Schema.String
}, { httpApiStatus: 503 }) {}

export class UpdateInProgress extends Schema.TaggedError<UpdateInProgress>()("UpdateInProgress", {
  message: Schema.String
}, { httpApiStatus: 409 }) {}

export class NoUpdate extends Schema.TaggedError<NoUpdate>()("NoUpdate", {
  message: Schema.String
}, { httpApiStatus: 404 }) {}

/** The build that's running. */
export class CurrentBuild extends Schema.Class<CurrentBuild>("CurrentBuild")({
  version: Schema.String,
  commit: Schema.String,
  builtAt: Schema.NullOr(Schema.String)
}) {}

/** A release on the update channel, as its release.json describes it. */
export class ReleaseInfo extends Schema.Class<ReleaseInfo>("ReleaseInfo")({
  version: Schema.String,
  /** Short git SHA; empty for releases made before release.json existed. */
  commit: Schema.String,
  tag: Schema.String,
  /** ISO-8601; empty when the release doesn't say. */
  publishedAt: Schema.String,
  /** Markdown release notes. */
  notes: Schema.String
}) {}

/** Progress of the last update the root-side updater ran (or was asked to run). */
export class UpdateStatus extends Schema.Class<UpdateStatus>("UpdateStatus")({
  state: Schema.Literals(updateStates),
  message: Schema.NullOr(Schema.String),
  tag: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String)
}) {}

export class UpdateCheck extends Schema.Class<UpdateCheck>("UpdateCheck")({
  current: CurrentBuild,
  channel: UpdateChannel,
  /** Null when no release could be found; `checkError` says why. */
  latest: Schema.NullOr(ReleaseInfo),
  /** stable: `latest.version` is a newer semver; latest: `latest.commit` differs from the running one. */
  available: Schema.Boolean,
  checkedAt: Schema.String,
  checkError: Schema.NullOr(Schema.String),
  /** The root-side updater is installed, so `POST /v1/update` can install updates. */
  supported: Schema.Boolean,
  status: UpdateStatus
}) {}

export const UpdateRequest = Schema.Struct({
  channel: Schema.optional(UpdateChannel),
  /** A specific release tag to install instead of the channel's newest. */
  tag: Schema.optional(Schema.String)
})

interface Semver {
  readonly core: ReadonlyArray<number>
  readonly prerelease: ReadonlyArray<string>
}

const parseSemver = (text: string): Semver | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (match === null) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split(".")
  }
}

const comparePrerelease = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
  // A release sorts after its prereleases.
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumber = /^\d+$/.test(left)
    const rightNumber = /^\d+$/.test(right)
    if (leftNumber && rightNumber) {
      const difference = Number(left) - Number(right)
      if (difference !== 0) return Math.sign(difference)
    } else if (leftNumber !== rightNumber) {
      return leftNumber ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

/** Compares two semantic versions (a leading `v` is fine); undefined when either isn't one. */
export const compareVersions = (a: string, b: string): number | undefined => {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === undefined || right === undefined) return undefined
  for (let index = 0; index < 3; index++) {
    const difference = left.core[index]! - right.core[index]!
    if (difference !== 0) return Math.sign(difference)
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** Whether two short (or full) git SHAs name the same commit. */
export const sameCommit = (a: string, b: string): boolean => {
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  if (left.length < 7 || right.length < 7) return left === right
  return left.startsWith(right) || right.startsWith(left)
}

/** Whether `latest` is newer than the running build on the channel. */
export const isUpdateAvailable = (channel: UpdateChannel, current: CurrentBuild, latest: ReleaseInfo | null): boolean => {
  if (latest === null) return false
  if (channel === "stable") return (compareVersions(latest.version, current.version) ?? 0) > 0
  return latest.commit.length > 0 && !sameCommit(latest.commit, current.commit)
}
