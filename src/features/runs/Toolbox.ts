import { Context, Effect, Layer, Option, Predicate } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { AppConfig } from "../../config/Config.ts"
import { BotUsers } from "../../platform/os/BotUsers.ts"
import { type AgentTool, ToolFailure } from "../../tools/AgentTool.ts"
import { browserTools } from "../../tools/builtin/Browser.ts"
import { Camofox } from "../../tools/builtin/Camofox.ts"
import { ensureWorkspace, fileTools } from "../../tools/builtin/Files.ts"
import { browserTitle, mcpTool, sanitizeToolName, slugify } from "../../tools/builtin/Mcp.ts"
import {
  allowedMemoryTools,
  attribute,
  botMemoryProject,
  coreExcerpt,
  memoryActivity,
  memoryServerConfig,
  memoryTitle,
  pinProject
} from "../../tools/builtin/Memory.ts"
import { scheduleTools } from "../../tools/builtin/Schedules.ts"
import { runCommandTool } from "../../tools/builtin/Shell.ts"
import { findSkillsTool, proposeTeamTool } from "../../tools/builtin/TeamBuilder.ts"
import { webTools } from "../../tools/builtin/Web.ts"
import { sessionSearchTool } from "../../tools/learning/SessionSearch.ts"
import { skillTools } from "../../tools/learning/Skills.ts"
import type { Bot } from "../bots/Bot.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import type { ConversationKind } from "../conversations/Conversation.ts"
import { ConversationRepo } from "../conversations/ConversationRepo.ts"
import { IntegrationOAuth, signInAgainMessage } from "../integrations/IntegrationOAuth.ts"
import { IntegrationRepo } from "../integrations/IntegrationRepo.ts"
import { McpHub, type McpServerConfig } from "../integrations/McpHub.ts"
import { LibraryStore } from "../learning/library/LibraryStore.ts"
import { SkillSources } from "../learning/library/SkillSources.ts"
import { CoreMemory } from "../learning/memory/CoreMemory.ts"
import type { RecalledNote } from "../learning/memory/recall.ts"
import { type SkillIndexEntry, SkillStore } from "../learning/skills/SkillStore.ts"
import { KnowledgeBase, writeTarget } from "../memory/KnowledgeBase.ts"
import { ScheduleRepo } from "../schedules/ScheduleRepo.ts"
import { TeamRepo } from "../teams/TeamRepo.ts"
import type { TeamSetup } from "../teams/teamSetup.ts"
import { RunEvents } from "./RunEvents.ts"

export interface BotTools {
  readonly tools: ReadonlyArray<AgentTool>
  readonly workspace: string
  readonly memoryEnabled: boolean
  /** The bot's own memory project, when it doesn't use the shared one. */
  readonly memoryProject: string | undefined
  readonly coreMemory: string | undefined
  /** Notes related to the message being answered; empty unless a recall query was given. */
  readonly recall: ReadonlyArray<RecalledNote>
  /** The bot's skills and its library skills for the prompt index; empty when skills are off. */
  readonly skills: ReadonlyArray<SkillIndexEntry>
  /** Integrations the bot can use, with the prefix their tools carry. */
  readonly integrations: ReadonlyArray<{ readonly name: string; readonly prefix: string }>
  /** Things that were set up but couldn't be reached, for the bot to mention if relevant. */
  readonly unavailable: ReadonlyArray<string>
}

export interface ForBotOptions {
  readonly conversationId?: string
  /**
   * The kind of conversation being answered. Replies in one get find_skills, and in chats and team
   * private chats also propose_team; left out (e.g. outside a reply), neither is offered.
   */
  readonly conversationKind?: ConversationKind | undefined
  readonly recallQuery?: string | undefined
}

