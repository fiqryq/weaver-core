import { Cause, Context, Effect, FiberMap, Layer, Option, Predicate, Schema } from "effect"
import { AiError, LanguageModel, type Prompt, Tool } from "effect/ai"
import { AppConfig } from "../../../config/Config.ts"
import { truncate } from "../../../platform/lib/util.ts"
import { type AgentTool, runTool } from "../../../tools/AgentTool.ts"
import { corePermalink, coreTitle } from "../../../tools/builtin/Memory.ts"
import type { Bot } from "../../bots/Bot.ts"
import type { LearnedPart } from "../../conversations/Conversation.ts"
import { ConversationRepo } from "../../conversations/ConversationRepo.ts"
import { ProviderRegistry } from "../../providers/ProviderRegistry.ts"
import { describeTools, makeReplyPrompt, toolOutputLimit } from "../../runs/AgentRunner.ts"
import { historyTurns, merged, toolTranscript } from "../../runs/PromptBuilder.ts"
import { RunEvents } from "../../runs/RunEvents.ts"
import { Toolbox } from "../../runs/Toolbox.ts"
import { LibraryStore } from "../library/LibraryStore.ts"
import { CoreMemory } from "../memory/CoreMemory.ts"
import { SkillStore } from "../skills/SkillStore.ts"
import { reviewPrompt, type ReviewKind } from "./reviewPrompts.ts"

export type { ReviewKind }

export const skillManageTool = "skill_manage"
/** Memory tools that change notes; calling one resets the memory review counter. */
export const memoryWriteTools: ReadonlySet<string> = new Set(["write_note", "edit_note"])

/** Model calls one review may make. */
export const reviewMaxIterations = 16

const skillReviewTools = ["skills_list", "skill_view", skillManageTool, "read_file", "list_files"]
const memoryReviewTools = ["search_notes", "read_note", "write_note", "edit_note"]
const skillWriteActions: ReadonlySet<string> = new Set(["patch", "edit", "write_file"])

const isUnusableCall = (error: unknown): boolean =>
  AiError.isAiError(error) &&
  (error.reason._tag === "ToolParameterValidationError" || error.reason._tag === "ToolNotFoundError")

const unusableCallNudge =
  "Your last tool call couldn't be used: the arguments weren't a valid JSON object, or the tool doesn't exist. " +
  "Call one of the listed tools again with a JSON object."

export interface AfterReply {
  readonly bot: Bot
  readonly conversationId: string
  readonly messageId: string
  /** Model rounds in the reply that called tools. */
  readonly toolSteps: number
  /** The bot changed its skills itself during the reply. */
  readonly usedSkillManage: boolean
  /** The bot wrote to memory itself during the reply. */
  readonly usedMemoryWrite: boolean
}

export interface ReviewRequest {
  readonly bot: Bot
  readonly conversationId: string
  /** The reply under review; the conversation up to it is replayed and what's learned is attached to it. */
  readonly messageId: string
  readonly kinds: ReadonlySet<ReviewKind>
}

export class ReviewFailed extends Schema.TaggedError<ReviewFailed>()("ReviewFailed", {
  message: Schema.String
}) {}

/**
 * Background self-improvement: every so many replies (memory) or tool-calling steps (skills) the bot
 * re-reads the conversation and saves what's worth keeping, without holding up the person.
 */
