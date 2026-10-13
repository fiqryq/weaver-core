// Compiles the agent server into a single binary with its build identity stamped in (see src/config/Config.ts):
//
//   bun build.ts --outfile dist/weaver-server [--target=bun-linux-x64]
//
// Extra arguments go to `bun build`. The version is WEAVER_BUILD_VERSION, else the version in a
// `server-v1.2.3` or `v1.2.3` tag being built (GITHUB_REF_NAME), else package.json's. The commit is
// WEAVER_BUILD_COMMIT, else `git rev-parse --short=7 HEAD`.
import packageJson from "./package.json" with { type: "json" }

const tagVersion = (ref: string | undefined): string | undefined => {
  const match = /^(?:server-)?v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/.exec(ref ?? "")
  return match?.[1]
}

const gitCommit = (): string => {
  const result = Bun.spawnSync(["git", "rev-parse", "--short=7", "HEAD"], { stderr: "ignore" })
  return result.success ? result.stdout.toString().trim() : ""
}

const env = process.env
const version = env.WEAVER_BUILD_VERSION?.trim() ||
  (env.GITHUB_REF_TYPE === "tag" ? tagVersion(env.GITHUB_REF_NAME) : undefined) ||
  packageJson.version
const commit = (env.WEAVER_BUILD_COMMIT?.trim() || gitCommit() || "dev").slice(0, 7)
const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

const define = (name: string, value: string) => ["--define", `${name}=${JSON.stringify(value)}`]
const command = [
  "bun",
  "build",
  "src/main.ts",
  "--compile",
  ...define("WEAVER_BUILD_VERSION", version),
  ...define("WEAVER_BUILD_COMMIT", commit),
  ...define("WEAVER_BUILD_TIME", builtAt),
  ...Bun.argv.slice(2)
]
console.log(`Building weaver-server ${version} (${commit}, ${builtAt})`)
const build = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" })
process.exit(build.exitCode ?? 1)