/** Assembles the tools a bot gets for one reply, from its settings and the integrations it's allowed to use. */
export class Toolbox extends Context.Service<Toolbox, {
  /**
   * `conversationId` is the chat being answered; past-chat search leaves it out. `recallQuery` is
   * searched in memory for related notes, alongside the Core Memory read.
   */
  forBot(bot: Bot, options?: ForBotOptions): Effect.Effect<BotTools>
}>()("weaver/Toolbox") {
  static readonly layer = Layer.effect(
    Toolbox,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const hub = yield* McpHub
      const integrations = yield* IntegrationRepo
      const oauth = yield* IntegrationOAuth
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const skillStore = yield* SkillStore
      const library = yield* LibraryStore
      const sql = yield* SqlClient.SqlClient
      const botUsers = yield* BotUsers
      const camofox = yield* Camofox
      const coreMemory = yield* CoreMemory
      const knowledge = yield* KnowledgeBase
      const bots = yield* BotRepo
      const conversations = yield* ConversationRepo
      const events = yield* RunEvents
      // Optional so the toolbox works in layer graphs without teams or the skills catalog; without
      // them, bots can't build teams.
      const teams = yield* Effect.serviceOption(TeamRepo)
      const sources = Option.getOrUndefined(yield* Effect.serviceOption(SkillSources))
      const schedules = Option.getOrUndefined(yield* Effect.serviceOption(ScheduleRepo))
      const teamSetup: TeamSetup | undefined = Option.isSome(teams)
        ? { teams: teams.value, bots, conversations, events }
        : undefined

      const browserServer: McpServerConfig | undefined = config.browser === "playwright" && config.browserCommand.length > 0
        ? {
          key: "builtin:browser",
          name: "Browser",
          transport: "stdio",
          command: config.browserCommand[0]!,
          args: config.browserCommand.slice(1),
          env: { DISPLAY: config.display },
          url: "",
          headers: {}
        }
        : undefined

      const forBot = Effect.fn("Toolbox.forBot")(function*(bot: Bot, options?: ForBotOptions) {
        const workspace = yield* ensureWorkspace(config.dataDir, bot.id, Option.getOrUndefined(config.botUser))
        const tools: Array<AgentTool> = []
        const unavailable: Array<string> = []
        const connected: Array<{ name: string; prefix: string }> = []
        const enabled = new Set(bot.tools)
        const ask = bot.approvalMode === "ask"
        const allowRisky = bot.approvalMode !== "off"

        if (enabled.has("shell") && allowRisky) {
          tools.push(runCommandTool({
            workspace,
            display: config.display,
            needsApproval: ask,
            spawner,
            runAs: botUsers.userFor(bot.id).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
          }))
        }
        if (enabled.has("files")) {
          tools.push(...fileTools({ workspace, writesNeedApproval: ask, allowWrites: allowRisky }))
        }

        let skills: ReadonlyArray<SkillIndexEntry> = []
        if (enabled.has("skills")) {
          tools.push(...skillTools({ store: skillStore, botId: bot.id, library, assigned: bot.librarySkills, workspace }))
          const indexed = yield* Effect.result(Effect.gen(function*() {
            const own = yield* skillStore.index(bot.id)
            const ownNames = new Set(own.map((skill) => skill.name))
            const shared = yield* library.index(bot.librarySkills.filter((name) => !ownNames.has(name)))
            return [...own, ...shared]
          }))
          if (indexed._tag === "Success") skills = indexed.success
          else unavailable.push(`Skills (${indexed.failure.message})`)
        }
        if ((enabled.has("skills") || enabled.has("memory")) && options?.conversationId !== undefined) {
          tools.push(sessionSearchTool({ sql, botId: bot.id, currentConversationId: options.conversationId }))
        }

        let memoryEnabled = false
        let ownProject: string | undefined
        let core: string | undefined
        let recall: ReadonlyArray<RecalledNote> = []
        if (enabled.has("memory") && Option.isSome(config.memory)) {
          const memory = config.memory.value
          const server = memoryServerConfig(memory)
          const project = botMemoryProject(bot, memory.project)
          const listed = yield* Effect.result(hub.tools(server))
          if (listed._tag === "Success") {
            for (const tool of listed.success.filter((tool) => allowedMemoryTools.has(tool.name))) {
              const memoryTool = mcpTool({
                hub,
                server,
                tool,
                exposedName: tool.name,
                activity: memoryActivity(tool.name),
                title: memoryTitle(tool.name),
                prepare: (args) => {
                  const pinned = pinProject(args, project)
                  return tool.name === "write_note" ? attribute(pinned, bot.name) : pinned
                }
              })
              tools.push(
                tool.name === "write_note" || tool.name === "edit_note"
                  ? {
                    ...memoryTool,
                    // The note's history keeps what the bot replaced and what it wrote.
                    run: (params) => {
                      const target = Predicate.isObject(params) ? writeTarget(tool.name, params as Record<string, unknown>) : undefined
                      return Effect.gen(function*() {
                        if (target !== undefined) yield* knowledge.capture(project, target, "")
                        const output = yield* memoryTool.run(params)
                        if (target !== undefined) yield* knowledge.captureLater(project, target, bot.name)
                        return output
                      }).pipe(Effect.ensuring(coreMemory.invalidate(project)))
                    }
                  }
                  : memoryTool
              )
            }
            memoryEnabled = true
            ownProject = project === memory.project ? undefined : project
            const query = config.memoryRecall ? options?.recallQuery : undefined
            const [text, recalled] = yield* Effect.all([
              coreMemory.text(project),
              query === undefined ? Effect.succeed([]) : coreMemory.recall(query, project)
            ], { concurrency: "unbounded" })
            core = coreExcerpt(text ?? "")
            recall = recalled
          } else {
            unavailable.push(`Memory (${listed.failure.message})`)
          }
        }

        const owner = { botId: bot.id, conversationId: options?.conversationId ?? "default" }
        const usesCamofox = config.browser === "camofox"
        if (enabled.has("web")) {
          tools.push(...webTools({ camofox: usesCamofox ? camofox : undefined, owner }))
        }
        if (enabled.has("browser") && usesCamofox) {
          if (yield* camofox.available) tools.push(...browserTools({ camofox, owner, workspace }))
          else unavailable.push(`Browser (the browser service isn't running at ${camofox.url})`)
        }
        if (enabled.has("browser") && browserServer !== undefined) {
          const listed = yield* Effect.result(hub.tools(browserServer))
          if (listed._tag === "Success") {
            for (const tool of listed.success) {
              tools.push(mcpTool({
                hub,
                server: browserServer,
                tool,
                exposedName: sanitizeToolName(tool.name),
                activity: "Using the browser",
                title: browserTitle(tool.name)
              }))
            }
          } else {
            unavailable.push(`Browser (${listed.failure.message})`)
          }
        }

        if (bot.integrationIds.length > 0) {
          const all = yield* integrations.list
          const usedPrefixes = new Set<string>()
          for (const integration of all.filter((i) => i.enabled && bot.integrationIds.includes(i.id))) {
            let prefix = slugify(integration.name)
            for (let n = 2; usedPrefixes.has(prefix); n++) prefix = `${slugify(integration.name)}${n}`
            usedPrefixes.add(prefix)
            if (integration.auth === "oauth" && integration.oauthStatus !== "signed-in") {
              unavailable.push(`${integration.name} (${signInAgainMessage(integration.name)})`)
              continue
            }
            const server = oauth.config(integration)
            const listed = yield* Effect.result(hub.tools(server))
            if (listed._tag === "Failure") {
              unavailable.push(`${integration.name} (${listed.failure.message})`)
              continue
            }
            connected.push({ name: integration.name, prefix })
            for (const tool of listed.success) {
              tools.push(mcpTool({
                hub,
                server,
                tool,
                exposedName: sanitizeToolName(`${prefix}__${tool.name}`),
                activity: `Using ${integration.name}`,
                label: integration.name
              }))
            }
          }
        }

        const kind = options?.conversationKind
        if (kind !== undefined) {
          tools.push(findSkillsTool({ library, sources }))
          if ((kind === "chat" || kind === "team-private") && teamSetup !== undefined && sources !== undefined) {
            tools.push(proposeTeamTool({ proposer: bot, setup: teamSetup, library, sources }))
          }
          const conversationId = options?.conversationId
          if ((kind === "chat" || kind === "team-private") && schedules !== undefined && conversationId !== undefined) {
            tools.push(...scheduleTools({
              repo: schedules,
              botId: bot.id,
              conversationId,
              changed: events.publish({ type: "schedules-changed", conversationId }),
              needsApproval: ask
            }))
          }
        }

        const seen = new Set<string>()
        const unique = tools.filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)))

        return {
          tools: unique,
          workspace,
          memoryEnabled,
          memoryProject: ownProject,
          coreMemory: core,
          recall,
          skills,
          integrations: connected,
          unavailable
        } satisfies BotTools
      })

      return Toolbox.of({ forBot })
    })
  )
}
