import { Cause, Effect, FiberMap, Layer, Option, Semaphore, Stream } from "effect"
import { AiError, LanguageModel, type Prompt, type Response } from "effect/ai"
import { newId } from "../../platform/lib/util.ts"
import { truncate } from "../../platform/lib/util.ts"
import { runTool } from "../../tools/AgentTool.ts"
import type { Bot } from "../bots/Bot.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import type { Conversation, Message, MessagePart, ToolCallPart, ToolResultPart } from "../conversations/Conversation.ts"
import { ConversationRepo } from "../conversations/ConversationRepo.ts"
import { memoryWriteTools, SelfReview, skillManageTool } from "../learning/review/SelfReview.ts"
import { ProviderRegistry } from "../providers/ProviderRegistry.ts"
import { AgentRunner, describeTools, makeReplyPrompt, toolOutputLimit } from "./AgentRunner.ts"
import { Approvals } from "./Approvals.ts"
import { historyTurns } from "./PromptBuilder.ts"
import { RunEvents } from "./RunEvents.ts"
import { Toolbox } from "./Toolbox.ts"

export { toolOutputLimit }

/** The model or provider doesn't accept tool definitions; the reply is retried without them. */
const rejectsTools = (error: unknown): boolean =>
  AiError.isAiError(error) && error.reason._tag === "InvalidRequestError"

export const describeError = (error: unknown): string => {
  if (AiError.isAiError(error)) return error.reason.message
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message)
  return String(error)
}

export const AgentRunnerLive = Layer.effect(
  AgentRunner,
  Effect.gen(function*() {
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
    const runs = new Map<string, string>()

    const setActivity = (conversationId: string, text: string) =>
      events.publish({ type: "activity", conversationId, text })

    const reply = Effect.fn("AgentRunner.reply")(function*(bot: Bot, conversation: Conversation) {
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

      const save = (patch: { status?: Message["status"]; error?: string | null } = {}) =>
        Effect.gen(function*() {
          const updated = yield* conversations.updateMessage(message.id, {
            parts: [...parts],
            promptTokens,
            completionTokens,
            ...patch
          })
          if (updated !== undefined) message = updated
          return message
        })

      const finish = (status: Message["status"], error: string | null = null) =>
        Effect.gen(function*() {
          const done = yield* save({ status, error })
          yield* setActivity(conversationId, "")
          yield* events.publish({ type: "message-done", conversationId, message: done })
          if (error !== null) yield* events.publish({ type: "error", conversationId, message: error })
        })

      const work = Effect.gen(function*() {
        if (endpoint._tag === "Failure") return yield* finish("error", endpoint.failure.message)

        yield* setActivity(conversationId, "Getting ready")
        const botTools = yield* toolbox.forBot(bot, { conversationId })
        const history = yield* conversations.messages(conversationId)
        const system = yield* replyPrompt(bot, conversation, botTools)
        yield* setActivity(conversationId, "")

        const prompt: Array<Prompt.MessageEncoded> = [
          { role: "system", content: system },
          ...historyTurns(history.filter((m) => m.id !== message.id), bot)
        ]
        let tools = [...botTools.tools]
        const byName = new Map(tools.map((tool) => [tool.name, tool]))
        const model = providers.languageModel(endpoint.success)

        for (let step = 0; step <= bot.maxSteps; step++) {
          // The last round offers no tools, so a model stuck calling them still has to answer.
          const offered = step < bot.maxSteps ? tools : []
          let textIndex = -1
          const calls: Array<{ id: string; name: string; params: unknown }> = []

          const stream: Stream.Stream<Response.AnyPart, AiError.AiError, LanguageModel.LanguageModel> =
            offered.length > 0
              ? LanguageModel.streamText({
                prompt,
                toolkit: describeTools(offered),
                disableToolCallResolution: true
              }) as Stream.Stream<Response.AnyPart, AiError.AiError, LanguageModel.LanguageModel>
              : LanguageModel.streamText({ prompt })

          const round = stream.pipe(
            Stream.runForEach((part) =>
              Effect.gen(function*() {
                switch (part.type) {
                  case "text-delta": {
                    if (part.delta.length === 0) return
                    if (textIndex === -1) {
                      parts.push({ type: "text", text: "" })
                      textIndex = parts.length - 1
                    }
                    const current = parts[textIndex] as { type: "text"; text: string }
                    parts[textIndex] = { type: "text", text: current.text + part.delta }
                    yield* events.publish({ type: "text-delta", conversationId, messageId: message.id, delta: part.delta })
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
            Effect.provide(model)
          )

          const outcome = yield* Effect.result(round)
          if (outcome._tag === "Failure") {
            if (step === 0 && offered.length > 0 && rejectsTools(outcome.failure) && parts.length === 0) {
              tools = []
              continue
            }
            return yield* Effect.fail(outcome.failure)
          }

          if (calls.length === 0) break
          toolSteps++
          yield* save()

          prompt.push({
            role: "assistant",
            content: calls.map((call) => ({ type: "tool-call", id: call.id, name: call.name, params: call.params }))
          })
          const results: Array<Prompt.ToolResultPartEncoded> = []

          for (const call of calls) {
            const tool = byName.get(call.name)
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
                Effect.andThen(
                  events.publish({
                    type: "approval-requested",
                    conversationId,
                    messageId: message.id,
                    approvalId,
                    part: callPart
                  }),
                  setActivity(conversationId, "Waiting for your approval")
                )
              )
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
            if (tool === undefined) {
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

            const resultPart: ToolResultPart = { type: "tool-result", id: call.id, name: call.name, output, isFailure }
            parts.push(resultPart)
            yield* save()
            yield* events.publish({ type: "tool-result", conversationId, messageId: message.id, part: resultPart })
            results.push({ type: "tool-result", id: call.id, name: call.name, isFailure, result: output })
          }
          prompt.push({ role: "tool", content: results })
        }

        const hasText = parts.some((part) => part.type === "text" && part.text.trim().length > 0)
        if (!hasText) parts.push({ type: "text", text: "(No reply)" })
        yield* finish("done")
        if (Option.isSome(selfReview)) {
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
    })

    const runConversation = (runId: string, conversationId: string) =>
      Effect.gen(function*() {
        yield* events.publish({ type: "run-started", runId, conversationId })
        const conversation = yield* Effect.orDie(conversations.get(conversationId))
        for (const botId of conversation.botIds) {
          const bot = yield* Effect.option(bots.get(botId))
          if (bot._tag === "Some") yield* reply(bot.value, conversation)
        }
        yield* events.publish({ type: "run-finished", runId, conversationId, status: "done" })
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
          runs.set(runId, conversationId)
          yield* FiberMap.run(fibers, conversationId, runConversation(runId, conversationId))
        })
      )
      return runId
    })

    const cancelConversation = (conversationId: string) => FiberMap.remove(fibers, conversationId)

    return AgentRunner.of({
      start,
      cancelConversation,
      cancelRun: (runId) =>
        Effect.suspend(() => {
          const conversationId = runs.get(runId)
          return conversationId === undefined ? Effect.void : cancelConversation(conversationId)
        }),
      isRunning: (conversationId) => FiberMap.has(fibers, conversationId)
    })
  })
)
