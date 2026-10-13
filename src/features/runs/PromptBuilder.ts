import type { Prompt } from "effect/ai"
import { truncate } from "../../platform/lib/util.ts"
import { askBotToolName, handoffPrompt, teammatesPrompt } from "../../tools/builtin/AskBot.ts"
import { corePrompt, memoryInstructions } from "../../tools/builtin/Memory.ts"
import { sessionSearchGuidance } from "../../tools/learning/SessionSearch.ts"
import type { Bot } from "../bots/Bot.ts"
import type { Message, MessagePart, ReportPart } from "../conversations/Conversation.ts"
import { recallPrompt } from "../learning/memory/recall.ts"
import type { SkillIndexEntry } from "../learning/skills/SkillStore.ts"
import type { Profile } from "../profile/Profile.ts"
import type { BotTools } from "./Toolbox.ts"

export type PromptTurn =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string }

export interface PromptContext {
  readonly bot: Bot
  readonly profile: Profile
  /** Names of the other bots in a group chat; empty for a one-on-one chat. */
  readonly otherBots: ReadonlyArray<string>
  /** Bots it can ask with ask_bot, described when that tool is offered. */
  readonly teammates?: ReadonlyArray<Bot>
  /** In a handoff, the name of the teammate the bot is answering. */
  readonly handoffFrom?: string | undefined
  readonly tools: Pick<
    BotTools,
    "tools" | "workspace" | "memoryEnabled" | "memoryProject" | "coreMemory" | "recall" | "skills" | "integrations" | "unavailable"
  >
  readonly display: string
  readonly now: Date
}

/** Worded after Hermes; its older "after a complex task (5+ tool calls)…" phrasing trips Anthropic's content filter. */
export const skillsGuidance = "When you work out a non-trivial workflow, record it with skill_manage for future reuse."

/** Keeps skill text from closing or opening tags in the prompt, e.g. `</available_skills>`. */
const escapeTags = (text: string): string => text.replace(/</g, "‹").replace(/>/g, "›")

const sharedGroup = "Shared library"

export const skillsPrompt = (skills: ReadonlyArray<SkillIndexEntry>, basicTools: string): string => {
  if (skills.length === 0) {
    return `## Skills\nYou can keep skills: your own reusable instructions for recurring tasks, loaded with skill_view and ` +
      `saved with skill_manage. You don't have any yet. ${skillsGuidance}`
  }
  const byCategory = new Map<string, Array<SkillIndexEntry>>()
  for (const skill of skills.filter((entry) => entry.library !== true)) {
    const category = skill.category || "general"
    byCategory.set(category, [...(byCategory.get(category) ?? []), skill])
  }
  const entry = (skill: SkillIndexEntry) => {
    const name = escapeTags(skill.name)
    return skill.description.length > 0 ? `    - ${name}: ${escapeTags(skill.description)}` : `    - ${name}`
  }
  const lines: Array<string> = []
  for (const category of [...byCategory.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`  ${escapeTags(category)}:`)
    for (const skill of byCategory.get(category)!.sort((a, b) => a.name.localeCompare(b.name))) lines.push(entry(skill))
  }
  const shared = skills.filter((skill) => skill.library === true).sort((a, b) => a.name.localeCompare(b.name))
  if (shared.length > 0) {
    lines.push(`  ${sharedGroup}:`)
    for (const skill of shared) lines.push(entry(skill))
  }
  return `${skillsGuidance}\n\n` +
    "## Skills\n" +
    "Before replying, scan the skills below. If a skill matches or is even partially relevant to your " +
    "task, you MUST load it with skill_view(name) and follow its instructions. Err on the side of " +
    "loading — it is always better to have context you don't need than to miss critical steps, pitfalls, " +
    "or established workflows. Skills contain specialized knowledge — API endpoints, tool-specific " +
    "commands, and proven workflows that outperform general-purpose approaches. Load the skill " +
    `even if you think you could handle the task with basic tools like ${basicTools}. ` +
    "Skills also encode the user's preferred approach, conventions, and quality standards for tasks like " +
    "code review, planning, and testing — load them even for tasks you already know how to do, because " +
    "the skill defines how it should be done here.\n" +
    "If a skill has issues, fix it with skill_manage(action='patch').\n" +
    (shared.length > 0
      ? `Skills under "${sharedGroup}" are shared with other bots: a fix to one applies to all of them, and new skills you create stay your own.\n`
      : "") +
    "After difficult/iterative tasks, offer to save as a skill. If a skill you loaded was missing steps, " +
    "had wrong commands, or needed pitfalls you discovered, update it before finishing.\n" +
    "\n" +
    "<available_skills>\n" +
    `${lines.join("\n")}\n` +
    "</available_skills>\n\n" +
    "Only proceed without loading a skill if genuinely none are relevant to the task."
}