export class SelfReview extends Context.Service<SelfReview, {
  /** Counts a finished reply and starts a background review when one is due. Never fails or waits on the review. */
  afterReply(input: AfterReply): Effect.Effect<void>
  /** Runs a review now and returns what it learned, which is also attached to the reviewed message. */
  review(input: ReviewRequest): Effect.Effect<ReadonlyArray<string>, ReviewFailed>
  isReviewing(botId: string): Effect.Effect<boolean>
  /** Stops the bot's review (and a Core Memory condense it started) and forgets its counters, when the bot is deleted. */
  cancel(botId: string): Effect.Effect<void>
}>()("weaver/SelfReview") {
  static readonly layer = Layer.effect(
    SelfReview,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const conversations = yield* ConversationRepo
      const providers = yield* ProviderRegistry
      const toolbox = yield* Toolbox
      const skills = yield* SkillStore
      const library = yield* LibraryStore
      const events = yield* RunEvents
      const coreMemory = yield* CoreMemory
      const replyPrompt = yield* makeReplyPrompt
      const reviews = yield* FiberMap.make<string>()
      const counters = new Map<string, { turnsSinceMemory: number; itersSinceSkill: number }>()
      const cancelled = new Set<string>()

      /** The SKILL.md fingerprint of the skill the bot's tools resolve `name` to: its own, else an assigned library skill. */
      const fingerprintOf = (bot: Bot, name: string) =>
        Effect.gen(function*() {
          const own = yield* skills.fingerprint(bot.id, name)
          if (own !== undefined || !bot.librarySkills.includes(name)) return own
          return yield* library.fingerprint(name)
        }).pipe(Effect.orElseSucceed(() => undefined))

      /** Who wrote the skill the bot's tools resolve `name` to. */
      const authorOf = (bot: Bot, name: string) =>
        Effect.gen(function*() {
          const own = yield* Effect.option(skills.get(bot.id, name))
          if (Option.isSome(own)) return own.value.createdBy
          if (!bot.librarySkills.includes(name)) return undefined
          return Option.getOrUndefined(Option.map(yield* Effect.option(library.summary(name)), (skill) => skill.createdBy))
        })

      /**
       * Runs one call the model made in a review, unless a guard refuses it. `viewed` holds the
       * SKILL.md fingerprint of each skill viewed (or written) in this review.
       */
      const runCall = (
        bot: Bot,
        tool: AgentTool | undefined,
        name: string,
        params: unknown,
        viewed: Map<string, string | undefined>,
        denied: (name: string) => string
      ): Effect.Effect<{ output: string; isFailure: boolean }> =>
        Effect.gen(function*() {
          const refusal = reviewGuard(name, params, viewed)
          if (refusal !== undefined) return { output: refusal, isFailure: true }
          if (tool === undefined) return { output: denied(name), isFailure: true }
          const args = argsOf(params)
          const skill = stringArg(args, "name")
          const action = name === skillManageTool ? stringArg(args, "action") : undefined

          if (skill !== undefined && action !== undefined && skillWriteActions.has(action)) {
            if ((yield* fingerprintOf(bot, skill)) !== viewed.get(skill)) {
              viewed.delete(skill)
              return {
                output: `SKILL.md of "${skill}" changed after you viewed it in this review. Call skill_view(name="${skill}") ` +
                  `again and base your change on what it returns now.`,
                isFailure: true
              }
            }
            if (rewritesSkillMd(action, args)) {
              const author = yield* authorOf(bot, skill)
              if (author !== undefined && author !== "agent") {
                return {
                  output: `"${skill}" was written by the user, so a background review can't rewrite it with ${action}. ` +
                    `Use patch with old_string/new_string for a targeted change instead.`,
                  isFailure: true
                }
              }
            }
          }

          const readsSkillMd = name === "skill_view" && skill !== undefined && stringArg(args, "file_path") === undefined
          const before = readsSkillMd ? yield* fingerprintOf(bot, skill) : undefined
          const sent = name === "write_note" ? { ...args, overwrite: false } : params
          const result = yield* Effect.result(runTool(tool, sent))
          if (result._tag === "Failure") return { output: result.failure.message, isFailure: true }
          if (readsSkillMd) viewed.set(skill, before)
          else if (skill !== undefined && action !== undefined && changesSkillMd(action, args)) {
            viewed.set(skill, yield* fingerprintOf(bot, skill))
          }
          return { output: result.success, isFailure: false }
        })

      const review = Effect.fn("SelfReview.review")(function*(input: ReviewRequest) {
        const { bot } = input
        const fail = (message: string) => Effect.fail(new ReviewFailed({ message }))

        const endpoint = yield* providers.endpoint(bot.providerId, bot.model).pipe(
          Effect.catch((error) => fail(error.message))
        )
        const conversation = yield* conversations.get(input.conversationId).pipe(
          Effect.catch(() => fail("The conversation no longer exists."))
        )
        const messages = yield* conversations.messages(input.conversationId)
        const index = messages.findIndex((message) => message.id === input.messageId)
        if (index === -1) return yield* fail("The reviewed message no longer exists.")

        const botTools = yield* toolbox.forBot(bot, { conversationId: input.conversationId })
        const available = new Set(botTools.tools.map((tool) => tool.name))
        const kinds = new Set([...input.kinds].filter((kind) =>
          kind === "skills"
            ? available.has(skillManageTool)
            : [...memoryWriteTools].some((name) => available.has(name))
        ))
        if (kinds.size === 0) return []

        // Every tool is described, like in the reply (models fail on calls to undescribed tools, and the
        // shared prefix keeps the provider's prompt cache warm); only the allowed ones run.
        const allowed = new Set([
          ...(kinds.has("skills") ? skillReviewTools : []),
          ...(kinds.has("memory") ? memoryReviewTools : [])
        ])
        const byName = new Map(botTools.tools.filter((tool) => allowed.has(tool.name)).map((tool) => [tool.name, tool]))
        const denied = deniedMessage(kinds)

        const system = yield* replyPrompt(bot, conversation, botTools)
        const transcript = toolTranscript(messages[index]!.parts)
        const ask = reviewPrompt(kinds, bot.name)
        const prompt: Array<Prompt.MessageEncoded> = [
          { role: "system", content: system },
          ...merged([
            ...historyTurns(messages.slice(0, index + 1), bot),
            { role: "user", content: transcript === undefined ? ask : `${transcript}\n\n${ask}` }
          ])
        ]
        const model = providers.languageModel(endpoint)
        const viewed = new Map<string, string | undefined>()
        const learned: Array<string> = []

        for (let step = 0; step < reviewMaxIterations; step++) {
          const generated = LanguageModel.generateText({
            prompt,
            toolkit: describeTools(botTools.tools),
            disableToolCallResolution: true
          }) as Effect.Effect<
            LanguageModel.GenerateTextResponse<Record<string, Tool.Any>, "encoded">,
            AiError.AiError,
            LanguageModel.LanguageModel
          >
          const response = yield* generated.pipe(
            Effect.provide(model),
            Effect.map(Option.some),
            Effect.catch((error) =>
              isUnusableCall(error) ? Effect.succeedNone : fail(`The model failed: ${error.message}`)
            )
          )
          if (Option.isNone(response)) {
            prompt.push({ role: "user", content: unusableCallNudge })
            continue
          }
          const calls = response.value.toolCalls
          if (calls.length === 0) break

          const text = response.value.text
          prompt.push({
            role: "assistant",
            content: [
              ...(text.trim().length > 0 ? [{ type: "text" as const, text }] : []),
              ...calls.map((call) => ({ type: "tool-call" as const, id: call.id, name: call.name, params: call.params }))
            ]
          })
          const results: Array<Prompt.ToolResultPartEncoded> = []
          for (const call of calls) {
            const { output, isFailure } = yield* runCall(bot, byName.get(call.name), call.name, call.params, viewed, denied)
            if (!isFailure) {
              const text = learnedText(call.name, call.params)
              if (text !== undefined && !learned.includes(text)) learned.push(text)
            }
            results.push({ type: "tool-result", id: call.id, name: call.name, isFailure, result: truncate(output, toolOutputLimit) })
          }
          prompt.push({ role: "tool", content: results })
        }

        if (learned.length > 0) {
          const current = yield* conversations.getMessage(input.messageId)
          if (current !== undefined) {
            const parts = learned.map((text): LearnedPart => ({ type: "learned", text }))
            const updated = yield* conversations.updateMessage(input.messageId, { parts: [...current.parts, ...parts] })
            if (updated !== undefined) {
              yield* events.publish({ type: "message-done", conversationId: input.conversationId, message: updated })
            }
          }
        }
        return learned
      })

      const background = (input: ReviewRequest) =>
        review(input).pipe(
          Effect.tap((learned) =>
            learned.length > 0 ? Effect.logInfo(`${input.bot.name} learned: ${learned.join("; ")}`) : Effect.void
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning(`Background review for ${input.bot.name} failed`, cause)
          )
        )

      const afterReply = (input: AfterReply) =>
        Effect.gen(function*() {
          const { bot } = input
          if (cancelled.has(bot.id)) return
          yield* coreMemory.condenseIfDue(bot)
          const counter = counters.get(bot.id) ?? { turnsSinceMemory: 0, itersSinceSkill: 0 }
          counters.set(bot.id, counter)
          const kinds = new Set<ReviewKind>()

          if (config.reviewSkillInterval > 0 && hasBuiltin(bot, "skills")) {
            counter.itersSinceSkill = input.usedSkillManage ? 0 : counter.itersSinceSkill + input.toolSteps
            if (counter.itersSinceSkill >= config.reviewSkillInterval) kinds.add("skills")
          }
          if (config.reviewMemoryInterval > 0 && hasBuiltin(bot, "memory") && Option.isSome(config.memory)) {
            counter.turnsSinceMemory = input.usedMemoryWrite ? 0 : counter.turnsSinceMemory + 1
            if (counter.turnsSinceMemory >= config.reviewMemoryInterval) kinds.add("memory")
          }

          if (kinds.size === 0) return
          // A due review stays due until one actually starts.
          if (yield* FiberMap.has(reviews, bot.id)) {
            return yield* Effect.logDebug(`Postponed a review for ${bot.name}: one is already running`)
          }
          if (kinds.has("skills")) counter.itersSinceSkill = 0
          if (kinds.has("memory")) counter.turnsSinceMemory = 0
          yield* FiberMap.run(
            reviews,
            bot.id,
            background({ bot, conversationId: input.conversationId, messageId: input.messageId, kinds }),
            { onlyIfMissing: true }
          )
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Couldn't start a background review", cause))
        )

      return SelfReview.of({
        afterReply,
        review,
        isReviewing: (botId) => FiberMap.has(reviews, botId),
        cancel: (botId) =>
          Effect.suspend(() => {
            cancelled.add(botId)
            counters.delete(botId)
            return Effect.andThen(FiberMap.remove(reviews, botId), coreMemory.cancel(botId))
          })
      })
    })
  )
}

