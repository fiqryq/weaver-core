import { Effect, Predicate, Schema } from "effect"
import type { Bot } from "../../features/bots/Bot.ts"
import { type Team, teamSlug } from "../../features/teams/Team.ts"
import { truncate } from "../../platform/lib/util.ts"
import { type AgentTool, decodeParams, jsonSchemaOf, shorten, ToolFailure } from "../AgentTool.ts"
import { noteTime } from "./AskBot.ts"

/** A team member with its bot loaded. */
export interface Staffed {
  readonly bot: Bot
  readonly role: string
}

/** A subgroup with its lead loaded. */
export interface Subgroup {
  readonly team: Team
  readonly lead: Bot
}

export const teamToolNames = {
  brief: "brief_team",
  status: "team_status",
  askMember: "ask_member",
  openRound: "open_round",
  delegate: "delegate_to_subgroup",
  decision: "report_decision",
  askPerson: "ask_person",
  finish: "finish_task",
  reportUp: "report_up"
} as const

const noteTextLimit = 4000

const normalized = (text: string) => text.trim().replace(/^@/, "").toLowerCase()

/** A member by bot id, name or role, ignoring case and a leading `@`. */
export const findMember = (members: ReadonlyArray<Staffed>, query: string): Staffed | undefined => {
  const wanted = normalized(query)
  return members.find((member) => member.bot.id === query.trim()) ??
    members.find((member) => member.bot.name.trim().toLowerCase() === wanted) ??
    members.find((member) => member.role.trim().toLowerCase() === wanted)
}

export const findSubgroup = (subgroups: ReadonlyArray<Subgroup>, query: string): Subgroup | undefined => {
  const wanted = normalized(query)
  return subgroups.find((subgroup) => subgroup.team.id === query.trim()) ??
    subgroups.find((subgroup) => subgroup.team.name.trim().toLowerCase() === wanted)
}

export const memberLabel = (member: Staffed): string => `${member.bot.name} (${member.role})`

const roster = (members: ReadonlyArray<Staffed>): string =>
  members.length === 0 ? "none yet" : members.map((member) => `${member.bot.name} — ${member.role}`).join("; ")

const stringArg = (params: unknown, key: string): string => {
  const value = Predicate.isObject(params) ? (params as Record<string, unknown>)[key] : undefined
  return Predicate.isString(value) ? value : ""
}

const tool = <S extends Schema.Top & { readonly DecodingServices: never }>(spec: {
  readonly name: string
  readonly description: string
  readonly params: S
  readonly activity: string
  readonly title: (params: unknown) => string
  readonly run: (params: S["Type"]) => Effect.Effect<string, ToolFailure>
}): AgentTool => ({
  name: spec.name,
  description: spec.description,
  parameters: jsonSchemaOf(spec.params),
  needsApproval: false,
  activity: spec.activity,
  title: spec.title,
  run: (raw) => Effect.flatMap(decodeParams(spec.params, raw), spec.run)
})

const required = (value: string, what: string) =>
  value.trim().length === 0 ? Effect.fail(new ToolFailure({ message: `The ${what} is empty.` })) : Effect.succeed(value.trim())

const BriefParams = Schema.Struct({
  task: Schema.String.annotate({ description: "A short title for the task, e.g. \"Login screen\"." }),
  brief: Schema.String.annotate({
    description: "A self-contained summary of what the person wants, with every spec and answer they gave in this chat. " +
      "The team can't see this chat."
  })
})

export const briefTeamTool = (options: {
  readonly team: string
  readonly brief: (task: string, brief: string) => Effect.Effect<string, ToolFailure>
}): AgentTool =>
  tool({
    name: teamToolNames.brief,
    description: `Hand work to ${options.team}, or send them the person's answers and new specs. Posts your brief in the ` +
      `team room and returns at once; the team works in the background and its reports appear in this chat.`,
    params: BriefParams,
    activity: "Briefing the team",
    title: (params) => {
      const task = shorten(stringArg(params, "task"), 60)
      return task.length > 0 ? `Briefed ${options.team}: ${task}` : `Briefed ${options.team}`
    },
    run: (params) =>
      Effect.gen(function*() {
        const task = yield* required(params.task, "task")
        const brief = yield* required(params.brief, "brief")
        return yield* options.brief(task, brief)
      })
  })

export const teamStatusTool = (options: { readonly team: string; readonly status: Effect.Effect<string> }): AgentTool =>
  tool({
    name: teamToolNames.status,
    description: `How ${options.team} is doing: its status, task, latest room messages and decisions.`,
    params: Schema.Struct({}),
    activity: "Checking on the team",
    title: () => `Checked on ${options.team}`,
    run: () => options.status
  })

