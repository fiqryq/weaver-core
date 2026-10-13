import { Context, Duration, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { AppConfig, perBotUsers } from "../../config/Config.ts"
import { fallbackPath } from "../lib/util.ts"

export class BotUserError extends Schema.TaggedError<BotUserError>()("BotUserError", {
  message: Schema.String
}) {}

/** Bot IDs are UUIDs; anything else never reaches sudo. */
export const isValidBotId = (botId: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(botId)

const isValidUserName = (name: string): boolean => /^wb-[a-z0-9]{1,12}$/.test(name)

/** The Linux user each bot's commands run as. */
export class BotUsers extends Context.Service<BotUsers, {
  /** The user to run the bot's commands as; undefined runs them as the server's own user. */
  userFor(botId: string): Effect.Effect<string | undefined, BotUserError>
  /** Deletes a bot's own user and stops its processes. Never fails; problems are logged. */
  remove(botId: string): Effect.Effect<void>
}>()("weaver/BotUsers") {
  static readonly layer = Layer.effect(
    BotUsers,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const botUser = Option.getOrUndefined(config.botUser)

      if (botUser === undefined || botUser.user !== perBotUsers) {
        return BotUsers.of({ userFor: () => Effect.succeed(botUser?.user), remove: () => Effect.void })
      }

      const helper = config.botUserHelper
      const users = new Map<string, string>()
      const locks = new Map<string, Semaphore.Semaphore>()
      const lockFor = (botId: string) => {
        let lock = locks.get(botId)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          locks.set(botId, lock)
        }
        return lock
      }

      /** Runs `sudo -n <helper> <action> <botId>`, returning its stdout or why it failed. */
      const runHelper = (action: "ensure" | "remove", botId: string) =>
        Effect.gen(function*() {
          const handle = yield* spawner.spawn(
            ChildProcess.make("sudo", ["-n", helper, action, botId], {
              env: { PATH: process.env.PATH ?? fallbackPath },
              extendEnv: false,
              stdin: "ignore"
            })
          )
          const [stdout, stderr, code] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
            { concurrency: "unbounded" }
          )
          if (Number(code) !== 0) {
            return yield* new BotUserError({ message: stderr.trim() || stdout.trim() || `exit code ${code}` })
          }
          return stdout.trim()
        }).pipe(
          Effect.scoped,
          Effect.mapError((error) => new BotUserError({ message: error.message })),
          Effect.timeoutOrElse({
            // The first call for a bot walks its whole workspace to set permissions.
            duration: Duration.minutes(3),
            orElse: () => Effect.fail(new BotUserError({ message: "it didn't finish within 3 minutes" }))
          })
        )

      const ensure = (botId: string) =>
        lockFor(botId).withPermit(Effect.suspend(() => {
          const known = users.get(botId)
          if (known !== undefined) return Effect.succeed(known)
          return runHelper("ensure", botId).pipe(
            Effect.flatMap((output) =>
              isValidUserName(output)
                ? Effect.succeed(output)
                : Effect.fail(new BotUserError({ message: `it printed an unexpected user name: ${JSON.stringify(output.slice(0, 80))}` }))
            ),
            Effect.tap((user) => Effect.sync(() => users.set(botId, user))),
            Effect.mapError((error) =>
              new BotUserError({
                message: `Can't set up this bot's Linux user: sudo ${helper} ensure failed (${error.message}). Rerun the setup script.`
              })
            )
          )
        }))

      const userFor = (botId: string) =>
        isValidBotId(botId)
          ? ensure(botId)
          : Effect.fail(new BotUserError({ message: `Can't set up a Linux user for bot ID ${JSON.stringify(botId)}.` }))

      const remove = (botId: string) =>
        Effect.gen(function*() {
          if (!isValidBotId(botId)) return yield* Effect.logWarning(`Not removing the Linux user of bot ID ${JSON.stringify(botId)}`)
          yield* lockFor(botId).withPermit(
            Effect.andThen(
              Effect.sync(() => users.delete(botId)),
              runHelper("remove", botId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`Couldn't remove the Linux user of bot ${botId}: sudo ${helper} remove failed (${error.message})`)
                )
              )
            )
          )
          locks.delete(botId)
        })

      return BotUsers.of({ userFor, remove })
    })
  )
}
