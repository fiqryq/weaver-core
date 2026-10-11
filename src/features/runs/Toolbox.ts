import { Clock, Context, Effect, Layer, Option } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { AppConfig } from "../../config/Config.ts"
import type { AgentTool } from "../../tools/AgentTool.ts"
import { ensureWorkspace, fileTools } from "../../tools/builtin/Files.ts"
import { browserTitle, mcpTool, sanitizeToolName, slugify } from "../../tools/builtin/Mcp.ts"
import {
  allowedMemoryTools,
  attribute,
  coreCacheMillis,
  coreExcerpt,
  corePermalink,
  memoryActivity,
  memoryServerConfig,
  memoryTitle,
  noteContent,
  pinProject
} from "../../tools/builtin/Memory.ts"
import { runCommandTool } from "../../tools/builtin/Shell.ts"
import { sessionSearchTool } from "../../tools/learning/SessionSearch.ts"
import { skillTools } from "../../tools/learning/Skills.ts"
import type { Bot } from "../bots/Bot.ts"
import { toMcpConfig } from "../integrations/integrationConfig.ts"
import { IntegrationRepo } from "../integrations/IntegrationRepo.ts"
import { McpHub, type McpServerConfig } from "../integrations/McpHub.ts"
import { type SkillIndexEntry, SkillStore } from "../learning/skills/SkillStore.ts"

export interface BotTools {
  readonly tools: ReadonlyArray<AgentTool>
  readonly workspace: string
  readonly memoryEnabled: boolean
  readonly coreMemory: string | undefined
  /** The bot's skills for the prompt index; empty when skills are off. */
  readonly skills: ReadonlyArray<SkillIndexEntry>
  /** Integrations the bot can use, with the prefix their tools carry. */
  readonly integrations: ReadonlyArray<{ readonly name: string; readonly prefix: string }>
  /** Things that were set up but couldn't be reached, for the bot to mention if relevant. */
  readonly unavailable: ReadonlyArray<string>
}

/** Assembles the tools a bot gets for one reply, from its settings and the integrations it's allowed to use. */
export class Toolbox extends Context.Service<Toolbox, {
  /** `conversationId` is the chat being answered; past-chat search leaves it out. */
  forBot(bot: Bot, options?: { readonly conversationId?: string }): Effect.Effect<BotTools>
}>()("weaver/Toolbox") {
  static readonly layer = Layer.effect(
    Toolbox,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const hub = yield* McpHub
      const integrations = yield* IntegrationRepo
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const skillStore = yield* SkillStore
      const sql = yield* SqlClient.SqlClient

      let coreCache: { text: string | undefined; fetchedAt: number } | undefined

      const browserServer: McpServerConfig | undefined = config.browserCommand.length > 0
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

      const coreMemory = (server: McpServerConfig, project: string) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          if (coreCache !== undefined && now - coreCache.fetchedAt < coreCacheMillis) return coreCache.text
          const result = yield* hub.call(
            server,
            "read_note",
            pinProject({ identifier: corePermalink, output_format: "json" }, project)
          ).pipe(Effect.option)
          const text = Option.flatMap(result, (r) => Option.fromNullishOr(r.isError ? undefined : noteContent(r.text)))
          const excerpt = Option.getOrUndefined(Option.flatMap(text, (t) => Option.fromNullishOr(coreExcerpt(t))))
          coreCache = { text: excerpt, fetchedAt: now }
          return excerpt
        })

      const forBot = Effect.fn("Toolbox.forBot")(function*(bot: Bot, options?: { readonly conversationId?: string }) {
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
            runAs: Option.getOrUndefined(Option.map(config.botUser, (botUser) => botUser.user))
          }))
        }
        if (enabled.has("files")) {
          tools.push(...fileTools({ workspace, writesNeedApproval: ask, allowWrites: allowRisky }))
        }

        let skills: ReadonlyArray<SkillIndexEntry> = []
        if (enabled.has("skills")) {
          tools.push(...skillTools({ store: skillStore, botId: bot.id }))
          const indexed = yield* Effect.result(skillStore.index(bot.id))
          if (indexed._tag === "Success") skills = indexed.success
          else unavailable.push(`Skills (${indexed.failure.message})`)
        }
        if ((enabled.has("skills") || enabled.has("memory")) && options?.conversationId !== undefined) {
          tools.push(sessionSearchTool({ sql, botId: bot.id, currentConversationId: options.conversationId }))
        }

        let memoryEnabled = false
        let core: string | undefined
        if (enabled.has("memory") && Option.isSome(config.memory)) {
          const memory = config.memory.value
          const server = memoryServerConfig(memory)
          const listed = yield* Effect.result(hub.tools(server))
          if (listed._tag === "Success") {
            for (const tool of listed.success.filter((tool) => allowedMemoryTools.has(tool.name))) {
              tools.push(mcpTool({
                hub,
                server,
                tool,
                exposedName: tool.name,
                activity: memoryActivity(tool.name),
                title: memoryTitle(tool.name),
                prepare: (args) => {
                  if (tool.name === "write_note" || tool.name === "edit_note") coreCache = undefined
                  const pinned = pinProject(args, memory.project)
                  return tool.name === "write_note" ? attribute(pinned, bot.name) : pinned
                }
              }))
            }
            memoryEnabled = true
            core = yield* coreMemory(server, memory.project)
          } else {
            unavailable.push(`Memory (${listed.failure.message})`)
          }
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
            const server = toMcpConfig(integration)
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

        const seen = new Set<string>()
        const unique = tools.filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)))

        return {
          tools: unique,
          workspace,
          memoryEnabled,
          coreMemory: core,
          skills,
          integrations: connected,
          unavailable
        } satisfies BotTools
      })

      return Toolbox.of({ forBot })
    })
  )
}