const AskMemberParams = Schema.Struct({
  member: Schema.String.annotate({ description: "The member to ask, by name or role." }),
  message: Schema.String.annotate({ description: "What you need from them." })
})

export const askMemberTool = (options: {
  readonly members: ReadonlyArray<Staffed>
  readonly ask: (member: Staffed, message: string) => Effect.Effect<string, ToolFailure>
}): AgentTool => {
  const { members } = options
  return tool({
    name: teamToolNames.askMember,
    description: `Ask one member of your team, in the team room, and get their reply. Members: ${roster(members)}. ` +
      `They see the whole room.`,
    params: AskMemberParams,
    activity: "Asking a member",
    title: (params) => {
      const query = stringArg(params, "member")
      const name = findMember(members, query)?.bot.name ?? (query.trim() || "a member")
      const message = shorten(stringArg(params, "message"), 60)
      return message.length > 0 ? `Asked ${name}: ${message}` : `Asked ${name}`
    },
    run: (params) =>
      Effect.gen(function*() {
        const member = findMember(members, params.member)
        if (member === undefined) {
          return yield* new ToolFailure({
            message: `${params.member.trim() || "That"} isn't on your team. Members: ${roster(members)}.`
          })
        }
        return yield* options.ask(member, yield* required(params.message, "message"))
      })
  })
}

const OpenRoundParams = Schema.Struct({
  topic: Schema.String.annotate({ description: "What to discuss." }),
  members: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Who answers, by name or role, in order; everyone when left out."
  })
})

export const openRoundTool = (options: {
  readonly members: ReadonlyArray<Staffed>
  readonly round: (topic: string, members: ReadonlyArray<Staffed>) => Effect.Effect<string, ToolFailure>
}): AgentTool => {
  const { members } = options
  return tool({
    name: teamToolNames.openRound,
    description: `Discuss a topic in the team room: each member answers in turn, seeing the earlier answers. ` +
      `Good for brainstorming and reviews. Members: ${roster(members)}.`,
    params: OpenRoundParams,
    activity: "Running a round",
    title: (params) => {
      const topic = shorten(stringArg(params, "topic"), 60)
      return topic.length > 0 ? `Opened a round: ${topic}` : "Opened a round"
    },
    run: (params) =>
      Effect.gen(function*() {
        const topic = yield* required(params.topic, "topic")
        if (members.length === 0) return yield* new ToolFailure({ message: "Your team has no members yet." })
        const listed = params.members ?? []
        const chosen: Array<Staffed> = []
        for (const query of listed) {
          const member = findMember(members, query)
          if (member === undefined) {
            return yield* new ToolFailure({ message: `${query.trim() || "That"} isn't on your team. Members: ${roster(members)}.` })
          }
          if (!chosen.includes(member)) chosen.push(member)
        }
        return yield* options.round(topic, chosen.length > 0 ? chosen : members)
      })
  })
}

const DelegateParams = Schema.Struct({
  subgroup: Schema.String.annotate({ description: "The subgroup, by name." }),
  brief: Schema.String.annotate({ description: "A self-contained brief: the goal, specs and constraints." })
})

export const delegateTool = (options: {
  readonly subgroups: ReadonlyArray<Subgroup>
  readonly delegate: (subgroup: Subgroup, brief: string) => Effect.Effect<string, ToolFailure>
}): AgentTool => {
  const { subgroups } = options
  const names = subgroups.map((subgroup) => `${subgroup.team.name} (led by ${subgroup.lead.name})`).join("; ")
  return tool({
    name: teamToolNames.delegate,
    description: `Hand part of the work to a subgroup. It works in its own room until its lead reports back, ` +
      `and you get the report. Subgroups: ${names}.`,
    params: DelegateParams,
    activity: "Waiting for a subgroup",
    title: (params) => {
      const query = stringArg(params, "subgroup")
      return `Delegated to ${findSubgroup(subgroups, query)?.team.name ?? (query.trim() || "a subgroup")}`
    },
    run: (params) =>
      Effect.gen(function*() {
        const subgroup = findSubgroup(subgroups, params.subgroup)
        if (subgroup === undefined) {
          return yield* new ToolFailure({ message: `${params.subgroup.trim() || "That"} isn't a subgroup. Subgroups: ${names}.` })
        }
        return yield* options.delegate(subgroup, yield* required(params.brief, "brief"))
      })
  })
}

const DecisionParams = Schema.Struct({
  decision: Schema.String.annotate({ description: "The decision, starting with a short line that sums it up." }),
  rationale: Schema.optional(Schema.String).annotate({ description: "Why, briefly." })
})

