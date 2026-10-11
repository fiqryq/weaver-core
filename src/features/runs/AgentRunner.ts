import { Clock, Context, Effect, type Exit, Option } from "effect"
import { Tool, type Toolkit } from "effect/ai"
import { AppConfig } from "../../config/Config.ts"
import type { AgentTool } from "../../tools/AgentTool.ts"
import { askBotToolName } from "../../tools/builtin/AskBot.ts"
import type { Bot } from "../bots/Bot.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import type { Conversation, Message } from "../conversations/Conversation.ts"
import { Settings } from "../profile/Settings.ts"
import { systemPrompt } from "./PromptBuilder.ts"
import type { BotTools } from "./Toolbox.ts"

/** Tools and instructions a reply gets on top of the bot's own. */
export interface ReplyAdditions {
  readonly tools?: ReadonlyArray<AgentTool>
  /** Appended to the system prompt. */
  readonly instructions?: string
}

export interface ReplyOptions extends ReplyAdditions {
  /** Called when the reply starts (true) and stops (false) waiting for the person's approval. */
  readonly onApproval?: (waiting: boolean) => Effect.Effect<void>
  /** A last user turn the model sees but the conversation doesn't keep. */
  readonly nudge?: string
  /** Checked after each round of tool calls; true ends the reply there, without another model call. */
  readonly endAfterRound?: () => boolean
}

/** Adds to replies the runner starts itself, e.g. team tools in a team's private chat. */
export type ReplyExtension = (bot: Bot, conversation: Conversation) => Effect.Effect<ReplyAdditions | undefined>

/**
 * Runs bots' replies in the background, independent of any client connection. A teammate's answer
 * to `ask_bot` runs in its handoff conversation as part of the asking run, and is cancelled with it.
 */
export interface AgentRunnerShape {
  /** Starts replies from every bot in the conversation, replacing a run already in progress there. */
  start(conversationId: string): Effect.Effect<string>
  cancelRun(runId: string): Effect.Effect<void>
  /** Cancels the conversation's run (child runs included) and waits until it has stopped writing. */
  cancelConversation(conversationId: string): Effect.Effect<void>
  /**
   * Cancels every run (handoffs included) where the bot is one of the conversation's bots, e.g. before
   * it's deleted; a child run only when it's the bot's own reply.
   */
  cancelBot(botId: string): Effect.Effect<void>
  /**
   * Cancels the conversation's run, then runs `effect` before another run can start there, so
   * nothing writes into the conversation while e.g. its messages are cleared.
   */
  whileStopped<A, E, R>(conversationId: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
  isRunning(conversationId: string): Effect.Effect<boolean>
  /**
   * Runs one bot's reply in the conversation as a child run: announced like a run, cancelled with the
   * conversation or the bot, and awaited by the caller. Interrupting the wait interrupts the reply
   * and waits until it has saved itself as cancelled. Several can run in one conversation at once.
   */
  delegate(conversation: Conversation, bot: Bot, options?: ReplyOptions): Effect.Effect<Exit.Exit<Message | undefined>>
  /** Sets the extension consulted by replies the runner starts itself. */
  extendReplies(extension: ReplyExtension): Effect.Effect<void>
}

export class AgentRunner extends Context.Service<AgentRunner, AgentRunnerShape>()("weaver/AgentRunner") {}

/** Longest tool output fed back to the model and stored with the message. */
export const toolOutputLimit = 12_000

/**
 * A toolkit that only describes the tools to the model. Calls are resolved by the caller itself
 * (`disableToolCallResolution`), so it can ask for approval, stream progress and route to MCP servers.
 */
export const describeTools = (tools: ReadonlyArray<AgentTool>): Toolkit.WithHandler<Record<string, Tool.Any>> => ({
  tools: Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      Tool.dynamic(tool.name, { description: tool.description, parameters: tool.parameters as never }) as Tool.Any
    ])
  ),
  handle: (name) => Effect.die(`Tool ${String(name)} is resolved by the runner`)
})

/** Builds the system prompt a bot replies with in a conversation, given the tools it has for this reply. */
export const makeReplyPrompt = Effect.gen(function*() {
  const config = yield* AppConfig
  const bots = yield* BotRepo
  const settings = yield* Settings
  const existing = (ids: ReadonlyArray<string>) =>
    Effect.map(Effect.forEach(ids, (id) => Effect.option(bots.get(id))), (found) => found.flatMap(Option.toArray))
  return Effect.fn("AgentRunner.systemPrompt")(function*(bot: Bot, conversation: Conversation, tools: BotTools) {
    const conversationBots = yield* existing(conversation.botIds)
    const handoffFrom = conversation.kind === "handoff" && conversation.requesterBotId !== bot.id
      ? conversationBots.find((other) => other.id === conversation.requesterBotId)?.name
      : undefined
    const otherBots = conversation.kind === "handoff"
      ? []
      : conversationBots.flatMap((other) => (other.id !== bot.id ? [other.name] : []))
    const teammates = tools.tools.some((tool) => tool.name === askBotToolName)
      ? yield* existing(bot.teammateIds.filter((id) => id !== bot.id))
      : []
    return systemPrompt({
      bot,
      profile: yield* settings.profile,
      otherBots,
      teammates,
      handoffFrom,
      tools,
      display: config.display,
      now: new Date(yield* Clock.currentTimeMillis)
    })
  })
})
