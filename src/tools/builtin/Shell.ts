import { Clock, Duration, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { childEnv } from "../../platform/lib/util.ts"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"

export const outputLimit = 12_000
export const defaultTimeoutSeconds = 120
export const maxTimeoutSeconds = 600
/** How long `timeout` waits after SIGTERM before it sends SIGKILL to a command run as the bot user. */
export const killGraceSeconds = 5

const RunCommandParams = Schema.Struct({
  command: Schema.String.annotate({ description: "The bash command to run, e.g. `ls -la` or `git status`." }),
  timeout_seconds: Schema.optional(Schema.Int).annotate({
    description: `Stop the command after this many seconds (default ${defaultTimeoutSeconds}, max ${maxTimeoutSeconds}).`
  })
})

const titleOf = (params: unknown): string => {
  const command = Schema.is(RunCommandParams)(params) ? params.command : ""
  return command ? `Ran \`${shorten(command)}\`` : "Ran a command"
}

/** Keeps the start and the end of long output, where errors and summaries usually are. */
export const clip = (output: string, limit = outputLimit): string => {
  if (output.length <= limit) return output
  const head = output.slice(0, Math.floor(limit * 0.4))
  const tail = output.slice(output.length - Math.floor(limit * 0.6))
  return `${head}\n… (${output.length - limit} characters cut) …\n${tail}`
}

/** Variables from the server's environment that commands run as the bot user still get. */
const keptForBotUser = ["LANG", "LANGUAGE", "LC_ALL", "TZ"] as const
const fallbackPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

export interface CommandSpec {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/**
 * The process for one bot command. With `runAs` it runs as that user through `sudo`, with a clean
 * environment, and under `timeout`: the server can't signal another user's processes, so the time
 * limit has to be enforced from inside.
 */
export const commandSpec = (options: {
  readonly command: string
  readonly workspace: string
  readonly display: string
  readonly seconds: number
  readonly runAs: string | undefined
  readonly env?: Readonly<Record<string, string>>
}): CommandSpec => {
  const env = options.env ?? childEnv()
  const extra = { DISPLAY: options.display, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" }
  if (options.runAs === undefined) {
    return { command: "bash", args: ["-lc", options.command], cwd: options.workspace, env: { ...env, ...extra } }
  }
  const kept: Record<string, string> = {}
  for (const key of keptForBotUser) {
    const value = env[key]
    if (value !== undefined) kept[key] = value
  }
  return {
    command: "sudo",
    args: [
      "-n",
      "-u",
      options.runAs,
      "-H",
      "--",
      "env",
      ...Object.entries({ ...kept, ...extra }).map(([key, value]) => `${key}=${value}`),
      "timeout",
      "-k",
      String(killGraceSeconds),
      String(options.seconds),
      "bash",
      "-c",
      // sudo applies its own umask, so set ours after it; the workspace is setgid and group-shared.
      "umask 007 && cd -- \"$1\" && exec bash -lc \"$2\"",
      "weaver",
      options.workspace,
      options.command
    ],
    cwd: options.workspace,
    env: { PATH: env.PATH ?? fallbackPath, ...kept }
  }
}

export const runCommandTool = (options: {
  readonly workspace: string
  readonly display: string
  readonly needsApproval: boolean
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  /** Runs commands as this user through `sudo`; undefined runs them as the server's user. */
  readonly runAs?: string | undefined
}): AgentTool => {
  const { runAs, spawner } = options

  /** Why `sudo` can't switch to the bot user, or undefined when it can. */
  const sudoProblem = (user: string) =>
    Effect.gen(function*() {
      const handle = yield* spawner.spawn(
        ChildProcess.make("sudo", ["-n", "-u", user, "--", "true"], {
          env: { PATH: process.env.PATH ?? fallbackPath },
          extendEnv: false,
          stdin: "ignore"
        })
      )
      const output = yield* Stream.mkString(Stream.decodeText(handle.all))
      const code = yield* handle.exitCode
      return Number(code) === 0 ? undefined : output.trim() || `exit code ${code}`
    }).pipe(
      Effect.scoped,
      Effect.catch((error) => Effect.succeed<string | undefined>(error.message)),
      Effect.timeoutOption(Duration.seconds(10)),
      Effect.map(Option.getOrElse(() => "sudo didn't answer"))
    )

  return {
    name: "run_command",
    description:
      "Run a bash command on your Linux VPS. It starts in your workspace directory and can use anything installed on the machine. " +
      `Commands run non-interactively (no stdin) and are stopped after ${defaultTimeoutSeconds} seconds unless you pass timeout_seconds. ` +
      `GUI programs show up on the desktop the user can watch (DISPLAY=${options.display}). Output is cut to about ${outputLimit} characters.`,
    parameters: jsonSchemaOf(RunCommandParams),
    needsApproval: options.needsApproval,
    activity: "Running a command",
    title: titleOf,
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(RunCommandParams, raw)
        const seconds = Math.min(Math.max(params.timeout_seconds ?? defaultTimeoutSeconds, 1), maxTimeoutSeconds)
        const spec = commandSpec({ command: params.command, workspace: options.workspace, display: options.display, seconds, runAs })
        let output = ""

        const execute = Effect.gen(function*() {
          const handle = yield* spawner.spawn(
            ChildProcess.make(spec.command, [...spec.args], {
              cwd: spec.cwd,
              env: spec.env,
              extendEnv: false,
              stdin: "ignore"
            })
          )
          yield* handle.all.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                // Keep reading so the process isn't blocked, but stop growing past what we'd keep.
                if (output.length < outputLimit * 4) output += chunk
              })
            )
          )
          return yield* handle.exitCode
        }).pipe(Effect.scoped)

        // As the bot user, `timeout` stops the command; this is only a backstop. Interrupting sends
        // SIGTERM to sudo, which passes it on to the command.
        const limit = runAs === undefined ? seconds : seconds + killGraceSeconds + 5
        const startedAt = yield* Clock.currentTimeMillis
        const exit = yield* Effect.result(execute.pipe(Effect.timeoutOption(Duration.seconds(limit))))
        const overTime = (yield* Clock.currentTimeMillis) - startedAt >= seconds * 1000
        const text = clip(output.trimEnd())
        const stopped = new ToolFailure({ message: `${text}\n\nStopped after ${seconds} seconds.`.trim() })
        if (exit._tag === "Failure") {
          // `timeout -k` kills a command that ignores SIGTERM, and sudo then dies by the same signal.
          if (runAs !== undefined && overTime) return yield* stopped
          return yield* new ToolFailure({ message: `Couldn't run the command: ${exit.failure.message}` })
        }
        const code = Option.isSome(exit.success) ? Number(exit.success.value) : undefined
        if (code === undefined || (runAs !== undefined && code === 124)) return yield* stopped
        if (runAs !== undefined && code === 1 && text.startsWith("sudo:")) {
          const problem = yield* sudoProblem(runAs)
          if (problem !== undefined) {
            return yield* new ToolFailure({
              message: `Can't run commands as ${runAs}: sudo isn't set up for it (${problem}). Rerun the setup script.`
            })
          }
        }
        const body = text.length > 0 ? text : "(no output)"
        if (code !== 0) return yield* new ToolFailure({ message: `${body}\n\nExit code: ${code}` })
        return body
      })
  }
}
