import { Effect, Predicate, Schema } from "effect"
import type { Bot } from "../../features/bots/Bot.ts"
import { truncate } from "../../platform/lib/util.ts"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"

export const askBotToolName = "ask_bot"
/** Where a note about each answered handoff is saved in memory. */
export const handoffDirectory = "weaver/handoffs"
const noteAnswerLimit = 4000

const Params = Schema.Struct({
  bot: Schema.String.annotate({ description: "The teammate to ask, by name." }),
  request: Schema.String.annotate({
    description: "What you need from them: a clear, self-contained request they can act on without this chat."
  }),
  context: Schema.optional(Schema.String).annotate({
    description: "What they need to know to help: facts, constraints, what you've tried. They can't see this chat."
  })
})

export const handoffTitle = (requester: string, target: string): string => `${requester} → ${target}`

/** The request as the teammate sees it, posted by the asking bot. */
export const requestText = (request: string, context: string | undefined, requester: string): string =>
  context === undefined ? request : `${request}\n\nContext from ${requester}:\n${context}`

/** A teammate by id, or by name ignoring case and a leading `@`. */
export const findTeammate = (teammates: ReadonlyArray<Bot>, query: string): Bot | undefined => {
  const wanted = query.trim().replace(/^@/, "").toLowerCase()
  return teammates.find((bot) => bot.id === query.trim()) ??
    teammates.find((bot) => bot.name.trim().toLowerCase() === wanted)
}

const listed = (bot: Bot): string => (bot.label.trim().length > 0 ? `${bot.name} — ${bot.label.trim()}` : bot.name)

/**
 * `ask_bot`: asks one of the bot's teammates and returns their answer. `ask` runs the handoff;
 * the tool only checks the arguments and picks the teammate.
 */
export const askBotTool = (options: {
  readonly teammates: ReadonlyArray<Bot>
  readonly ask: (target: Bot, request: string, context: string | undefined) => Effect.Effect<string, ToolFailure>
}): AgentTool => {
  const { teammates, ask } = options
  const names = teammates.map((bot) => bot.name).join(", ")
  return {
    name: askBotToolName,
    description: `Ask a teammate (another bot) for help and get their answer back. Your teammates: ` +
      `${teammates.map(listed).join("; ")}. Use it when the request benefits from that teammate's strengths. ` +
      `Give a clear, self-contained request and the context they need, since they can't see this chat. ` +
      `You'll get their answer back as the result. Don't ask the same thing twice.`,
    parameters: jsonSchemaOf(Params),
    needsApproval: false,
    activity: "Asking a teammate",
    title: (params) => {
      const args = Predicate.isObject(params) ? params as Record<string, unknown> : {}
      const bot = Predicate.isString(args.bot) ? args.bot : ""
      const name = findTeammate(teammates, bot)?.name ?? (bot.trim() || "a teammate")
      const request = Predicate.isString(args.request) ? shorten(args.request, 60) : ""
      return request.length > 0 ? `Asked ${name}: ${request}` : `Asked ${name}`
    },
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(Params, raw)
        const target = findTeammate(teammates, params.bot)
        if (target === undefined) {
          return yield* new ToolFailure({
            message: `${params.bot.trim() || "That"} isn't one of your teammates. You can ask: ${names}.`
          })
        }
        const request = params.request.trim()
        if (request.length === 0) {
          return yield* new ToolFailure({ message: `The request is empty. Say what you need from ${target.name}.` })
        }
        const context = params.context?.trim()
        return yield* ask(target, request, context === undefined || context.length === 0 ? undefined : context)
      })
  }
}

export const teammatesGuidance = "When part of a request fits a teammate's strengths, ask them with ask_bot instead of " +
  "guessing. They can't see this chat, so include what they need. Then use their answer in your reply and credit them briefly."

export const teammatesPrompt = (teammates: ReadonlyArray<Bot>): string => {
  const lines = teammates.map((bot) => {
    const label = bot.label.trim().length > 0 ? ` (${bot.label.trim()})` : ""
    const about = shorten(bot.systemPrompt, 200)
    return `- ${bot.name}${label}${about.length > 0 ? `: ${about}` : ""}`
  })
  return `## Your teammates\n${lines.join("\n")}\n\n${teammatesGuidance}`
}

export const handoffPrompt = (requester: string): string =>
  `You're helping your teammate ${requester}, another bot, not the person. Answer their request directly and ` +
  `completely; your reply goes back to them. The person can read this conversation.`

const pad = (value: number) => String(value).padStart(2, "0")

/** `YYYY-MM-DD HH:mm` in the server's time, for note titles. */
export const noteTime = (at: Date): string =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`

/** `write_note` arguments for the knowledge base's record of an answered handoff. */
export const handoffNote = (input: {
  readonly requester: string
  readonly target: string
  readonly request: string
  readonly context: string | undefined
  readonly answer: string
  readonly at: Date
}): { title: string; directory: string; content: string; tags: Array<string> } => {
  const when = noteTime(input.at)
  const sections = [
    `## Request\n${input.request}`,
    ...(input.context === undefined ? [] : [`## Context\n${input.context}`]),
    `## Answer\n${truncate(input.answer, noteAnswerLimit)}`,
    `## Observations\n- [handoff] ${input.requester} asked ${input.target} for help (via Weaver)`,
    `## Relations\n- requested_by [[${input.requester}]]\n- answered_by [[${input.target}]]`
  ]
  return {
    title: `${input.requester} asked ${input.target}: ${shorten(input.request, 60)} (${when})`,
    directory: handoffDirectory,
    content: `${sections.join("\n\n")}\n`,
    tags: ["handoff"]
  }
}
