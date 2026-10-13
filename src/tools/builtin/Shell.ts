import { Clock, Duration, Effect, Fiber, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { childEnv, fallbackPath } from "../../platform/lib/util.ts"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"

/** Together under the runner's tool output limit, so the end of the output is never cut again. */
export const headBytes = 4 * 1024
export const tailBytes = 7 * 1024
export const defaultTimeoutSeconds = 120
export const maxTimeoutSeconds = 600
/** How long a command gets after SIGTERM before it's sent SIGKILL. */
export const killGraceSeconds = 5
/** How long to keep reading after the command exits, while background jobs still hold its output open. */
const drainMillis = 1_000

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

/** Keeps the first and last bytes of a command's output, where errors and summaries usually are. */
export class OutputBuffer {
  private readonly head: Uint8Array
  private headLength = 0
  private tail: Array<Uint8Array> = []
  private tailLength = 0
  private total = 0

  constructor(private readonly headSize = headBytes, private readonly tailSize = tailBytes) {
    this.head = new Uint8Array(headSize)
  }

  push(chunk: Uint8Array): void {
    this.total += chunk.length
    const toHead = Math.min(this.headSize - this.headLength, chunk.length)
    if (toHead > 0) {
      this.head.set(chunk.subarray(0, toHead), this.headLength)
      this.headLength += toHead
    }
    const rest = chunk.subarray(toHead)
    if (rest.length === 0) return
    this.tail.push(rest.length > this.tailSize ? rest.slice(rest.length - this.tailSize) : rest.slice())
    this.tailLength += Math.min(rest.length, this.tailSize)
    while (this.tailLength - this.tail[0]!.length >= this.tailSize) this.tailLength -= this.tail.shift()!.length
  }

  text(): string {
    const tail = new Uint8Array(this.tailLength)
    let offset = 0
    for (const chunk of this.tail) {
      tail.set(chunk, offset)
      offset += chunk.length
    }
    const kept = tail.subarray(Math.max(this.tailLength - this.tailSize, 0))
    const omitted = this.total - this.headLength - kept.length
    if (omitted === 0) {
      const all = new Uint8Array(this.headLength + kept.length)
      all.set(this.head.subarray(0, this.headLength))
      all.set(kept, this.headLength)
      return new TextDecoder().decode(all)
    }
    // Drop the partial characters on both sides of the cut.
    const head = new TextDecoder().decode(this.head.subarray(0, this.headLength), { stream: true })
    let start = 0
    while (start < kept.length && (kept[start]! & 0xc0) === 0x80) start++
    return `${head}\n… ${omitted} bytes omitted …\n${new TextDecoder().decode(kept.subarray(start))}`
  }
}

/** Variables from the server's environment that commands run as the bot user still get. */
const keptForBotUser = ["LANG", "LANGUAGE", "LC_ALL", "TZ"] as const

export interface CommandSpec {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/**
 * The process for one bot command, with stderr merged into stdout so they interleave in order.
 * With `runAs` it runs as that user through `sudo`, with a clean environment, and under `timeout`:
 * the server can't signal another user's processes, so the time limit has to be enforced from inside.
 * That user gets no `DISPLAY`: the desktop doesn't let bots' users in.
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
  const extra = { TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" }
  if (options.runAs === undefined) {
    return {
      command: "bash",
      args: ["-c", "exec bash -lc \"$1\" 2>&1", "weaver", options.command],
      cwd: options.workspace,
      env: { ...env, DISPLAY: options.display, ...extra }
    }
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
      "umask 007 && cd -- \"$1\" && exec bash -lc \"$2\" 2>&1",
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
  /**
   * Runs commands as this user through `sudo`; undefined runs them as the server's user. An effect
   * is resolved on every call, so a user that couldn't be set up is retried next time.
   */
  readonly runAs?: string | Effect.Effect<string | undefined, ToolFailure> | undefined
}): AgentTool => {
  const { spawner } = options
  const resolveUser: Effect.Effect<string | undefined, ToolFailure> =
    options.runAs === undefined || typeof options.runAs === "string" ? Effect.succeed(options.runAs) : options.runAs

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
      `Commands run non-interactively (no stdin) and are stopped after ${defaultTimeoutSeconds} seconds unless you pass timeout_seconds; ` +
      "background jobs are stopped when the command ends. " +
      (options.runAs === undefined
        ? `GUI programs show up on the desktop the user can watch (DISPLAY=${options.display}). `
        : "There's no display, so GUI programs can't run. ") +
      `Long output keeps only its first ${headBytes / 1024} KB and last ${tailBytes / 1024} KB.`,
    parameters: jsonSchemaOf(RunCommandParams),
    needsApproval: options.needsApproval,
    activity: "Running a command",
    title: titleOf,
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(RunCommandParams, raw)
        const runAs = yield* resolveUser
        const seconds = Math.min(Math.max(params.timeout_seconds ?? defaultTimeoutSeconds, 1), maxTimeoutSeconds)
        const spec = commandSpec({ command: params.command, workspace: options.workspace, display: options.display, seconds, runAs })
        const output = new OutputBuffer()

        // Detached, so stopping the command signals its whole process group, background jobs included.
        const execute = Effect.gen(function*() {
          const handle = yield* spawner.spawn(
            ChildProcess.make(spec.command, [...spec.args], {
              cwd: spec.cwd,
              env: spec.env,
              extendEnv: false,
              stdin: "ignore",
              detached: true,
              ...(runAs === undefined ? { forceKillAfter: Duration.seconds(killGraceSeconds) } : {})
            })
          )
          const reading = yield* handle.all.pipe(
            Stream.runForEach((chunk) => Effect.sync(() => output.push(chunk))),
            Effect.forkScoped
          )
          const code = yield* handle.exitCode
          yield* Fiber.join(reading).pipe(Effect.timeoutOption(Duration.millis(drainMillis)), Effect.ignore)
          return code
        }).pipe(Effect.scoped)

        // As the bot user, `timeout` stops the command; this is only a backstop. Interrupting sends
        // SIGTERM to sudo, which passes it on to the command.
        const limit = runAs === undefined ? seconds : seconds + killGraceSeconds + 5
        const startedAt = yield* Clock.currentTimeMillis
        const exit = yield* Effect.result(execute.pipe(Effect.timeoutOption(Duration.seconds(limit))))
        const overTime = (yield* Clock.currentTimeMillis) - startedAt >= seconds * 1000
        const text = output.text().trimEnd()
        const stopped = new ToolFailure({ message: `${text}\n\nStopped after ${seconds} seconds.`.trim() })
        if (exit._tag === "Failure") {
          // `timeout -k` kills a command that ignores SIGTERM, and sudo then dies by the same signal.
          if (runAs !== undefined && overTime) return yield* stopped
          return yield* new ToolFailure({ message: `${text}\n\nCouldn't run the command: ${exit.failure.message}`.trim() })
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
