import { Cause, Clock, Context, Duration, Effect, FiberHandle, Layer, Option, Schema } from "effect"
import { LanguageModel } from "effect/ai"
import { AppConfig } from "../../../config/Config.ts"
import {
  botMemoryProject,
  coreCacheMillis,
  coreHistoryFolder,
  corePermalink,
  coreTitle,
  memoryServerConfig,
  noteContent,
  noteWriteError,
  pinProject
} from "../../../tools/builtin/Memory.ts"
import type { Bot } from "../../bots/Bot.ts"
import { type McpCallResult, McpHub } from "../../integrations/McpHub.ts"
import { ProviderRegistry } from "../../providers/ProviderRegistry.ts"
import { backupTitle, condensedBody, condensePrompt, condenseRejection } from "./condense.ts"
import { type RecalledNote, recalledNotes, recallPageSize, recallTimeout } from "./recall.ts"

/** Wait after an attempt to condense, whether or not it worked, so a failing model doesn't loop. */
export const condenseCooldown = Duration.minutes(30)
const modelTimeout = Duration.minutes(5)

export class CondenseFailed extends Schema.TaggedError<CondenseFailed>()("CondenseFailed", {
  message: Schema.String
}) {}

export interface Condensed {
  readonly before: number
  readonly after: number
  /** Title of the note that keeps the previous text. */
  readonly backup: string
}

/**
 * The Core Memory note every bot reads on each reply, one per memory project (empty is the shared
 * project). Bots only append to it, so once it grows past the threshold it's condensed in the
 * background, one condense at a time for all bots. Alongside it, a reply recalls other notes related
 * to the message being answered.
 */
