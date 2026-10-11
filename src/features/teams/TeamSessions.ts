import { Cause, Clock, Context, Effect, Exit, FiberMap, FiberSet, Layer, Option, Semaphore } from "effect"
import { AppConfig } from "../../config/Config.ts"
import { Conflict } from "../../platform/http/errors.ts"
import { nowIso } from "../../platform/lib/util.ts"
import { type AgentTool, shorten, ToolFailure } from "../../tools/AgentTool.ts"
import { Camofox } from "../../tools/builtin/Camofox.ts"
import { botMemoryProject, memoryServerConfig, noteWriteError, pinProject } from "../../tools/builtin/Memory.ts"
import {
  askMemberTool,
  askPersonTool,
  briefTeamTool,
  decisionNote,
  delegateTool,
  finishTaskTool,
  leadPrompt,
  memberLabel,
  memberPrompt,
  nudges,
  openRoundTool,
  pauseQuestion,
  privateChatPrompt,
  problemQuestion,
  reportDecisionTool,
  reportUpTool,
  sessionPrompt,
  type Staffed,
  type Subgroup,
  summaryNote,
  teamStatusTool
} from "../../tools/builtin/Team.ts"
import type { Bot } from "../bots/Bot.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import { type Message, type MessagePart, messageText } from "../conversations/Conversation.ts"
import { ConversationRepo } from "../conversations/ConversationRepo.ts"
import { McpHub } from "../integrations/McpHub.ts"
import { AgentRunner, type ReplyOptions } from "../runs/AgentRunner.ts"
import { describeError } from "../runs/AgentRunnerLive.ts"
import { promptText } from "../runs/PromptBuilder.ts"
import { RunEvents } from "../runs/RunEvents.ts"
import { privateTitle, roomTitle, type Team, TeamNotFound, type TeamStatus, type TeamTask } from "./Team.ts"
import { TeamRepo } from "./TeamRepo.ts"

/** How a manager's stretch of work in a room ended. */
type Outcome =
  | { readonly _tag: "finished" }
  | { readonly _tag: "asked" }
  | { readonly _tag: "reported"; readonly summary: string }
  | { readonly _tag: "paused" }
  | { readonly _tag: "failed"; readonly reason: string }
  | { readonly _tag: "stopped" }

const stopped: Outcome = { _tag: "stopped" }
const paused: Outcome = { _tag: "paused" }
const failed = (reason: string): Outcome => ({ _tag: "failed", reason })

const visible = (message: Message) => message.status !== "streaming" && message.status !== "error"
const firstLine = (text: string) => text.trim().split("\n")[0] ?? ""

/**
 * Runs teams' sessions in the background: the manager leads the team in its room, turn by turn,
 * until it finishes, asks the person, or the person stops it. Each manager turn is a normal reply in
 * the room with the session's tools; members answer with their own replies there.
 */
