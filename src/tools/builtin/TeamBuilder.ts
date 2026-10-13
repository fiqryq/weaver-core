import { Effect, Predicate, Schema } from "effect"
import { type Bot, BuiltinTool } from "../../features/bots/Bot.ts"
import type { LibraryStore } from "../../features/learning/library/LibraryStore.ts"
import { installFromUrl, type SkillSources } from "../../features/learning/library/SkillSources.ts"
import { roleLimit } from "../../features/teams/Team.ts"
import { createTeam, type TeamSetup } from "../../features/teams/teamSetup.ts"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure, withoutNulls } from "../AgentTool.ts"

export const findSkillsToolName = "find_skills"
export const proposeTeamToolName = "propose_team"

export const teamNameLimit = 60
export const purposeLimit = 300
export const botNameLimit = 40
export const labelLimit = 60
export const instructionsLimit = 4000
export const maxNewBots = 6
export const maxSkillsPerBot = 8
const maxMatches = 20

/** What a proposed bot gets when the proposal doesn't list its tools. */
export const defaultTeamBotTools: ReadonlyArray<BuiltinTool> = ["files", "web", "skills"]

/** Avatars for new bots, by their place in the proposal; clients preview them the same way. */
export const blobKinds = [
  "circle",
  "cloud",
  "diamond",
  "sparkle",
  "flower",
  "pebble",
  "scallop",
  "drop",
  "bean",
  "triangle",
  "square",
  "burst",
  "hexagon"
] as const
export const blobColors = ["#3B82F6", "#8B5CF6", "#EC4899", "#F97316", "#22C55E", "#14B8A6", "#F59E0B", "#EF4444"] as const

export const avatarFor = (index: number): { readonly symbol: string; readonly colorHex: string } => ({
  symbol: `blob.${blobKinds[index % blobKinds.length]}`,
  colorHex: blobColors[index % blobColors.length]!
})

const isTool = Schema.is(BuiltinTool)
const toolIds = BuiltinTool.literals.join(", ")
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const argsOf = (params: unknown): Record<string, unknown> => (Predicate.isObject(params) ? params as Record<string, unknown> : {})

const FindParams = Schema.Struct({
  query: Schema.String.annotate({
    description: "What the skills should help with, e.g. \"brand design social media copywriting\". Empty lists everything."
  })
})

/** Library and catalog skills matching a query, best first: library skills before catalog ones on a tie. */
export const findSkillsTool = (options: {
  readonly library: LibraryStore["Service"]
  readonly sources: SkillSources["Service"] | undefined
}): AgentTool => {
  const { library, sources } = options
  return {
    name: findSkillsToolName,
    description: "Search the skills you could give bots: the shared skills library first, then the skills catalog. " +
      "Returns each skill's name, what it's for, and whether it's already in the library or would be installed from " +
      "the catalog. Use it before propose_team to pick skills for the new bots.",
    parameters: jsonSchemaOf(FindParams),
    needsApproval: false,
    activity: "Looking for skills",
    title: (params) => {
      const query = argsOf(params).query
      return Predicate.isString(query) && query.trim().length > 0 ? `Looked for skills: ${shorten(query, 60)}` : "Looked for skills"
    },
    run: (raw) =>
      Effect.gen(function*() {
        const params = yield* decodeParams(FindParams, raw)
        const query = params.query.trim()
        const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1))]
        const own = yield* Effect.mapError(library.list, (error) => new ToolFailure({ message: error.message }))
        const catalog = sources === undefined ? undefined : yield* sources.catalog
        const ownNames = new Set(own.map((skill) => skill.name.toLowerCase()))
        const candidates = [
          ...own.map((skill) => ({ name: skill.name, description: skill.description, where: "in your library", library: true })),
          ...(catalog?.skills ?? []).filter((skill) => !ownNames.has(skill.name.toLowerCase())).map((skill) => ({
            name: skill.name,
            description: skill.description,
            where: `from the catalog: ${skill.source}`,
            library: false
          }))
        ]
        const scored = candidates.map((skill) => {
          const name = skill.name.toLowerCase()
          const text = `${name} ${skill.description.toLowerCase()}`
          const score = words.length === 0
            ? 1
            : words.reduce((sum, word) => sum + (name.includes(word) ? 2 : text.includes(word) ? 1 : 0), 0)
          return { ...skill, score }
        }).filter((skill) => skill.score > 0).sort((a, b) =>
          b.score - a.score || Number(b.library) - Number(a.library) || a.name.localeCompare(b.name)
        )
        const unreachable = catalog?.error === undefined ? "" : `\n\n(Part of the catalog couldn't be loaded: ${catalog.error})`
        if (scored.length === 0) {
          return `${query.length > 0 ? `No skills match "${query}".` : "There are no skills yet."} ` +
            `Try broader words, or propose bots without skills.${unreachable}`
        }
        const lines = scored.slice(0, maxMatches).map((skill) => {
          const description = shorten(skill.description, 160)
          return `- ${skill.name} — ${description.length > 0 ? description : "(no description)"} (${skill.where})`
        })
        const more = scored.length > maxMatches ? `\n(${scored.length - maxMatches} more; narrow the query to see them.)` : ""
        return `${query.length > 0 ? `Skills matching "${query}"` : "Skills"}:\n${lines.join("\n")}${more}\n\n` +
          `Give bots these names in propose_team; catalog skills are installed when the person approves.${unreachable}`
      })
  }
}