const hasBuiltin = (bot: Bot, tool: string): boolean => (bot.tools as ReadonlyArray<string>).includes(tool)

const argsOf = (params: unknown): Record<string, unknown> =>
  Predicate.isObject(params) ? params as Record<string, unknown> : {}

const stringArg = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key]
  return Predicate.isString(value) && value.trim().length > 0 ? value.trim() : undefined
}

const deniedMessage = (kinds: ReadonlySet<ReviewKind>) => (name: string): string => {
  const allowed = [
    ...(kinds.has("skills")
      ? [`skills_list/skill_view/read_file/list_files to read, skill_manage (create, patch, edit, write_file) to change skills`]
      : []),
    ...(kinds.has("memory") ? [`search_notes/read_note to check memory and write_note/edit_note (append) to save to it`] : [])
  ]
  return `Background review denied non-allowlisted tool: ${name}. Allowed here: ${allowed.join(", ")}. Do not retry ${name}.`
}

const isAbsent = (value: unknown): boolean => value === undefined || value === null

/** A full SKILL.md rewrite: edit, or patch given only `content` (the skill tool treats that as edit). */
const rewritesSkillMd = (action: string, args: Record<string, unknown>): boolean =>
  action === "edit" ||
  (action === "patch" && isAbsent(args.old_string) && isAbsent(args.new_string) && !isAbsent(args.content))

