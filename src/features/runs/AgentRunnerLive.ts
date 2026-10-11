import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FiberSet,
  Layer,
  Option,
  Predicate,
  Semaphore,
  Stream
} from "effect"
import { AiError, LanguageModel, type Prompt, type Response, Tool } from "effect/ai"
import { AppConfig } from "../../config/Config.ts"
import { newId } from "../../platform/lib/util.ts"
import { truncate } from "../../platform/lib/util.ts"
import { type AgentTool, runTool, ToolFailure } from "../../tools/AgentTool.ts"
import { askBotTool, handoffNote, handoffTitle, requestText } from "../../tools/builtin/AskBot.ts"
import { botMemoryProject, memoryServerConfig, noteWriteError, pinProject } from "../../tools/builtin/Memory.ts"
import type { Bot } from "../bots/Bot.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import {
  type Conversation,
  type Message,
  type MessagePart,
  messageText,
  type ToolCallPart,
  type ToolResultPart
} from "../conversations/Conversation.ts"
import { ConversationRepo } from "../conversations/ConversationRepo.ts"
import { McpHub } from "../integrations/McpHub.ts"
import { recallQuery } from "../learning/memory/recall.ts"
import { memoryWriteTools, SelfReview, skillManageTool } from "../learning/review/SelfReview.ts"
import { describeModelError, isTransient, rejectsTools } from "../providers/modelErrors.ts"
import { ProviderRegistry } from "../providers/ProviderRegistry.ts"
import {
  AgentRunner,
  describeTools,
  makeReplyPrompt,
  type ReplyExtension,
  type ReplyOptions,
  toolOutputLimit
} from "./AgentRunner.ts"
import { Approvals } from "./Approvals.ts"
import { historyTurns, merged } from "./PromptBuilder.ts"
import { RunEvents } from "./RunEvents.ts"
import { Toolbox } from "./Toolbox.ts"

export { toolOutputLimit }

/** Waits before resending a round that failed with a transient error, before anything streamed. */
const retryDelays: ReadonlyArray<Duration.Duration> = [Duration.seconds(1), Duration.seconds(4)]
/** Longer `Retry-After` waits than this fail the reply instead. */
const longestRetryAfter = Duration.seconds(20)

export const describeError = (error: unknown): string => {
  if (AiError.isAiError(error)) return describeModelError(error)
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message)
  return String(error)
}

interface ModelCall {
  readonly id: string
  readonly name: string
  readonly params: unknown
  /** Why the arguments couldn't be used; the call then fails without running. */
  readonly invalid?: string
}

/** The client couldn't turn a streamed call into a tool call: arguments that aren't JSON, or an unknown tool. */
const isUnusableCall = (error: unknown): boolean =>
  AiError.isAiError(error) &&
  (error.reason._tag === "ToolParameterValidationError" || error.reason._tag === "ToolNotFoundError")

/** Small models send arguments that aren't a JSON object; that becomes a failed call the model can retry. */
const parseArguments = (id: string, name: string, text: string): ModelCall => {
  let params: unknown
  try {
    params = Tool.unsafeSecureJsonParse(text.trim().length > 0 ? text : "{}")
  } catch (cause) {
    return {
      id,
      name,
      params: {},
      invalid: `The arguments weren't valid JSON (${cause instanceof Error ? cause.message : String(cause)}): ` +
        `${truncate(text, 500)}\nCall ${name} again with a JSON object.`
    }
  }
  return Predicate.isObject(params) && !Array.isArray(params)
    ? { id, name, params }
    : { id, name, params: {}, invalid: `The arguments must be a JSON object, not ${truncate(text, 200)}. Call ${name} again.` }
}

interface Ask {
  readonly requester: Bot
  readonly target: Bot
  readonly request: string
  readonly context: string | undefined
  /** The conversation the requester is replying in. */
  readonly conversationId: string
  /** Told the handoff conversation as soon as it's known, so the result can link to it. */
  readonly onConversation: (id: string) => void
}