export const reportDecisionTool = (options: {
  readonly report: (decision: string, rationale: string | undefined) => Effect.Effect<string, ToolFailure>
}): AgentTool =>
  tool({
    name: teamToolNames.decision,
    description: "Tell the person about a decision the team made. It appears as a card in their chat with you.",
    params: DecisionParams,
    activity: "Reporting a decision",
    title: (params) => {
      const decision = shorten(stringArg(params, "decision"), 60)
      return decision.length > 0 ? `Reported: ${decision}` : "Reported a decision"
    },
    run: (params) =>
      Effect.gen(function*() {
        const decision = yield* required(params.decision, "decision")
        const rationale = params.rationale?.trim()
        return yield* options.report(decision, rationale === undefined || rationale.length === 0 ? undefined : rationale)
      })
  })

const textTool = (spec: {
  readonly name: string
  readonly description: string
  readonly field: string
  readonly fieldDescription: string
  readonly activity: string
  readonly title: (text: string) => string
  readonly run: (text: string) => Effect.Effect<string, ToolFailure>
}): AgentTool =>
  tool({
    name: spec.name,
    description: spec.description,
    params: Schema.Struct({ [spec.field]: Schema.String.annotate({ description: spec.fieldDescription }) }),
    activity: spec.activity,
    title: (params) => spec.title(shorten(stringArg(params, spec.field), 60)),
    run: (params) => Effect.flatMap(required(String((params as Record<string, unknown>)[spec.field] ?? ""), spec.field), spec.run)
  })

export const askPersonTool = (options: { readonly ask: (question: string) => Effect.Effect<string, ToolFailure> }) =>
  textTool({
    name: teamToolNames.askPerson,
    description: "Ask the person a question when the team is blocked. The team pauses until they answer.",
    field: "question",
    fieldDescription: "The question, with the context they need to answer it.",
    activity: "Asking the person",
    title: (question) => (question.length > 0 ? `Asked the person: ${question}` : "Asked the person"),
    run: options.ask
  })

export const finishTaskTool = (options: { readonly finish: (summary: string) => Effect.Effect<string, ToolFailure> }) =>
  textTool({
    name: teamToolNames.finish,
    description: "Finish the task when the goal is met: the summary goes to the person and the team stops.",
    field: "summary",
    fieldDescription: "What the team did and decided, and anything the person should do next.",
    activity: "Finishing the task",
    title: () => "Finished the task",
    run: options.finish
  })

export const reportUpTool = (options: {
  readonly manager: string
  readonly report: (summary: string) => Effect.Effect<string, ToolFailure>
}) =>
  textTool({
    name: teamToolNames.reportUp,
    description: `Report back to ${options.manager} and end the subgroup's work: when the goal is met, or when you're ` +
      `blocked or need an answer.`,
    field: "summary",
    fieldDescription: "What the subgroup did and decided, and any open questions.",
    activity: "Reporting up",
    title: () => `Reported to ${options.manager}`,
    run: options.report
  })

const statusLine = (team: Team): string => {
  const task = team.task === null ? "" : ` on "${team.task.title}"`
  switch (team.status) {
    case "idle":
      return `Right now ${team.name} is idle.`
    case "working":
      return `Right now ${team.name} is working${task}.`
    case "waiting":
      return `Right now ${team.name} is waiting${task} for the person's answer to its question; relay the answer with brief_team.`
    case "interrupted":
      return `Right now ${team.name} is interrupted${task} by a server restart; brief_team continues it.`
  }
}

/** The manager's instructions in the team's private chat. */
export const privateChatPrompt = (input: {
  readonly team: Team
  readonly members: ReadonlyArray<Staffed>
  readonly subgroups: ReadonlyArray<Subgroup>
}): string => {
  const { team } = input
  const purpose = team.purpose.trim().length > 0 ? ` (${team.purpose.trim()})` : ""
  const subgroups = input.subgroups.length > 0
    ? ` Subgroups: ${input.subgroups.map((subgroup) => `${subgroup.team.name} led by ${subgroup.lead.name}`).join("; ")}.`
    : ""
  return `## Your team\nYou manage team ${team.name}${purpose}. Members: ${roster(input.members)}.${subgroups} ` +
    `The person gives you tasks here. Hand work to the team with brief_team: include everything the person asked for, ` +
    `since the team can't see this chat. Relay the person's answers and new specs with brief_team. Use team_status ` +
    `when asked how it's going. Keep replies short; the team's reports appear here as cards. ${statusLine(team)}`
}

const briefsNote = "Briefs in this room ([Brief]) carry the person's instructions; the latest one is current."