const changesSkillMd = (action: string, args: Record<string, unknown>): boolean =>
  action === "create" || rewritesSkillMd(action, args) ||
  (action === "patch" && (isAbsent(args.file_path) || args.file_path === "SKILL.md"))

/**
 * Why a review may not make this call, or undefined when it may. Reviews run unattended, so they
 * can't delete or overwrite anything, can only change a skill they've just read, and only append to shared notes.
 */
export const reviewGuard = (name: string, params: unknown, viewed: Pick<ReadonlySet<string>, "has">): string | undefined => {
  const args = argsOf(params)
  if (name === "delete_note" || name === "move_note") {
    return `A background review can't ${name === "delete_note" ? "delete" : "move"} notes. Do not retry ${name}.`
  }
  if (name === "write_note" && !isAbsent(args.overwrite) && args.overwrite !== false) {
    return `In a background review write_note can't overwrite: shared notes can't be replaced unattended. Leave out ` +
      `overwrite, and add to an existing note with edit_note (operation "append") instead.`
  }
  if (name === skillManageTool) {
    const action = stringArg(args, "action")
    const skill = stringArg(args, "name")
    if (action === "delete" || action === "remove_file") {
      return `A background review can't delete skills or skill files. Never delete here; if two skills overlap, ` +
        `mention it in your reply instead.`
    }
    if (action !== undefined && skillWriteActions.has(action) && (skill === undefined || !viewed.has(skill))) {
      return `Read-before-write: call skill_view(name="${skill ?? "<skill>"}") during this review before you ${action} ` +
        `it, and base the change on what it returns. Retry the write once after viewing; do not loop.`
    }
  }
  if (name === "edit_note" && stringArg(args, "operation") !== "append") {
    return `In a background review edit_note only supports operation "append": shared notes can't be replaced or ` +
      `rewritten unattended. Append the new fact instead, or say 'Nothing to save.'`
  }
  return undefined
}

const isCoreMemory = (identifier: string): boolean => {
  const normalized = identifier.trim().toLowerCase().replace(/\.md$/, "")
  return normalized === corePermalink || normalized === "core-memory" || normalized === coreTitle.toLowerCase() ||
    normalized.endsWith("/core-memory")
}

/** What a successful review call saved, as shown on the reviewed message; undefined for reads. */
export const learnedText = (name: string, params: unknown): string | undefined => {
  const args = argsOf(params)
  if (name === skillManageTool) {
    const action = stringArg(args, "action")
    const skill = stringArg(args, "name") ?? "a skill"
    if (action === "create") return `Created skill "${skill}"`
    if (action !== undefined && skillWriteActions.has(action)) return `Updated skill "${skill}"`
    return undefined
  }
  if (name === "write_note") {
    const title = stringArg(args, "title")
    return title === undefined ? "Saved to memory" : `Saved to memory: ${title}`
  }
  if (name === "edit_note") {
    const identifier = stringArg(args, "identifier") ?? ""
    if (isCoreMemory(identifier)) return `Added to ${coreTitle}`
    return identifier.length > 0 ? `Updated memory: ${identifier}` : "Updated memory"
  }
  return undefined
}
