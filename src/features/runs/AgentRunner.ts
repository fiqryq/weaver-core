import { Clock, Context, Effect } from "effect"
import { Tool, type Toolkit } from "effect/ai"
import { AppConfig } from "../../config/Config.ts"
import type { AgentTool } from "../../tools/AgentTool.ts"
import type { Bot } from "../bots/Bot.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import type { Conversation } from "../conversations/Conversation.ts"
import { Settings } from "../profile/Settings.ts"
import { systemPrompt } from "./PromptBuilder.ts"
import type { BotTools } from "./Toolbox.ts"

/** Runs bots' replies in the background, independent of any client connection. */
export interface AgentRunnerShape {
  /** Starts replies from every bot in the conversation, replacing a run already in progress there. */
  start(conversationId: string): Effect.Effect<string>
  cancelRun(runId: string): Effect.Effect<void>
  cancelConversation(conversationId: string): Effect.Effect<void>
  isRunning(conversationId: string): Effect.Effect<boolean>
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
  return Effect.fn("AgentRunner.systemPrompt")(function*(bot: Bot, conversation: Conversation, tools: BotTools) {
    const conversationBots = yield* Effect.forEach(conversation.botIds, (id) => Effect.option(bots.get(id)))
    const otherBots = conversationBots.flatMap((option) =>
      option._tag === "Some" && option.value.id !== bot.id ? [option.value.name] : []
    )
    return systemPrompt({
      bot,
      profile: yield* settings.profile,
      otherBots,
      tools,
      display: config.display,
      now: new Date(yield* Clock.currentTimeMillis)
    })
  })
})