/** The manager's instructions while leading a session in the team room. */
export const sessionPrompt = (input: {
  readonly team: Team
  readonly members: ReadonlyArray<Staffed>
  readonly subgroups: ReadonlyArray<Subgroup>
}): string => {
  const { team } = input
  const task = team.task?.title ?? "the latest brief"
  const delegate = input.subgroups.length > 0
    ? ` delegate_to_subgroup for ${input.subgroups.map((subgroup) => subgroup.team.name).join(", ")},`
    : ""
  return `## Team session\nYou're leading ${team.name} on: ${task}. Plan the work, ask members by role with ask_member, ` +
    `use open_round to brainstorm,${delegate} decide. Report every decision to the person with report_decision. Ask the ` +
    `person with ask_person only when the team is blocked. When the goal is met, call finish_task with a clear summary.\n\n` +
    `Members: ${roster(input.members)}. ${briefsNote}`
}

/** A subgroup lead's instructions while leading the subgroup in its room. */
export const leadPrompt = (input: {
  readonly team: Team
  readonly parent: Team
  readonly parentManager: string
  readonly members: ReadonlyArray<Staffed>
}): string => {
  const { team } = input
  const task = team.task?.title ?? "the latest brief"
  return `## Team session\nYou're leading ${team.name}, a subgroup of ${input.parent.name}, on: ${task}. Plan the work, ` +
    `ask members by role with ask_member, use open_round to brainstorm, decide. You can't ask the person: when the goal ` +
    `is met, or the subgroup is blocked or needs an answer, call report_up with a clear summary for ` +
    `${input.parentManager}, including decisions and open questions.\n\nMembers: ${roster(input.members)}. ${briefsNote}`
}

/** A member's instructions when answering in a team room. */
export const memberPrompt = (input: { readonly role: string; readonly team: string; readonly manager: string }): string =>
  `## Your team\nYou're ${input.role} on team ${input.team}, led by ${input.manager}. Answer the manager from your role's ` +
  `perspective, build on teammates' points, be concise and concrete. You can use your tools.`

export const nudges = {
  start: "Lead the team on the brief above.",
  update: "The person sent an update in the latest brief; continue the task with it.",
  continue: "Continue leading the team: ask members, report decisions, ask the person if blocked, or finish the task.",
  continueSubgroup: "Continue leading the subgroup: ask members, decide, or report_up when you're done or blocked.",
  interrupted: "You were interrupted; continue the task.",
  resumed: "The person asked you to continue; carry on with the task.",
  report: (steps: number) =>
    `You've taken ${steps} steps since your last report. Report progress to the person with report_decision, ` +
    `or ask them with ask_person if you're stuck.`,
  reportUp: (steps: number) => `You've taken ${steps} steps. Wrap up and report_up with what you have and what's open.`
}

export const pauseQuestion = (task: string): string =>
  `We've been working on ${task} for a while without a decision. Should we keep going?`

export const problemQuestion = (team: string, reason: string): string => `${team} hit a problem: ${reason}. Should we retry?`

/** Where a team's notes go in memory. */
export const teamDirectory = (team: string): string => `weaver/teams/${teamSlug(team)}`

interface TeamNote {
  readonly title: string
  readonly directory: string
  readonly content: string
  readonly tags: Array<string>
}

const relations = (team: string, manager: string) => `## Relations\n- part_of [[${team}]]\n- decided_by [[${manager}]]`

/** `write_note` arguments for a decision the team reported. */
export const decisionNote = (input: {
  readonly team: string
  readonly manager: string
  readonly decision: string
  readonly rationale: string | undefined
  readonly task: string
  readonly at: Date
}): TeamNote => {
  const sections = [
    `## Decision\n${truncate(input.decision, noteTextLimit)}`,
    ...(input.rationale === undefined ? [] : [`## Rationale\n${truncate(input.rationale, noteTextLimit)}`]),
    `## Task\n${input.task}`,
    relations(input.team, input.manager)
  ]
  return {
    title: `${input.team} decision: ${shorten(input.decision, 60)} (${noteTime(input.at)})`,
    directory: teamDirectory(input.team),
    content: `${sections.join("\n\n")}\n`,
    tags: ["team", teamSlug(input.team)]
  }
}

/** `write_note` arguments for the summary of a finished task. */
export const summaryNote = (input: {
  readonly team: string
  readonly manager: string
  readonly summary: string
  readonly task: string
  readonly at: Date
}): TeamNote => ({
  title: `${input.team} summary: ${shorten(input.task, 60)} (${noteTime(input.at)})`,
  directory: teamDirectory(input.team),
  content: `${
    [`## Summary\n${truncate(input.summary, noteTextLimit)}`, `## Task\n${input.task}`, relations(input.team, input.manager)]
      .join("\n\n")
  }\n`,
  tags: ["team", teamSlug(input.team)]
})