export class TeamSessions extends Context.Service<TeamSessions, {
  /** Posts the brief in the room and starts a session, or hands it to the one that's running. */
  brief(teamId: string, task: string, brief: string): Effect.Effect<string>
  stop(teamId: string): Effect.Effect<Team, TeamNotFound>
  resume(teamId: string): Effect.Effect<Team, TeamNotFound | Conflict>
  /** Stops the team, then deletes it with its subgroups and all their conversations. */
  remove(teamId: string): Effect.Effect<void, TeamNotFound>
  /** Sets the bots and titles of the team's conversations, and its subgroups', from the team. */
  sync(teamId: string): Effect.Effect<void>
  /** Keeps private chat titles current after a bot is renamed. */
  botRenamed(botId: string): Effect.Effect<void>
  /** Takes a deleted bot off the teams it was a member of. */
  botRemoved(botId: string): Effect.Effect<void>
  isWorking(teamId: string): Effect.Effect<boolean>
}>()("weaver/TeamSessions") {
  static readonly layer = Layer.effect(
    TeamSessions,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const teams = yield* TeamRepo
      const bots = yield* BotRepo
      const conversations = yield* ConversationRepo
      const runner = yield* AgentRunner
      const events = yield* RunEvents
      const hub = yield* McpHub
      const camofox = yield* Camofox
      const sessions = yield* FiberMap.make<string>()
      const notes = yield* FiberSet.make<void, never>()
      /** Top-level teams with a session that hasn't settled yet. */
      const active = new Set<string>()
      /** Teams sent a brief their running session hasn't started a turn with yet. */
      const pending = new Set<string>()
      const locks = new Map<string, Semaphore.Semaphore>()
      const lockFor = (teamId: string) => {
        let lock = locks.get(teamId)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          locks.set(teamId, lock)
        }
        return lock
      }

      const changed = (teamId: string) => events.publish({ type: "team-changed", teamId })
      const setState = (teamId: string, patch: { status: TeamStatus; task?: TeamTask | null }) =>
        Effect.tap(Effect.orDie(teams.update(teamId, patch)), changed(teamId))
      const activity = (conversationId: string | null, text: string) =>
        conversationId === null ? Effect.void : events.publish({ type: "activity", conversationId, text })

      const post = (conversationId: string | null, from: Bot | undefined, parts: ReadonlyArray<MessagePart>, fallbackName = "") =>
        Effect.gen(function*() {
          if (conversationId === null) return
          const message = yield* conversations.insertMessage({
            conversationId,
            role: "assistant",
            botId: from?.id ?? null,
            senderName: from?.name ?? fallbackName,
            parts
          })
          yield* events.publish({ type: "message-created", conversationId, message })
        })
      const text = (value: string): ReadonlyArray<MessagePart> => [{ type: "text", text: value }]

      const staff = (team: Team) =>
        Effect.map(
          Effect.forEach(team.members, (member) =>
            Effect.map(Effect.option(bots.get(member.botId)), Option.map((bot): Staffed => ({ bot, role: member.role })))),
          (found) => found.flatMap(Option.toArray)
        )

      const subgroupsOf = (team: Team) =>
        Effect.flatMap(teams.subgroupsOf(team.id), (subgroups) =>
          Effect.map(
            Effect.forEach(subgroups, (subgroup) =>
              Effect.map(Effect.option(bots.get(subgroup.managerBotId)), Option.map((lead): Subgroup => ({ team: subgroup, lead })))),
            (found) => found.flatMap(Option.toArray)
          ))

      const write = (note: { title: string }, manager: Bot) =>
        Effect.gen(function*() {
          if (Option.isNone(config.memory)) return
          const memory = config.memory.value
          const result = yield* hub.call(
            memoryServerConfig(memory),
            "write_note",
            pinProject({ ...note, output_format: "json" }, botMemoryProject(manager, memory.project))
          )
          const error = result.isError ? result.text : noteWriteError(result.text)
          if (error !== undefined) yield* Effect.logWarning(`Couldn't save the team note "${note.title}": ${error}`)
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning("Couldn't save a team note", cause)
          )
        )
      const saveNote = (manager: Bot, note: (at: Date) => { title: string }) =>
        Effect.gen(function*() {
          if (Option.isNone(config.memory) || !(manager.tools as ReadonlyArray<string>).includes("memory")) return
          const at = new Date(yield* Clock.currentTimeMillis)
          yield* FiberSet.run(notes, write(note(at), manager))
        })

      /** A member's reply in the room, as the text the manager gets back. */
      const answerFrom = (room: Parameters<typeof runner.delegate>[0], member: Staffed, options: ReplyOptions) =>
        Effect.gen(function*() {
          const exit = yield* runner.delegate(room, member.bot, options)
          const name = member.bot.name
          const fail = (message: string) => Effect.fail(new ToolFailure({ message }))
          if (Exit.isFailure(exit)) {
            return yield* fail(
              Cause.hasInterruptsOnly(exit.cause)
                ? `${name}'s reply was stopped before it finished.`
                : `${name} couldn't answer: ${describeError(Cause.squash(exit.cause))}`
            )
          }
          const answer = exit.value
          if (answer === undefined) return yield* fail(`${name}'s reply was deleted before it finished.`)
          if (answer.status !== "done") return yield* fail(`${name} couldn't answer: ${answer.error ?? "the reply didn't finish"}`)
          return messageText(answer.parts)
        })

      /** Whether the manager spoke last, so its next turn needs a user turn to answer. */
      const spokeLast = (history: ReadonlyArray<Message>, manager: Bot) => {
        const last = history.findLast((message) => visible(message) && promptText(message.parts).length > 0)
        return last === undefined || (last.role === "assistant" && last.botId === manager.id)
      }

      /** The manager (or a subgroup's lead) leading the team in its room until something ends the work. */
      const lead = (teamId: string, firstNudge: string | undefined): Effect.Effect<Outcome> =>
        Effect.gen(function*() {
          let nudge = firstNudge
          let sinceReport = 0
          for (;;) {
            const team = yield* Effect.orDie(teams.get(teamId))
            const parent = team.parentTeamId === null ? undefined : yield* Effect.orDie(teams.get(team.parentTeamId))
            const top = parent ?? team
            const found = yield* Effect.option(bots.get(team.managerBotId))
            if (Option.isNone(found)) return failed("its manager was deleted")
            const manager = found.value
            const reportsTo = parent === undefined ? "" : Option.match(yield* Effect.option(bots.get(parent.managerBotId)), {
              onNone: () => parent.name,
              onSome: (bot) => bot.name
            })
            const members = yield* staff(team)
            const subgroups = parent === undefined ? yield* subgroupsOf(team) : []
            const room = yield* Effect.orDie(conversations.get(team.roomConversationId))
            const privateId = top.privateConversationId
            const task = team.task?.title ?? "the task"

            const working = activity(privateId, `${team.name} is working`)
            const onApproval = (waiting: boolean) =>
              waiting ? activity(privateId, `Waiting for your approval in ${team.name}'s room`) : working
            const turn: { sessionTool: boolean; reported: boolean; end: Outcome | undefined } = {
              sessionTool: false,
              reported: false,
              end: undefined
            }
            const ask = (member: Staffed) =>
              answerFrom(room, member, {
                instructions: memberPrompt({ role: member.role, team: team.name, manager: manager.name }),
                onApproval
              })

            const tools: Array<AgentTool> = [
              askMemberTool({
                members,
                ask: (member, message) =>
                  Effect.gen(function*() {
                    yield* post(room.id, manager, text(`@${member.bot.name} ${message}`))
                    const answer = yield* ask(member)
                    turn.sessionTool = true
                    return `${memberLabel(member)} replied:\n\n${answer}`
                  })
              }),
              openRoundTool({
                members,
                round: (topic, chosen) =>
                  Effect.gen(function*() {
                    yield* post(room.id, manager, text(topic))
                    const replies: Array<string> = []
                    for (const member of chosen) {
                      const answer = yield* Effect.result(ask(member))
                      if (answer._tag === "Success") turn.sessionTool = true
                      replies.push(
                        answer._tag === "Success"
                          ? `${memberLabel(member)}:\n${answer.success}`
                          : `${memberLabel(member)} couldn't answer: ${answer.failure.message}`
                      )
                    }
                    return replies.join("\n\n")
                  })
              })
            ]
            if (subgroups.length > 0) {
              tools.push(delegateTool({
                subgroups,
                delegate: (subgroup, brief) =>
                  Effect.gen(function*() {
                    const sub = subgroup.team
                    const title = shorten(brief, 60)
                    yield* setState(sub.id, { status: "working", task: { title, startedAt: yield* nowIso } })
                    yield* post(sub.roomConversationId, manager, [{ type: "report", kind: "brief", teamId: sub.id, title, text: brief }])
                    const outcome = yield* lead(sub.id, nudges.start).pipe(
                      Effect.ensuring(Effect.ignore(Effect.tap(teams.update(sub.id, { status: "idle", task: null }), changed(sub.id))))
                    )
                    switch (outcome._tag) {
                      case "reported": {
                        yield* post(room.id, subgroup.lead, text(`Report from ${sub.name}:\n\n${outcome.summary}`))
                        turn.sessionTool = true
                        return `${subgroup.lead.name} reported for ${sub.name}:\n\n${outcome.summary}`
                      }
                      case "paused":
                        return yield* new ToolFailure({
                          message: `${sub.name} took ${config.teamPauseSteps} steps without reporting back, so it stopped.`
                        })
                      case "failed":
                        return yield* new ToolFailure({ message: `${sub.name} hit a problem: ${outcome.reason}` })
                      default:
                        return yield* new ToolFailure({ message: `${sub.name} was stopped before it reported.` })
                    }
                  })
              }))
            }
            if (parent === undefined) {
              tools.push(
                reportDecisionTool({
                  report: (decision, rationale) =>
                    Effect.gen(function*() {
                      yield* post(privateId, manager, [{
                        type: "report",
                        kind: "decision",
                        teamId: team.id,
                        title: shorten(firstLine(decision), 80),
                        text: rationale === undefined ? decision : `${decision}\n\n${rationale}`
                      }])
                      yield* post(room.id, manager, text(`Decision: ${shorten(decision, 200)}`))
                      yield* saveNote(manager, (at) =>
                        decisionNote({ team: team.name, manager: manager.name, decision, rationale, task, at }))
                      turn.reported = true
                      turn.sessionTool = true
                      return "Reported the decision to the person."
                    })
                }),
                askPersonTool({
                  ask: (question) =>
                    Effect.gen(function*() {
                      yield* post(privateId, manager, [{ type: "report", kind: "question", teamId: team.id, title: null, text: question }])
                      turn.end = { _tag: "asked" }
                      turn.sessionTool = true
                      return "Asked the person. The team pauses until they answer."
                    })
                }),
                finishTaskTool({
                  finish: (summary) =>
                    Effect.gen(function*() {
                      yield* post(privateId, manager, [{ type: "report", kind: "summary", teamId: team.id, title: task, text: summary }])
                      yield* saveNote(manager, (at) => summaryNote({ team: team.name, manager: manager.name, summary, task, at }))
                      turn.end = { _tag: "finished" }
                      turn.sessionTool = true
                      return "Sent the summary to the person. The task is done."
                    })
                })
              )
            } else {
              tools.push(reportUpTool({
                manager: reportsTo,
                report: (summary) =>
                  Effect.sync(() => {
                    turn.end = { _tag: "reported", summary }
                    turn.sessionTool = true
                    return `Reported to ${reportsTo}.`
                  })
              }))
            }

            const instructions = parent === undefined
              ? sessionPrompt({ team, members, subgroups })
              : leadPrompt({ team, parent, parentManager: reportsTo, members })

            yield* working
            pending.delete(team.id)
            if (nudge === undefined && spokeLast(yield* conversations.messages(room.id), manager)) {
              nudge = parent === undefined ? nudges.continue : nudges.continueSubgroup
            }
            const exit = yield* runner.delegate(room, manager, {
              tools,
              instructions,
              ...(nudge === undefined ? {} : { nudge }),
              onApproval,
              endAfterRound: () => turn.sessionTool
            })
            nudge = undefined

            if (Exit.isFailure(exit)) {
              return Cause.hasInterruptsOnly(exit.cause) ? stopped : failed(describeError(Cause.squash(exit.cause)))
            }
            if (turn.end !== undefined) return turn.end
            const message = exit.value
            if (message === undefined || message.status === "cancelled") return stopped
            if (message.status === "error") return failed(message.error ?? "the reply failed")

            sinceReport = turn.reported ? 0 : sinceReport + 1
            if (sinceReport >= config.teamPauseSteps) return paused
            if (sinceReport === config.teamNudgeSteps) {
              nudge = parent === undefined ? nudges.report(sinceReport) : nudges.reportUp(sinceReport)
            }
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(failed(describeError(Cause.squash(cause))))
          )
        )

      /** Records how a top-level session ended; true when a brief arrived meanwhile and it should go on. */
      const settle = (teamId: string, outcome: Outcome) =>
        Effect.gen(function*() {
          if ((outcome._tag === "finished" || outcome._tag === "asked") && pending.has(teamId)) {
            pending.delete(teamId)
            return true
          }
          active.delete(teamId)
          pending.delete(teamId)
          const found = yield* Effect.option(teams.get(teamId))
          if (Option.isNone(found)) return false
          const team = found.value
          const manager = Option.getOrUndefined(yield* Effect.option(bots.get(team.managerBotId)))
          const question = (value: string) =>
            post(team.privateConversationId, manager, [{ type: "report", kind: "question", teamId, title: null, text: value }], team.name)
          switch (outcome._tag) {
            case "finished":
            case "reported":
              yield* setState(teamId, { status: "idle", task: null })
              break
            case "asked":
              yield* setState(teamId, { status: "waiting" })
              break
            case "paused":
              yield* question(pauseQuestion(team.task?.title ?? "this task"))
              yield* setState(teamId, { status: "waiting" })
              break
            case "failed":
              yield* question(problemQuestion(team.name, outcome.reason))
              yield* setState(teamId, { status: "waiting" })
              break
            case "stopped":
              yield* post(team.roomConversationId, manager, text("Stopped by you."), team.name)
              yield* setState(teamId, { status: "idle", task: null })
              break
          }
          yield* activity(team.privateConversationId, "")
          return false
        })

      const session = (teamId: string, firstNudge: string) =>
        Effect.gen(function*() {
          let nudge = firstNudge
          for (;;) {
            const outcome = yield* lead(teamId, nudge)
            if (!(yield* lockFor(teamId).withPermit(settle(teamId, outcome)))) return
            nudge = nudges.update
          }
        })

      const startSession = (teamId: string, nudge: string) =>
        Effect.suspend(() => {
          active.add(teamId)
          return Effect.asVoid(FiberMap.run(sessions, teamId, session(teamId, nudge)))
        })

      const brief = (teamId: string, task: string, briefText: string) =>
        lockFor(teamId).withPermit(Effect.gen(function*() {
          const team = yield* Effect.orDie(teams.get(teamId))
          const manager = Option.getOrUndefined(yield* Effect.option(bots.get(team.managerBotId)))
          yield* post(team.roomConversationId, manager, [{ type: "report", kind: "brief", teamId, title: task, text: briefText }], team.name)
          if (active.has(teamId)) {
            pending.add(teamId)
            return `Sent the update to ${team.name}.`
          }
          const fresh = team.status === "idle" || team.task === null
          yield* setState(teamId, { status: "working", task: fresh ? { title: task, startedAt: yield* nowIso } : team.task })
          yield* startSession(teamId, fresh ? nudges.start : nudges.update)
          return `${team.name} is on it. Reports will appear here.`
        }))

      const stop = Effect.fn("TeamSessions.stop")(function*(teamId: string) {
        const team = yield* teams.get(teamId)
        if (team.parentTeamId !== null) {
          // A subgroup only works inside its parent's session; stopping its room ends that delegation.
          yield* runner.cancelConversation(team.roomConversationId)
          return team.status === "idle" ? team : yield* setState(teamId, { status: "idle", task: null })
        }
        yield* FiberMap.remove(sessions, teamId)
        return yield* lockFor(teamId).withPermit(Effect.gen(function*() {
          active.delete(teamId)
          pending.delete(teamId)
          const current = yield* teams.get(teamId)
          yield* activity(current.privateConversationId, "")
          if (current.status === "idle") return current
          const manager = Option.getOrUndefined(yield* Effect.option(bots.get(current.managerBotId)))
          yield* post(current.roomConversationId, manager, text("Stopped by you."), current.name)
          for (const subgroup of yield* teams.subgroupsOf(teamId)) {
            if (subgroup.status !== "idle") yield* setState(subgroup.id, { status: "idle", task: null })
          }
          return yield* setState(teamId, { status: "idle", task: null })
        }))
      })

      const resume = Effect.fn("TeamSessions.resume")(function*(teamId: string) {
        yield* teams.get(teamId)
        return yield* lockFor(teamId).withPermit(Effect.gen(function*() {
          const team = yield* teams.get(teamId)
          if ((team.status !== "interrupted" && team.status !== "waiting") || team.parentTeamId !== null || active.has(teamId)) {
            return yield* new Conflict({ message: `${team.name} isn't waiting or interrupted, so there's nothing to resume.` })
          }
          const updated = yield* setState(teamId, { status: "working" })
          yield* startSession(teamId, team.status === "interrupted" ? nudges.interrupted : nudges.resumed)
          return updated
        }))
      })

      const removeConversation = (conversationId: string | null) =>
        Effect.gen(function*() {
          if (conversationId === null) return
          const conversation = yield* Effect.option(conversations.get(conversationId))
          if (Option.isNone(conversation)) return
          yield* runner.whileStopped(conversationId, Effect.ignore(conversations.remove(conversationId)))
          if (config.browser === "camofox") yield* camofox.closeConversation(conversationId, conversation.value.botIds)
        })

      const remove = Effect.fn("TeamSessions.remove")(function*(teamId: string) {
        const team = yield* teams.get(teamId)
        const subgroups = yield* teams.subgroupsOf(teamId)
        if (team.parentTeamId === null) {
          yield* FiberMap.remove(sessions, teamId)
          active.delete(teamId)
          pending.delete(teamId)
          yield* activity(team.privateConversationId, "")
        }
        for (const conversationId of [team.roomConversationId, team.privateConversationId, ...subgroups.map((s) => s.roomConversationId)]) {
          yield* removeConversation(conversationId)
        }
        yield* teams.remove(teamId)
        for (const removed of [team, ...subgroups]) yield* changed(removed.id)
      })

      const sync = (teamId: string): Effect.Effect<void> =>
        Effect.gen(function*() {
          const found = yield* Effect.option(teams.get(teamId))
          if (Option.isNone(found)) return
          const team = found.value
          const parent = team.parentTeamId === null ? undefined : Option.getOrUndefined(yield* Effect.option(teams.get(team.parentTeamId)))
          yield* Effect.ignore(conversations.update(team.roomConversationId, {
            title: roomTitle(team.name, parent?.name),
            botIds: [team.managerBotId, ...team.members.map((member) => member.botId)]
          }))
          if (team.privateConversationId !== null) {
            const manager = yield* Effect.option(bots.get(team.managerBotId))
            yield* Effect.ignore(conversations.update(team.privateConversationId, {
              ...(Option.isSome(manager) ? { title: privateTitle(team.name, manager.value.name) } : {}),
              botIds: [team.managerBotId]
            }))
          }
          for (const subgroup of yield* teams.subgroupsOf(teamId)) yield* sync(subgroup.id)
        })

      const statusText = (teamId: string) =>
        Effect.gen(function*() {
          const team = yield* Effect.orDie(teams.get(teamId))
          const task = team.task === null ? "" : ` on "${team.task.title}" (since ${team.task.startedAt})`
          const state = {
            idle: "idle",
            working: "working",
            waiting: "waiting for the person's answer",
            interrupted: "interrupted by a server restart"
          }[team.status]
          const room = (yield* conversations.messages(team.roomConversationId))
            .filter((message) => visible(message) && promptText(message.parts).length > 0)
            .slice(-6)
            .map((message) => `- ${message.senderName}: ${shorten(firstLine(promptText(message.parts)), 160)}`)
          const decisions = team.privateConversationId === null ? [] : (yield* conversations.messages(team.privateConversationId))
            .flatMap((message) => message.parts.flatMap((part) => (part.type === "report" && part.kind === "decision" ? [part] : [])))
            .slice(-5)
            .map((report) => `- ${report.title ?? shorten(report.text, 120)}`)
          return [
            `${team.name} is ${state}${task}.`,
            room.length > 0 ? `Latest in the room:\n${room.join("\n")}` : "Nothing in the room yet.",
            decisions.length > 0 ? `Latest decisions:\n${decisions.join("\n")}` : "No decisions reported yet."
          ].join("\n\n")
        })

      yield* runner.extendReplies((bot, conversation) =>
        Effect.gen(function*() {
          if (conversation.kind !== "team-private" || conversation.teamId === null) return undefined
          const found = yield* Effect.option(teams.get(conversation.teamId))
          if (Option.isNone(found) || found.value.managerBotId !== bot.id) return undefined
          const team = found.value
          return {
            tools: [
              briefTeamTool({ team: team.name, brief: (task, text) => brief(team.id, task, text) }),
              teamStatusTool({ team: team.name, status: statusText(team.id) })
            ],
            instructions: privateChatPrompt({ team, members: yield* staff(team), subgroups: yield* subgroupsOf(team) })
          }
        })
      )

      return TeamSessions.of({
        brief,
        stop,
        resume,
        remove,
        sync,
        botRenamed: (botId) =>
          Effect.gen(function*() {
            for (const team of yield* teams.list) {
              if (team.managerBotId === botId && team.privateConversationId !== null) yield* sync(team.id)
            }
          }),
        botRemoved: (botId) =>
          Effect.gen(function*() {
            for (const team of yield* teams.removeMember(botId)) {
              yield* sync(team.id)
              yield* changed(team.id)
            }
          }),
        isWorking: (teamId) => Effect.sync(() => active.has(teamId))
      })
    })
  )
}