export const AgentRunnerLive = Layer.effect(
  AgentRunner,
  Effect.gen(function*() {
    const config = yield* AppConfig
    const hub = yield* McpHub
    const conversations = yield* ConversationRepo
    const bots = yield* BotRepo
    const providers = yield* ProviderRegistry
    const toolbox = yield* Toolbox
    const replyPrompt = yield* makeReplyPrompt
    const events = yield* RunEvents
    const approvals = yield* Approvals
    // Optional so the runner works in layer graphs that don't include background reviews.
    const selfReview = yield* Effect.serviceOption(SelfReview)
    const fibers = yield* FiberMap.make<string>()
    /** Child runs, by run id. */
    const children = yield* FiberMap.make<string>()
    const notes = yield* FiberSet.make<void, never>()
    const runs = new Map<string, { readonly conversationId: string; readonly botIds: ReadonlySet<string>; readonly child: boolean }>()
    let extension: ReplyExtension = () => Effect.succeed(undefined)

    const setActivity = (conversationId: string, text: string) =>
      events.publish({ type: "activity", conversationId, text })

    const teammatesOf = (bot: Bot) =>
      Effect.map(
        Effect.forEach(bot.teammateIds.filter((id) => id !== bot.id), (id) => Effect.option(bots.get(id))),
        (found) => found.flatMap(Option.toArray)
      )

    const reply = Effect.fn("AgentRunner.reply")(function*(bot: Bot, conversation: Conversation, options: ReplyOptions = {}) {
      const conversationId = conversation.id
      const endpoint = yield* Effect.result(providers.endpoint(bot.providerId, bot.model))

      let message = yield* conversations.insertMessage({
        conversationId,
        role: "assistant",
        botId: bot.id,
        senderName: bot.name,
        status: "streaming",
        providerId: endpoint._tag === "Success" ? endpoint.success.providerId : null,
        model: endpoint._tag === "Success" ? endpoint.success.model : null
      })
      yield* events.publish({ type: "message-created", conversationId, message })

      const parts: Array<MessagePart> = []
      let toolSteps = 0
      let usedSkillManage = false
      let usedMemoryWrite = false
      let promptTokens = 0
      let completionTokens = 0
      // Cleared or deleted while replying: nothing more is written or announced for it.
      let deleted = false
      // Set by ask_bot during a call, for its result part.
      let handoffConversationId: string | undefined
      let endedEarly = false

      const save = (patch: { status?: Message["status"]; error?: string | null } = {}) =>
        Effect.gen(function*() {
          if (deleted) return
          const updated = yield* conversations.updateMessage(message.id, {
            parts: [...parts],
            promptTokens,
            completionTokens,
            ...patch
          })
          if (updated === undefined) deleted = true
          else message = updated
        })

      const finish = (status: Message["status"], error: string | null = null) =>
        Effect.gen(function*() {
          yield* save({ status, error })
          yield* setActivity(conversationId, "")
          if (deleted) return
          yield* events.publish({ type: "message-done", conversationId, message })
          if (error !== null) yield* events.publish({ type: "error", conversationId, message: error })
        })

      const work = Effect.gen(function*() {
        if (endpoint._tag === "Failure") return yield* finish("error", endpoint.failure.message)

        yield* setActivity(conversationId, "Getting ready")
        const history = yield* conversations.messages(conversationId)
        const asked = history.findLast((m) => m.role === "user")
        const fromToolbox = yield* toolbox.forBot(bot, {
          conversationId,
          recallQuery: asked === undefined ? undefined : recallQuery(messageText(asked.parts))
        })
        // One hop: a teammate answering a handoff can't hand off again.
        const teammates = conversation.kind === "handoff" ? [] : yield* teammatesOf(bot)
        const extra = options.tools ?? []
        const askBot = teammates.length === 0 ? [] : [
          askBotTool({
            teammates,
            ask: (target, request, context) =>
              askTeammate({
                requester: bot,
                target,
                request,
                context,
                conversationId,
                onConversation: (id) => {
                  handoffConversationId = id
                }
              })
          })
        ]
        const botTools = askBot.length === 0 && extra.length === 0 ? fromToolbox : {
          ...fromToolbox,
          tools: [...fromToolbox.tools.filter((tool) => !extra.some((added) => added.name === tool.name)), ...extra, ...askBot]
        }
        const basePrompt = yield* replyPrompt(bot, conversation, botTools)
        const system = options.instructions === undefined ? basePrompt : `${basePrompt}\n\n${options.instructions}`
        yield* setActivity(conversationId, "")

        const turns = historyTurns(history.filter((m) => m.id !== message.id), bot)
        const prompt: Array<Prompt.MessageEncoded> = [
          { role: "system", content: system },
          ...(options.nudge === undefined ? turns : merged([...turns, { role: "user", content: options.nudge }]))
        ]
        let tools = [...botTools.tools]
        const byName = new Map(tools.map((tool) => [tool.name, tool]))
        const model = providers.languageModel(endpoint.success)

        /** One model call: streams text into the reply and collects the tool calls it asks for. */
        const streamRound = (offered: ReadonlyArray<AgentTool>) =>
          Effect.gen(function*() {
            let text = ""
            let textIndex = -1
            let calls: Array<ModelCall> = []
            // Calls as streamed, so ones the client can't parse are still answered.
            const streamed = new Map<string, { name: string; args: string }>()

            const stream: Stream.Stream<Response.AnyPart, AiError.AiError, LanguageModel.LanguageModel> =
              offered.length > 0
                ? LanguageModel.streamText({
                  prompt,
                  toolkit: describeTools(offered),
                  disableToolCallResolution: true
                }) as Stream.Stream<Response.AnyPart, AiError.AiError, LanguageModel.LanguageModel>
                : LanguageModel.streamText({ prompt })

            const outcome = yield* stream.pipe(
              Stream.runForEach((part) =>
                Effect.gen(function*() {
                  switch (part.type) {
                    case "text-delta": {
                      if (part.delta.length === 0) return
                      if (textIndex === -1) {
                        parts.push({ type: "text", text: "" })
                        textIndex = parts.length - 1
                      }
                      text += part.delta
                      parts[textIndex] = { type: "text", text }
                      yield* events.publish({ type: "text-delta", conversationId, messageId: message.id, delta: part.delta })
                      return
                    }
                    case "tool-params-start": {
                      streamed.set(part.id, { name: part.name, args: "" })
                      return
                    }
                    case "tool-params-delta": {
                      const call = streamed.get(part.id)
                      if (call !== undefined) call.args += part.delta
                      return
                    }
                    case "tool-call": {
                      calls.push({ id: part.id, name: part.name, params: part.params })
                      return
                    }
                    case "finish": {
                      promptTokens += part.usage.inputTokens.total ?? 0
                      completionTokens += part.usage.outputTokens.total ?? 0
                      return
                    }
                    case "error": {
                      return yield* Effect.fail(part.error)
                    }
                  }
                })
              ),
              Effect.provide(model),
              Effect.result
            )
            if (outcome._tag === "Failure") {
              if (!isUnusableCall(outcome.failure) || streamed.size === 0) {
                return { _tag: "Failed" as const, error: outcome.failure, partial: text.length > 0 || streamed.size > 0 }
              }
              calls = [...streamed].map(([id, call]) => parseArguments(id, call.name, call.args))
            }
            return { _tag: "Done" as const, text, calls }
          })

        for (let step = 0; step <= bot.maxSteps; step++) {
          // The last round offers no tools, so a model stuck calling them still has to answer.
          const offered = step < bot.maxSteps ? tools : []

          let round = yield* streamRound(offered)
          for (let attempt = 0; round._tag === "Failed" && !round.partial && isTransient(round.error); attempt++) {
            const retryAfter = AiError.isAiError(round.error) ? round.error.retryAfter : undefined
            const delay = retryAfter ?? retryDelays[attempt]
            if (attempt >= retryDelays.length || delay === undefined || Duration.isGreaterThan(delay, longestRetryAfter)) break
            yield* setActivity(conversationId, "The model is busy, trying again")
            yield* Effect.sleep(delay)
            yield* setActivity(conversationId, "")
            round = yield* streamRound(offered)
          }
          if (round._tag === "Failed") {
            if (step === 0 && offered.length > 0 && !round.partial && rejectsTools(round.error)) {
              tools = []
              continue
            }
            return yield* Effect.fail(round.error)
          }

          // Calls in a round without tools can't be answered; the text is the reply.
          const calls = offered.length > 0 ? round.calls : []
          if (calls.length === 0) break
          toolSteps++
          yield* save()

          prompt.push({
            role: "assistant",
            content: [
              ...(round.text.length > 0 ? [{ type: "text" as const, text: round.text }] : []),
              ...calls.map((call) => ({ type: "tool-call" as const, id: call.id, name: call.name, params: call.params }))
            ]
          })
          const results: Array<Prompt.ToolResultPartEncoded> = []

          for (const call of calls) {
            const tool = call.invalid === undefined ? byName.get(call.name) : undefined
            const needsApproval = tool?.needsApproval === true
            const approvalId = needsApproval ? newId() : undefined
            const callPart: ToolCallPart = {
              type: "tool-call",
              id: call.id,
              name: call.name,
              title: tool?.title(call.params) ?? call.name,
              params: call.params,
              ...(approvalId !== undefined ? { approval: "pending" as const, approvalId } : {})
            }
            parts.push(callPart)
            const callIndex = parts.length - 1
            yield* save()
            yield* events.publish({ type: "tool-call", conversationId, messageId: message.id, part: callPart })

            let approved = true
            if (approvalId !== undefined) {
              approved = yield* approvals.wait(
                approvalId,
                Effect.all([
                  events.publish({
                    type: "approval-requested",
                    conversationId,
                    messageId: message.id,
                    approvalId,
                    part: callPart
                  }),
                  setActivity(conversationId, "Waiting for your approval"),
                  options.onApproval?.(true) ?? Effect.void
                ], { discard: true })
              )
              if (options.onApproval !== undefined) yield* options.onApproval(false)
              parts[callIndex] = { ...callPart, approval: approved ? "approved" : "denied" }
              yield* save()
              yield* events.publish({
                type: "approval-resolved",
                conversationId,
                messageId: message.id,
                approvalId,
                approved
              })
            }

            let output: string
            let isFailure: boolean
            handoffConversationId = undefined
            if (call.invalid !== undefined) {
              output = call.invalid
              isFailure = true
            } else if (tool === undefined) {
              output = `There is no tool called ${call.name}.`
              isFailure = true
            } else if (!approved) {
              output = "The user denied this action. Don't retry it; ask what they'd like instead."
              isFailure = true
            } else {
              yield* setActivity(conversationId, tool.activity)
              const result = yield* Effect.result(runTool(tool, call.params))
              yield* setActivity(conversationId, "")
              output = result._tag === "Success" ? result.success : result.failure.message
              isFailure = result._tag === "Failure"
              if (!isFailure && call.name === skillManageTool) usedSkillManage = true
              if (!isFailure && memoryWriteTools.has(call.name)) usedMemoryWrite = true
            }
            output = truncate(output, toolOutputLimit)

            const resultPart: ToolResultPart = {
              type: "tool-result",
              id: call.id,
              name: call.name,
              output,
              isFailure,
              ...(handoffConversationId !== undefined ? { handoffConversationId } : {})
            }
            parts.push(resultPart)
            yield* save()
            yield* events.publish({ type: "tool-result", conversationId, messageId: message.id, part: resultPart })
            results.push({ type: "tool-result", id: call.id, name: call.name, isFailure, result: output })
          }
          prompt.push({ role: "tool", content: results })
          if (options.endAfterRound?.() === true) {
            endedEarly = true
            break
          }
        }

        const hasText = parts.some((part) => part.type === "text" && part.text.trim().length > 0)
        if (!hasText && !endedEarly) parts.push({ type: "text", text: "(No reply)" })
        yield* finish("done")
        if (Option.isSome(selfReview) && !deleted) {
          yield* selfReview.value.afterReply({
            bot,
            conversationId,
            messageId: message.id,
            toolSteps,
            usedSkillManage,
            usedMemoryWrite
          })
        }
      })

      yield* work.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : finish("error", describeError(Cause.squash(cause)))
        ),
        Effect.onInterrupt(() =>
          Effect.suspend(() => {
            parts.forEach((part, index) => {
              if (part.type === "tool-call" && part.approval === "pending") parts[index] = { ...part, approval: "denied" }
            })
            return finish("cancelled")
          })
        )
      )
      return deleted ? undefined : message
    })

    /** Announces a run's start and end around `body`. */
    const tracked = <A>(runId: string, conversationId: string, body: Effect.Effect<A>) =>
      Effect.gen(function*() {
        yield* events.publish({ type: "run-started", runId, conversationId })
        const result = yield* body
        yield* events.publish({ type: "run-finished", runId, conversationId, status: "done" })
        return result
      }).pipe(
        Effect.onInterrupt(() => events.publish({ type: "run-finished", runId, conversationId, status: "cancelled" })),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.andThen(
              Effect.logError("Run failed", cause),
              events.publish({ type: "run-finished", runId, conversationId, status: "error" })
            )
        ),
        Effect.ensuring(Effect.sync(() => runs.delete(runId)))
      )

    const runConversation = (runId: string, conversationId: string) =>
      tracked(
        runId,
        conversationId,
        Effect.gen(function*() {
          const conversation = yield* Effect.orDie(conversations.get(conversationId))
          for (const botId of conversation.botIds) {
            const bot = yield* Effect.option(bots.get(botId))
            if (bot._tag === "Some") yield* reply(bot.value, conversation, (yield* extension(bot.value, conversation)) ?? {})
          }
        })
      )

    const locks = new Map<string, Semaphore.Semaphore>()
    const lockFor = (conversationId: string) => {
      let lock = locks.get(conversationId)
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1)
        locks.set(conversationId, lock)
      }
      return lock
    }

    const start = Effect.fn("AgentRunner.start")(function*(conversationId: string) {
      const runId = newId()
      // The previous run has to finish its cancellation (events and saved messages) before the new
      // one announces itself, or clients see its "run-finished" after the new "run-started".
      yield* lockFor(conversationId).withPermit(
        Effect.gen(function*() {
          yield* FiberMap.remove(fibers, conversationId)
          const conversation = yield* Effect.option(conversations.get(conversationId))
          const botIds = new Set(Option.match(conversation, { onNone: () => [], onSome: (c) => c.botIds }))
          runs.set(runId, { conversationId, botIds, child: false })
          yield* FiberMap.run(fibers, conversationId, runConversation(runId, conversationId))
        })
      )
      return runId
    })

    const childRunsIn = (conversationId: string) =>
      [...runs].flatMap(([runId, run]) => (run.child && run.conversationId === conversationId ? [runId] : []))

    const whileStopped = <A, E, R>(conversationId: string, effect: Effect.Effect<A, E, R>) =>
      lockFor(conversationId).withPermit(
        Effect.gen(function*() {
          yield* FiberMap.remove(fibers, conversationId)
          yield* Effect.forEach(childRunsIn(conversationId), (runId) => FiberMap.remove(children, runId), {
            concurrency: "unbounded",
            discard: true
          })
          return yield* effect
        })
      )

    /** See `AgentRunnerShape.delegate`. */
    const delegate = (conversation: Conversation, bot: Bot, options: ReplyOptions = {}) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const runId = newId()
          const fiber = yield* lockFor(conversation.id).withPermit(Effect.suspend(() => {
            runs.set(runId, { conversationId: conversation.id, botIds: new Set([bot.id]), child: true })
            return FiberMap.run(children, runId, tracked(runId, conversation.id, reply(bot, conversation, options)))
          }))
          const exit = yield* restore(Fiber.await(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
          return Exit.map(exit, (message) => message || undefined)
        })
      )

    const turns = new Map<string, Semaphore.Semaphore>()
    /** Held for a whole handoff, so concurrent asks between the same two bots take turns. */
    const turnFor = (requesterId: string, targetId: string) => {
      const key = `${requesterId}:${targetId}`
      let turn = turns.get(key)
      if (turn === undefined) {
        turn = Semaphore.makeUnsafe(1)
        turns.set(key, turn)
      }
      return turn
    }

    /** Saved in the memory project of the bot that asked. */
    const saveHandoffNote = (note: ReturnType<typeof handoffNote>, requester: Bot) =>
      Effect.gen(function*() {
        if (Option.isNone(config.memory)) return
        const memory = config.memory.value
        const result = yield* hub.call(
          memoryServerConfig(memory),
          "write_note",
          pinProject({ ...note, output_format: "json" }, botMemoryProject(requester, memory.project))
        )
        const error = result.isError ? result.text : noteWriteError(result.text)
        if (error !== undefined) yield* Effect.logWarning(`Couldn't save the handoff note "${note.title}": ${error}`)
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning("Couldn't save a handoff note", cause)
        )
      )

    const askTeammate = (ask: Ask): Effect.Effect<string, ToolFailure> => {
      const { requester, target } = ask
      const title = handoffTitle(requester.name, target.name)
      const fail = (message: string) => Effect.fail(new ToolFailure({ message }))
      const minutes = config.handoffTimeoutMinutes
      const waiting = setActivity(ask.conversationId, `Waiting for ${target.name}`)

      const handoff = Effect.gen(function*() {
        const conversation = yield* conversations.handoff(requester.id, target.id, title)
        ask.onConversation(conversation.id)
        yield* waiting
        const request = yield* conversations.insertMessage({
          conversationId: conversation.id,
          role: "user",
          botId: requester.id,
          senderName: requester.name,
          parts: [{ type: "text", text: requestText(ask.request, ask.context, requester.name) }]
        })
        yield* events.publish({ type: "message-created", conversationId: conversation.id, message: request })
        const exit = yield* delegate(conversation, target, {
          onApproval: (approval) =>
            approval ? setActivity(ask.conversationId, `Waiting for your approval in ${title}`) : waiting
        })
        if (Exit.isFailure(exit)) {
          return yield* fail(
            Cause.hasInterruptsOnly(exit.cause)
              ? `${target.name}'s reply was stopped before it finished.`
              : `${target.name} couldn't answer: ${describeError(Cause.squash(exit.cause))}`
          )
        }
        const answer = exit.value
        if (answer === undefined) return yield* fail(`${target.name}'s reply was deleted before it finished.`)
        if (answer.status !== "done") {
          return yield* fail(`${target.name} couldn't answer: ${answer.error ?? "the reply didn't finish"}`)
        }
        return messageText(answer.parts)
      })

      return turnFor(requester.id, target.id).withPermit(handoff).pipe(
        Effect.timeoutOrElse({
          duration: Duration.minutes(minutes),
          orElse: () => fail(`${target.name} didn't finish within ${minutes} minute${minutes === 1 ? "" : "s"}.`)
        }),
        Effect.tap((answer) =>
          Effect.gen(function*() {
            const memoryOn = [requester, target].some((bot) => (bot.tools as ReadonlyArray<string>).includes("memory"))
            if (Option.isNone(config.memory) || !memoryOn) return
            const at = new Date(yield* Clock.currentTimeMillis)
            const note = handoffNote({
              requester: requester.name,
              target: target.name,
              request: ask.request,
              context: ask.context,
              answer,
              at
            })
            yield* FiberSet.run(notes, saveHandoffNote(note, requester))
          })
        ),
        Effect.map((answer) => `${target.name} replied:\n\n${answer}`)
      )
    }

    const cancelConversation = (conversationId: string) => whileStopped(conversationId, Effect.void)

    return AgentRunner.of({
      start,
      cancelConversation,
      cancelRun: (runId) =>
        Effect.suspend(() => {
          const run = runs.get(runId)
          if (run === undefined) return Effect.void
          return run.child ? FiberMap.remove(children, runId) : cancelConversation(run.conversationId)
        }),
      cancelBot: (botId) =>
        Effect.suspend(() => {
          const own = [...runs].filter(([, run]) => run.botIds.has(botId))
          const conversationIds = new Set(own.flatMap(([, run]) => (run.child ? [] : [run.conversationId])))
          const childIds = own.flatMap(([runId, run]) => (run.child ? [runId] : []))
          return Effect.andThen(
            Effect.forEach(conversationIds, cancelConversation, { concurrency: "unbounded", discard: true }),
            Effect.forEach(childIds, (runId) => FiberMap.remove(children, runId), { concurrency: "unbounded", discard: true })
          )
        }),
      whileStopped,
      isRunning: (conversationId) =>
        Effect.map(FiberMap.has(fibers, conversationId), (running) => running || childRunsIn(conversationId).length > 0),
      delegate,
      extendReplies: (next) =>
        Effect.sync(() => {
          extension = next
        })
    })
  })
)