export class CoreMemory extends Context.Service<CoreMemory, {
  /** The project's whole note, cached for a minute; undefined when memory is off or unreachable, or the note is empty. */
  text(project: string): Effect.Effect<string | undefined>
  /** Forgets the project's cached note, after something wrote to it. */
  invalidate(project: string): Effect.Effect<void>
  /** Notes in the project found by a quick text search for `query`; empty when there are none or the search fails or is slow. */
  recall(query: string, project: string): Effect.Effect<ReadonlyArray<RecalledNote>>
  /** Starts condensing the bot's project's note in the background when it has grown too long. Never fails or waits on it. */
  condenseIfDue(bot: Bot): Effect.Effect<void>
  /** Condenses the bot's project's note now with the bot's model; undefined when the note is short enough already. */
  condense(bot: Bot): Effect.Effect<Condensed | undefined, CondenseFailed>
  readonly isCondensing: Effect.Effect<boolean>
  /** Stops a background condense the bot started, when the bot is deleted. */
  cancel(botId: string): Effect.Effect<void>
}>()("weaver/CoreMemory") {
  static readonly layer = Layer.effect(
    CoreMemory,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const hub = yield* McpHub
      const providers = yield* ProviderRegistry
      const running = yield* FiberHandle.make<void, never>()
      const caches = new Map<string, { text: string | undefined; fetchedAt: number }>()
      // Bumped on every invalidation, so a read that started before a write doesn't cache what it replaced.
      const generations = new Map<string, number>()
      let runningFor: string | undefined
      const nextAttemptAt = new Map<string, number>()

      const fail = (message: string) => Effect.fail(new CondenseFailed({ message }))
      const projectOf = (bot: Bot) => botMemoryProject(bot, Option.match(config.memory, { onNone: () => "", onSome: (m) => m.project }))

      const call = (project: string, name: string, args: Record<string, unknown>): Effect.Effect<McpCallResult, CondenseFailed> => {
        if (Option.isNone(config.memory)) return fail("memory isn't set up")
        return hub.call(memoryServerConfig(config.memory.value), name, pinProject(args, project)).pipe(
          Effect.mapError((error) => new CondenseFailed({ message: error.message }))
        )
      }

      /** The note's Markdown without frontmatter, exactly as stored; undefined when it's missing. */
      const read = (project: string) =>
        call(project, "read_note", { identifier: corePermalink, output_format: "json" }).pipe(
          Effect.map((result) => (result.isError ? undefined : noteContent(result.text)))
        )

      const write = (project: string, name: string, args: Record<string, unknown>) =>
        call(project, name, { ...args, output_format: "json" }).pipe(
          Effect.flatMap((result) => {
            const error = result.isError ? result.text : noteWriteError(result.text)
            return error === undefined ? Effect.void : fail(`${name} failed: ${error}`)
          })
        )

      const invalidate = (project: string) =>
        Effect.sync(() => {
          caches.delete(project)
          generations.set(project, (generations.get(project) ?? 0) + 1)
        })

      const text = (project: string) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const cache = caches.get(project)
          if (cache !== undefined && now - cache.fetchedAt < coreCacheMillis) return cache.text
          const started = generations.get(project) ?? 0
          const fetched = (yield* read(project).pipe(Effect.orElseSucceed(() => undefined)))?.trim()
          const current = fetched === undefined || fetched.length === 0 ? undefined : fetched
          if ((generations.get(project) ?? 0) === started) caches.set(project, { text: current, fetchedAt: now })
          return current
        })

      // Text search, not hybrid: Basic Memory indexes vectors in the background, so hybrid misses notes just written.
      const recall = (query: string, project: string) =>
        call(project, "search_notes", { query, page_size: recallPageSize, search_type: "text", output_format: "json" }).pipe(
          Effect.timeoutOrElse({
            duration: recallTimeout,
            orElse: () => fail(`no answer within ${Duration.format(recallTimeout)}`)
          }),
          Effect.flatMap((result) => {
            const notes = result.isError ? undefined : recalledNotes(result.text)
            return notes === undefined ? fail(`unexpected answer: ${result.text.slice(0, 200)}`) : Effect.succeed(notes)
          }),
          Effect.tap((notes) => notes.length === 0 ? Effect.logDebug("Memory recall found nothing") : Effect.void),
          Effect.catch((error) =>
            Effect.as(Effect.logDebug(`Memory recall skipped: ${error.message}`), [] as ReadonlyArray<RecalledNote>)
          )
        )

      const condense = Effect.fn("CoreMemory.condense")(function*(bot: Bot) {
        const threshold = config.coreMemoryCondenseAt
        const project = projectOf(bot)
        const original = yield* read(project)
        if (original === undefined || original.trim().length <= threshold) return undefined

        const endpoint = yield* providers.endpoint(bot.providerId, bot.model).pipe(
          Effect.catch((error) => fail(error.message))
        )
        const response = yield* LanguageModel.generateText({ prompt: condensePrompt(original.trim(), threshold) }).pipe(
          Effect.provide(providers.languageModel(endpoint)),
          Effect.catch((error) => fail(`the model failed: ${error.message}`)),
          Effect.timeoutOrElse({
            duration: modelTimeout,
            orElse: () => fail(`the model didn't answer within ${Duration.format(modelTimeout)}`)
          })
        )
        const condensed = condensedBody(response.text)
        const rejection = condenseRejection(original, condensed)
        if (rejection !== undefined) return yield* fail(`kept it as it was, because ${rejection}`)

        // Bots may have appended meanwhile; replacing only the text that was condensed keeps their lines.
        const current = yield* read(project)
        if (current === undefined || !current.includes(original)) {
          return yield* fail(`it was changed while being condensed, so it's left for the next attempt`)
        }
        const backup = backupTitle(new Date(yield* Clock.currentTimeMillis))
        yield* write(project, "write_note", { title: backup, directory: coreHistoryFolder, content: current.trim() })
        yield* write(project, "edit_note", {
          identifier: corePermalink,
          operation: "find_replace",
          find_text: original,
          content: condensed,
          expected_replacements: 1
        })
        yield* invalidate(project)
        const before = current.trim().length
        return { before, after: before - original.trim().length + condensed.length, backup }
      })

      const background = (bot: Bot) =>
        Effect.gen(function*() {
          runningFor = bot.id
          const project = projectOf(bot)
          const current = yield* text(project)
          if (current === undefined || current.length <= config.coreMemoryCondenseAt) return
          const condensed = yield* condense(bot).pipe(
            Effect.ensuring(Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Effect.sync(() => {
                nextAttemptAt.set(project, now + Duration.toMillis(condenseCooldown))
              })))
          )
          if (condensed !== undefined) {
            yield* Effect.logInfo(
              `Condensed ${coreTitle} from ${condensed.before} to ${condensed.after} characters (backup: ${condensed.backup})`
            )
          }
        }).pipe(
          Effect.catch((error) => Effect.logWarning(`Couldn't condense ${coreTitle}: ${error.message}`)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`Condensing ${coreTitle} failed`, cause)
          ),
          Effect.ensuring(Effect.sync(() => {
            runningFor = undefined
          }))
        )

      const condenseIfDue = (bot: Bot) =>
        Effect.gen(function*() {
          const memoryOn = Option.isSome(config.memory) && (bot.tools as ReadonlyArray<string>).includes("memory")
          if (config.coreMemoryCondenseAt <= 0 || !memoryOn) return
          const due = nextAttemptAt.get(projectOf(bot)) ?? 0
          if ((yield* Clock.currentTimeMillis) < due || Option.isSome(yield* FiberHandle.get(running))) return
          yield* FiberHandle.run(running, background(bot), { onlyIfMissing: true })
        })

      return CoreMemory.of({
        text,
        invalidate,
        recall,
        condenseIfDue,
        condense,
        isCondensing: Effect.map(FiberHandle.get(running), Option.isSome),
        cancel: (botId) => Effect.suspend(() => (runningFor === botId ? FiberHandle.clear(running) : Effect.void))
      })
    })
  )
}