const formatNow = (now: Date, timezone: string): string => {
  try {
    return now.toLocaleString("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "short" })
  } catch {
    return now.toISOString()
  }
}

export const systemPrompt = (context: PromptContext): string => {
  const { bot, profile, tools } = context
  const name = profile.displayName || "the user"
  const user = profile.email ? `${name} (${profile.email})` : name
  const timezone = profile.timezone || "UTC"
  let system = bot.systemPrompt
  system += `\n\nYour name is ${bot.name}. The user is ${user}. Their timezone is ${timezone}. Now: ${formatNow(context.now, timezone)}.`

  if (context.handoffFrom !== undefined) {
    system += ` ${handoffPrompt(context.handoffFrom)}`
  } else if (context.otherBots.length > 0) {
    system += ` This is a group chat with other bots: ${context.otherBots.join(", ")}. Their messages are prefixed with their name.`
  }

  const toolNames = new Set(tools.tools.map((tool) => tool.name))
  if (toolNames.size > 0) {
    const abilities: Array<string> = []
    if (toolNames.has("run_command")) abilities.push("run shell commands")
    if (toolNames.has("read_file")) abilities.push("read and write files")
    const web = toolNames.has("web_search")
    const browser = [...toolNames].some((tool) => tool.startsWith("browser_"))
    if (web) abilities.push("search the web and read pages (web_search, web_fetch)")
    if (browser) {
      abilities.push(
        `use a real web browser for pages you need to interact with, like forms and logins; the user can watch it on the desktop (DISPLAY=${context.display})`
      )
    }
    system += `\n\nYou work on your own Linux VPS and can call tools to act, not just talk.`
    if (abilities.length > 0) system += ` You can ${abilities.join(", ")}.`
    if (web && browser) {
      system += " Prefer web_search and web_fetch for looking things up; use the browser when you need to click, fill in forms or stay logged in."
    }
    system += ` Your workspace is ${tools.workspace}; keep your files there.` +
      ` Use tools when they help, check results before reporting, and keep the user informed in plain language.` +
      ` Don't run destructive commands (deleting data, changing system settings) unless the user clearly asked for it.`
  }

  if (tools.integrations.length > 0) {
    const list = tools.integrations.map((integration) => `${integration.name} (tools starting with ${integration.prefix}__)`)
    system += `\n\nConnected apps you can use: ${list.join(", ")}.`
  }
  if (toolNames.has(askBotToolName) && context.teammates !== undefined && context.teammates.length > 0) {
    system += `\n\n${teammatesPrompt(context.teammates)}`
  }
  if (tools.unavailable.length > 0) {
    system += `\n\nThese are set up but unreachable right now, so say so if the user asks for them: ${tools.unavailable.join("; ")}.`
  }

  if (tools.memoryEnabled) {
    system += `\n\n${memoryInstructions(bot.name, tools.memoryProject)}`
    if (tools.coreMemory !== undefined) system += `\n\n${corePrompt(tools.coreMemory, tools.memoryProject)}`
    if (tools.recall.length > 0) system += `\n\n${recallPrompt(tools.recall)}`
  }

  if (toolNames.has("skill_manage")) {
    const browser = [...toolNames].some((tool) => tool.startsWith("browser_"))
    const basic = toolNames.has("run_command")
      ? browser ? "run_command or the browser" : "run_command"
      : browser
      ? "the browser"
      : "your other tools"
    system += `\n\n${skillsPrompt(tools.skills, basic)}`
  }
  if (toolNames.has("session_search")) system += `\n\n${sessionSearchGuidance}`
  return system
}

/** A team report as models see it, e.g. `[Decision] Use Kotlin: Use Kotlin for the app.`. */
export const reportText = (report: ReportPart): string => {
  const kind = `${report.kind.charAt(0).toUpperCase()}${report.kind.slice(1)}`
  return report.title === null || report.title.length === 0 ? `[${kind}] ${report.text}` : `[${kind}] ${report.title}: ${report.text}`
}

/** A message's text with its team reports, for prompts. */
export const promptText = (parts: ReadonlyArray<MessagePart>): string =>
  parts
    .flatMap((part) => (part.type === "text" ? [part.text] : part.type === "report" ? [reportText(part)] : []))
    .join("\n\n")
    .trim()

/**
 * The conversation as this bot sees it: its own replies as assistant turns, everyone else's
 * (other bots included, prefixed with their name) as user turns. A bot's request in a handoff is
 * a user message with its bot id, prefixed the same way.
 */
export const historyTurns = (messages: ReadonlyArray<Message>, bot: Bot): Array<PromptTurn> => {
  const turns: Array<PromptTurn> = []
  for (const message of messages) {
    if (message.status === "streaming" || message.status === "error") continue
    const text = promptText(message.parts)
    if (message.role === "user") {
      const quoted = message.replyQuote ? `(Replying to: "${message.replyQuote}")\n${text}` : text
      const content = message.botId !== null && quoted.length > 0 ? `[${message.senderName}]: ${quoted}` : quoted
      if (content.length > 0) turns.push({ role: "user", content })
    } else if (text.length > 0) {
      if (message.botId === bot.id || (message.botId === null && message.senderName === bot.name)) {
        turns.push({ role: "assistant", content: text })
      } else {
        turns.push({ role: "user", content: `[${message.senderName}]: ${text}` })
      }
    }
  }
  return merged(turns)
}

/** Longest params or output shown per call in a tool transcript. */
export const transcriptValueLimit = 1500
const transcriptLimit = 40_000

/**
 * The tool calls in a reply as plain text, for a review prompt: history turns keep only text, and
 * text works with every OpenAI-compatible provider where replayed tool turns may not.
 */
export const toolTranscript = (parts: ReadonlyArray<MessagePart>): string | undefined => {
  const calls = parts.flatMap((part) => (part.type === "tool-call" ? [part] : []))
  if (calls.length === 0) return undefined
  const results = new Map(parts.flatMap((part) => (part.type === "tool-result" ? [[part.id, part] as const] : [])))
  const entries: Array<string> = []
  let length = 0
  for (const [index, call] of calls.entries()) {
    const result = results.get(call.id)
    const params = truncate(JSON.stringify(call.params ?? {}), transcriptValueLimit)
    const outcome = result === undefined
      ? "(no result)"
      : `${result.isFailure ? "Failed" : "Result"}:\n${truncate(result.output, transcriptValueLimit)}`
    const entry = `${index + 1}. ${call.name} ${params}\n${outcome}`
    if (length + entry.length > transcriptLimit) {
      entries.push(`(${calls.length - index} more tool calls not shown)`)
      break
    }
    entries.push(entry)
    length += entry.length
  }
  return `The tool calls you made in the reply under review, in order (long values are cut):\n\n${entries.join("\n\n")}`
}

/** Characters of earlier tool output a reply's prompt keeps whole, newest first, besides its latest round. */
export const toolContextBudget = 40_000
/** Outputs this short are never cleared: they cost little and often hold the fact that matters. */
const clearableLength = 1_000
/** How much of a cleared output stays, e.g. a page's URL or a command's first lines. */
const clearedHeadLength = 300

const isBrowserTool = (name: string): boolean => name.startsWith("browser_")

export const clearedOutput = (name: string, output: string): string => {
  const head = output.slice(0, clearedHeadLength).trimEnd()
  const note = isBrowserTool(name)
    ? `… (${output.length - head.length} more characters cleared to save context; a later browser result shows the page as it is now.)`
    : `… (${output.length - head.length} more characters cleared to save context; call ${name} again if you need them.)`
  return `${head}\n${note}`
}

/**
 * A reply's prompt with earlier tool outputs cleared, so each round doesn't resend all of them.
 * The latest round stays whole. Before it, a browser page is cleared once a later browser result
 * shows the page, and other outputs stay whole newest first until `budget` is used up; every older
 * one is cleared. A cleared output is too short to clear again, so it stays the same in later
 * rounds and the start of the prompt keeps matching the provider's prompt cache.
 */
export const compactToolResults = (
  prompt: ReadonlyArray<Prompt.MessageEncoded>,
  budget: number = toolContextBudget
): Array<Prompt.MessageEncoded> => {
  const result = [...prompt]
  const latest = result.findLastIndex((message) => message.role === "tool")
  let kept = 0
  let full = false
  let laterPage = false
  for (let index = latest; index >= 0; index--) {
    const message = result[index]!
    if (message.role !== "tool") continue
    const content = [...message.content]
    let changed = false
    for (let at = content.length - 1; at >= 0; at--) {
      const part = content[at]!
      if (part.type !== "tool-result" || typeof part.result !== "string" || part.result.length <= clearableLength) continue
      const page = isBrowserTool(part.name) && !part.isFailure
      if (index !== latest) {
        const stalePage = page && laterPage
        if (!stalePage && (full || kept + part.result.length > budget)) full = true
        if (stalePage || full) {
          content[at] = { ...part, result: clearedOutput(part.name, part.result) }
          changed = true
          continue
        }
      }
      kept += part.result.length
      if (page) laterPage = true
    }
    if (changed) result[index] = { ...message, content }
  }
  return result
}

/** Joins back-to-back turns from the same role; several providers (e.g. deepseek-reasoner) reject them. */
export const merged = (turns: ReadonlyArray<PromptTurn>): Array<PromptTurn> => {
  const result: Array<PromptTurn> = []
  for (const turn of turns) {
    const last = result.at(-1)
    if (last !== undefined && last.role === turn.role && turn.role !== "system") {
      result[result.length - 1] = { role: turn.role, content: `${last.content}\n\n${turn.content}` } as PromptTurn
    } else {
      result.push(turn)
    }
  }
  return result
}