const ProposedBot = Schema.Struct({
  name: Schema.String.annotate({
    description: `The new bot's name, 1-${botNameLimit} characters; it can't match an existing bot's name.`
  }),
  role: Schema.String.annotate({ description: `Its role on the team, e.g. "Brand designer"; 1-${roleLimit} characters.` }),
  label: Schema.optional(Schema.String).annotate({
    description: `A short subtitle shown under its name, e.g. "Logos, palettes, visual identity"; up to ${labelLimit} characters.`
  }),
  instructions: Schema.String.annotate({
    description: `The new bot's system prompt: who it is, what it does and how it works; 1-${instructionsLimit} characters.`
  }),
  tools: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: `Its built-in tools, from: ${toolIds}. Default: ${defaultTeamBotTools.join(", ")}.`
  }),
  skills: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: `Up to ${maxSkillsPerBot} skill names from find_skills (library or catalog).`
  })
})

const ProposeParams = Schema.Struct({
  name: Schema.String.annotate({ description: `The team's name, 1-${teamNameLimit} characters, not used by another team.` }),
  purpose: Schema.String.annotate({ description: `What the team is for, 1-${purposeLimit} characters.` }),
  manager: Schema.String.annotate({
    description: "Who leads the team: \"me\" (you) or the name of one of the new bots."
  }),
  bots: Schema.Array(ProposedBot).annotate({ description: `The new bots to create, 1 to ${maxNewBots}.` })
})

export interface ProposedTeamBot {
  readonly name: string
  readonly role: string
  readonly label: string
  readonly instructions: string
  readonly tools: ReadonlyArray<BuiltinTool>
  readonly skills: ReadonlyArray<string>
}

export interface Proposal {
  readonly name: string
  readonly purpose: string
  /** `me` for the proposing bot, otherwise the index of the new bot that manages the team. */
  readonly manager: "me" | number
  readonly bots: ReadonlyArray<ProposedTeamBot>
}

/** Models send null for optional fields they don't use, in each bot too. */
const normalize = (params: unknown): unknown => {
  const top = withoutNulls(params ?? {})
  if (!Predicate.isObject(top) || Array.isArray(top)) return top
  const bots = (top as Record<string, unknown>).bots
  return Array.isArray(bots) ? { ...top, bots: bots.map(withoutNulls) } : top
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/**
 * `propose_team`: proposes a team of new bots and, once the person approves, installs the catalog
 * skills they need, creates the bots, and creates the team led by the proposer or one of the new bots.
 * Always asks first, whatever the bot's approval mode.
 */
export const proposeTeamTool = (options: {
  readonly proposer: Bot
  readonly setup: TeamSetup
  readonly library: LibraryStore["Service"]
  readonly sources: SkillSources["Service"]
}): AgentTool => {
  const { proposer, setup, library, sources } = options

  /** The proposal as it would be created, or a failure listing everything to fix. */
  const check = (raw: unknown) =>
    Effect.gen(function*() {
      const params = yield* decodeParams(ProposeParams, normalize(raw))
      const [existingBots, existingTeams] = yield* Effect.all([setup.bots.list, setup.teams.list])
      const problems: Array<string> = []

      const name = params.name.trim()
      const takenTeam = existingTeams.find((team) => same(team.name, name))
      if (name.length === 0 || name.length > teamNameLimit) {
        problems.push(`Give the team a name of 1 to ${teamNameLimit} characters.`)
      } else if (takenTeam !== undefined) {
        problems.push(`There's already a team called ${takenTeam.name}; pick another name.`)
      }
      const purpose = params.purpose.trim()
      if (purpose.length === 0 || purpose.length > purposeLimit) {
        problems.push(`Give the team a purpose of 1 to ${purposeLimit} characters.`)
      }
      if (params.bots.length === 0) problems.push("Propose at least one new bot.")
      if (params.bots.length > maxNewBots) {
        problems.push(`A proposal can have at most ${maxNewBots} new bots, not ${params.bots.length}.`)
      }

      const seen = new Set<string>()
      const bots = params.bots.map((bot, index): ProposedTeamBot => {
        const botName = bot.name.trim()
        const called = botName.length > 0 ? botName : `Bot ${index + 1}`
        const existing = existingBots.find((other) => same(other.name, botName))
        if (botName.length === 0 || botName.length > botNameLimit) {
          problems.push(`Give ${called} a name of 1 to ${botNameLimit} characters.`)
        } else if (existing !== undefined) {
          problems.push(`There's already a bot called ${existing.name}; give the new one another name.`)
        } else if (seen.has(botName.toLowerCase())) {
          problems.push(`${botName} is listed twice; give each new bot its own name.`)
        }
        seen.add(botName.toLowerCase())
        const role = bot.role.trim()
        if (role.length === 0 || role.length > roleLimit) problems.push(`Give ${called} a role of 1 to ${roleLimit} characters.`)
        const label = bot.label?.trim() ?? ""
        if (label.length > labelLimit) problems.push(`${called}'s label is longer than ${labelLimit} characters.`)
        const instructions = bot.instructions.trim()
        if (instructions.length === 0) problems.push(`Give ${called} instructions: its system prompt.`)
        if (instructions.length > instructionsLimit) {
          problems.push(`${called}'s instructions are longer than ${instructionsLimit} characters; shorten them.`)
        }
        const requested = bot.tools ?? defaultTeamBotTools
        const unknownTools = requested.filter((tool) => !isTool(tool))
        if (unknownTools.length > 0) {
          problems.push(`Unknown tool for ${called}: ${unknownTools.join(", ")}. Choose from ${toolIds}.`)
        }
        const skills = [...new Set((bot.skills ?? []).map((skill) => skill.trim()).filter((skill) => skill.length > 0))]
        if (skills.length > maxSkillsPerBot) {
          problems.push(`${called} has ${skills.length} skills; give each bot at most ${maxSkillsPerBot}.`)
        }
        return { name: botName, role, label, instructions, tools: [...new Set(requested.filter(isTool))], skills }
      })

      const managerName = params.manager.trim()
      let manager: Proposal["manager"] = "me"
      if (!same(managerName, "me") && !same(managerName, proposer.name)) {
        const index = bots.findIndex((bot) => bot.name.length > 0 && same(bot.name, managerName))
        if (index === -1) {
          const names = bots.map((bot) => bot.name).filter((botName) => botName.length > 0)
          problems.push(
            `The manager has to be "me" or one of the new bots${names.length > 0 ? ` (${names.join(", ")})` : ""}, ` +
              `not ${managerName.length > 0 ? managerName : "empty"}.`
          )
        } else {
          manager = index
        }
      }

      if (problems.length > 0) {
        return yield* new ToolFailure({
          message: `The proposal needs changes:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n` +
            "Fix them and call propose_team again."
        })
      }
      return { name, purpose, manager, bots } satisfies Proposal
    })

  /** Runs one step of the setup, turning its failure or crash into a reason to report. */
  const attempt = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
    Effect.result(
      effect.pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(new ToolFailure({ message: defect instanceof Error ? defect.message : String(defect) }))
        )
      )
    )

  /** Library names for the requested skills, installing catalog ones that aren't in the library yet. */
  const resolveSkills = (wanted: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      const resolved = new Map<string, string>()
      const installed: Array<string> = []
      const skipped: Array<string> = []
      const names = yield* Effect.mapError(library.names, (error) => new ToolFailure({ message: error.message }))
      const missing: Array<string> = []
      for (const skill of wanted) {
        const found = [...names].find((name) => same(name, skill))
        if (found === undefined) missing.push(skill)
        else resolved.set(skill, found)
      }
      if (missing.length === 0) return { resolved, installed, skipped }
      const catalog = yield* sources.catalog
      for (const skill of missing) {
        const entry = catalog.skills.find((candidate) => same(candidate.name, skill))
        if (entry === undefined) {
          skipped.push(`${skill} (not found)`)
          continue
        }
        const result = yield* attempt(installFromUrl(sources, library, entry.url))
        if (result._tag === "Failure") {
          const error = result.failure
          // Installed in the meantime, e.g. by the person.
          if (error._tag === "SkillExists") resolved.set(skill, error.skill)
          else skipped.push(`${skill} (couldn't install: ${error.message})`)
        } else if (result.success.installed && result.success.skill !== null) {
          resolved.set(skill, result.success.skill.name)
          installed.push(result.success.skill.name)
        } else {
          skipped.push(`${skill} (the safety scan flagged it; the person can review and install it in the Skills library)`)
        }
      }
      return { resolved, installed, skipped }
    })

  return {
    name: proposeTeamToolName,
    description: "Propose a new team for the person: a manager and new bots, each with a role, instructions, tools " +
      "and skills. Use it when the person asks for a team (e.g. \"I need a mini team for my brand\"); look up skills " +
      "with find_skills first. The person sees the proposal and approves or declines it; nothing is created before " +
      "that. On approval the catalog skills are installed, the bots created, and the team set up with its room and " +
      `a private chat with the manager. Propose 1 to ${maxNewBots} new bots; the manager is "me" (you) or one of them.`,
    parameters: jsonSchemaOf(ProposeParams),
    needsApproval: true,
    activity: "Setting up the team",
    title: (params) => {
      const args = argsOf(params)
      const name = Predicate.isString(args.name) && args.name.trim().length > 0 ? shorten(args.name, 60) : "a team"
      const count = Array.isArray(args.bots) ? args.bots.length : 0
      return `Create team "${name}" with ${plural(count, "bot")}`
    },
    validate: (raw) => Effect.asVoid(check(raw)),
    run: (raw) =>
      Effect.gen(function*() {
        const proposal = yield* check(raw)
        const wanted = [...new Set(proposal.bots.flatMap((bot) => bot.skills))]
        const { resolved, installed, skipped } = yield* resolveSkills(wanted)

        const created: Array<{ readonly bot: Bot; readonly role: string; readonly index: number }> = []
        const notCreated: Array<string> = []
        for (const [index, proposed] of proposal.bots.entries()) {
          const librarySkills = [...new Set(proposed.skills.flatMap((skill) => resolved.get(skill) ?? []))]
          const result = yield* attempt(setup.bots.create({
            name: proposed.name,
            label: proposed.label,
            systemPrompt: proposed.instructions,
            providerId: "",
            model: "",
            ...avatarFor(index),
            tools: proposed.tools,
            approvalMode: "ask",
            librarySkills
          }))
          if (result._tag === "Success") created.push({ bot: result.success, role: proposed.role, index })
          else notCreated.push(`${proposed.name} (${result.failure.message})`)
        }
        if (created.some(({ bot }) => bot.librarySkills.length > 0)) {
          yield* setup.events.publish({ type: "skill-library-changed" })
        }

        const listed = (entries: ReadonlyArray<{ readonly bot: Bot; readonly role: string }>) =>
          entries.map(({ bot, role }) => `${bot.name} (${role})`).join(", ")
        const notes = [
          ...(installed.length > 0 ? [`Installed skills: ${installed.join(", ")}.`] : []),
          ...(skipped.length > 0 ? [`Skipped: ${skipped.join(", ")}.`] : []),
          ...(notCreated.length > 0 ? [`Couldn't create: ${notCreated.join(", ")}.`] : [])
        ]
        const createdNote = created.length > 0
          ? ` These bots were created and exist without a team: ${listed(created)}.`
          : " No bots were created."
        const failTeam = (reason: string) =>
          new ToolFailure({ message: [`Couldn't create team "${proposal.name}": ${reason}.${createdNote}`, ...notes].join(" ") })

        if (created.length === 0) return yield* failTeam("none of its bots could be created")
        const manager = proposal.manager === "me" ? proposer : created.find((entry) => entry.index === proposal.manager)?.bot
        if (manager === undefined) return yield* failTeam("its manager couldn't be created")
        const members = created.filter(({ bot }) => bot.id !== manager.id)
        const team = yield* attempt(createTeam(setup, {
          name: proposal.name,
          purpose: proposal.purpose,
          managerBotId: manager.id,
          members: members.map(({ bot, role }) => ({ botId: bot.id, role })),
          parentTeamId: null
        }))
        if (team._tag === "Failure") return yield* failTeam(team.failure.message.replace(/\.$/, ""))

        const headline = members.length > 0
          ? `Created team "${team.success.name}" (manager: ${manager.name}) with ${listed(members)}.`
          : `Created team "${team.success.name}" (manager: ${manager.name}).`
        return [headline, ...notes].join(" ")
      })
  }
}

export const teamBuilderGuidance = "When the person asks for a team, look up suitable skills with find_skills, then " +
  "propose the team with propose_team. Nothing is created until the person approves the proposal, so don't say it " +
  "exists before the result comes back."
