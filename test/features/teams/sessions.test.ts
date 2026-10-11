import { afterEach, describe, expect, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import type { RunEvent } from "../../../src/features/runs/Events.ts"
import { TeamRepo } from "../../../src/features/teams/TeamRepo.ts"
import { TeamSessions } from "../../../src/features/teams/TeamSessions.ts"
import { McpError } from "../../../src/features/integrations/McpHub.ts"
import { fakeMemory } from "../../support/fakeMemory.ts"
import { callTool, createBot, type ModelCall, say, scriptedModel, testLayer, withProviderKey } from "../../support/layers.ts"
import {
  afterTool,
  bot,
  type Client,
  delta,
  instruct,
  kindOf,
  lastUserTurn,
  makeClient,
  messagesOf,
  nameOf,
  reportsIn,
  show,
  steps,
  systemOf,
  teamOf,
  userTurns,
  waitFor
} from "./support.ts"

let client: Client | undefined
afterEach(async () => {
  await client?.dispose()
  client = undefined
})

type Parts = ReturnType<typeof say>

const briefLogin = (call: ModelCall) =>
  afterTool(call)
    ? say("DELTA is on it.")
    : callTool("brief_team", { task: "Login screen", brief: "Build a login screen with email and Google sign-in." }, `brief-${call.index}`)

/** A team whose manager runs `session` turns, members answer with `member`, and the private chat briefs the team. */
const teamScript = (options: {
  readonly session: (call: ModelCall) => Parts
  readonly member?: (call: ModelCall) => Parts
  readonly lead?: (call: ModelCall) => Parts
  readonly private?: (call: ModelCall) => Parts
}) =>
(call: ModelCall): Parts => {
  switch (kindOf(call)) {
    case "private":
      return (options.private ?? briefLogin)(call)
    case "session":
      return options.session(call)
    case "lead":
      return options.lead?.(call) ?? say("lead")
    case "member":
      return options.member?.(call) ?? say(`${nameOf(call)} here.`)
    default:
      return say("ok")
  }
}

const callsOf = (client: Client, kind: ReturnType<typeof kindOf>, name?: string) =>
  client.model.calls.filter((call) => kindOf(call) === kind && (name === undefined || nameOf(call) === name))

const activityIn = (client: Client, conversationId: string) =>
  client.events.flatMap((event) => (event.type === "activity" && event.conversationId === conversationId ? [event.text] : []))

const finished = (client: Client, teamId: string) =>
  waitFor(async () => {
    const team = await teamOf(client, teamId)
    return team.status === "idle" && (await reportsIn(client, team.privateConversationId, "summary")).length > 0 ? team : undefined
  })

const statusIs = (client: Client, teamId: string, status: string) =>
  waitFor(async () => {
    const team = await teamOf(client, teamId)
    return team.status === status ? team : undefined
  })

const approvalIn = (client: Client, conversationId: string) =>
  waitFor(() =>
    client.events.find((event): event is Extract<RunEvent, { type: "approval-requested" }> =>
      event.type === "approval-requested" && event.conversationId === conversationId
    )
  )

/** Ann runs a command first (which waits for approval in ask mode), then answers. */
const annRunsCommand = (call: ModelCall) =>
  afterTool(call) ? say("Built it.") : callTool("run_command", { command: "echo built" }, `ann-${call.index}`)
const annAsks = { tools: ["shell" as const], approvalMode: "ask" as const }

describe("team sessions", () => {
  it("runs a task from the brief to the summary, with the room and reports to watch", async () => {
    const session = steps([
      callTool("ask_member", { member: "android developer", message: "How do we do Google sign-in?" }, "s1"),
      callTool("open_round", { topic: "Shared design for the login screen" }, "s2"),
      callTool("report_decision", { decision: "Use Firebase Auth for both apps", rationale: "One backend for both." }, "s3"),
      callTool("finish_task", { summary: "Login screen planned with Firebase Auth." }, "s4")
    ])
    client = await makeClient(teamScript({
      session: () => session(),
      member: (call) => say(nameOf(call) === "Ann" ? "Use Credential Manager." : "Use Firebase UI on web."),
      private: (call) => (call.prompt.includes("How's it going") ? say("All done.") : briefLogin(call))
    }))
    const { team, max, ann, wes } = await delta(client)

    const reply = await instruct(client, team, "Build a login screen with email and Google sign-in.")
    expect(show(reply)).toBe("call:brief_team | result:brief_team | DELTA is on it.")
    expect(reply.parts[1]).toMatchObject({ output: "DELTA is on it. Reports will appear here.", isFailure: false })
    const done = await finished(client, team.id)
    expect(done).toMatchObject({ status: "idle", task: null })

    const room = await messagesOf(client, team.roomConversationId)
    expect(room.map((m) => [m.senderName, m.status, show(m)])).toEqual([
      ["Max", "done", "brief:Login screen:Build a login screen with email and Google sign-in."],
      ["Max", "done", "call:ask_member | result:ask_member"],
      ["Max", "done", "@Ann How do we do Google sign-in?"],
      ["Ann", "done", "Use Credential Manager."],
      ["Max", "done", "call:open_round | result:open_round"],
      ["Max", "done", "Shared design for the login screen"],
      ["Ann", "done", "Use Credential Manager."],
      ["Wes", "done", "Use Firebase UI on web."],
      ["Max", "done", "call:report_decision | result:report_decision"],
      ["Max", "done", "Decision: Use Firebase Auth for both apps"],
      ["Max", "done", "call:finish_task | result:finish_task"]
    ])
    expect(room.every((m) => m.role === "assistant")).toBe(true)
    expect(room[1].parts[1].output).toBe("Ann (Android developer) replied:\n\nUse Credential Manager.")
    expect(room[4].parts[1].output).toBe(
      "Ann (Android developer):\nUse Credential Manager.\n\nWes (Web developer):\nUse Firebase UI on web."
    )
    expect(room[0].parts[0]).toEqual({
      type: "report",
      kind: "brief",
      teamId: team.id,
      title: "Login screen",
      text: "Build a login screen with email and Google sign-in."
    })

    const privateChat = await messagesOf(client, team.privateConversationId)
    expect(privateChat.map((m) => [m.role, m.botId, show(m)])).toEqual([
      ["user", null, "Build a login screen with email and Google sign-in."],
      ["assistant", max.id, "call:brief_team | result:brief_team | DELTA is on it."],
      ["assistant", max.id, "decision:Use Firebase Auth for both apps:Use Firebase Auth for both apps\n\nOne backend for both."],
      ["assistant", max.id, "summary:Login screen:Login screen planned with Firebase Auth."]
    ])

    const [first, second] = callsOf(client, "session", "Max")
    expect(systemOf(first!)).toContain("## Team session\nYou're leading DELTA on: Login screen. Plan the work")
    expect(systemOf(first!)).toContain("Members: Ann — Android developer; Wes — Web developer.")
    expect(first!.tools).toEqual(expect.arrayContaining(["ask_member", "open_round", "report_decision", "ask_person", "finish_task"]))
    expect(first!.tools).not.toContain("brief_team")
    expect(first!.tools).not.toContain("delegate_to_subgroup")
    expect(first!.tools).not.toContain("report_up")
    expect(lastUserTurn(first!)).toBe("Lead the team on the brief above.")
    expect(second!.prompt).toContain("[Ann]: Use Credential Manager.")
    expect(callsOf(client, "session", "Max")).toHaveLength(4)

    const [annAsked] = callsOf(client, "member", "Ann")
    expect(systemOf(annAsked!)).toContain(
      "You're Android developer on team DELTA, led by Max. Answer the manager from your role's perspective"
    )
    expect(lastUserTurn(annAsked!)).toBe(
      "[Max]: [Brief] Login screen: Build a login screen with email and Google sign-in.\n\n[Max]: @Ann How do we do Google sign-in?"
    )
    const [wesRound] = callsOf(client, "member", "Wes")
    expect(userTurns(wesRound!).at(-1)).toContain("[Max]: Shared design for the login screen\n\n[Ann]: Use Credential Manager.")
    expect(nameOf(wesRound!)).toBe("Wes")

    const changes = client.events.filter((event) => event.type === "team-changed" && event.teamId === team.id)
    expect(changes.length).toBeGreaterThanOrEqual(3)
    const activity = activityIn(client, team.privateConversationId)
    expect(activity).toContain("DELTA is working")
    expect(activity.at(-1)).toBe("")
    expect(client.events.some((event) => event.type === "run-started" && event.conversationId === team.roomConversationId)).toBe(true)

    await instruct(client, team, "How's it going?")
    const later = client.model.calls.findLast((call) => kindOf(call) === "private")!
    expect(later.prompt).toContain("[Decision] Use Firebase Auth for both apps: Use Firebase Auth for both apps")
    expect(later.prompt).toContain("[Summary] Login screen: Login screen planned with Firebase Auth.")
    expect(room.slice(3).filter((m) => m.role === "assistant" && m.botId !== max.id).map((m) => m.botId)).toEqual([
      ann.id,
      ann.id,
      wes.id
    ])
  })

  it("passes a brief sent while the team works to its next turn, and surfaces approvals in the private chat", async () => {
    const session = steps([
      callTool("ask_member", { member: "Ann", message: "Build it" }, "s1"),
      callTool("finish_task", { summary: "Done, with Apple sign-in." }, "s2")
    ])
    client = await makeClient(teamScript({
      session: () => session(),
      member: annRunsCommand,
      private: (call) =>
        afterTool(call)
          ? say("Okay.")
          : call.prompt.includes("Apple")
          ? callTool("brief_team", { task: "Login screen", brief: "Also support Apple sign-in." }, `b-${call.index}`)
          : briefLogin(call)
    }))
    const { team } = await delta(client, annAsks)

    await instruct(client, team, "Build the login screen")
    const approval = await approvalIn(client, team.roomConversationId)
    await waitFor(() => activityIn(client!, team.privateConversationId).includes("Waiting for your approval in DELTA's room"))
    expect((await teamOf(client, team.id)).status).toBe("working")

    const update = await instruct(client, team, "Also Apple sign-in please")
    expect(update.parts[1]).toMatchObject({ name: "brief_team", output: "Sent the update to DELTA." })
    expect((await client.request("POST", `/v1/approvals/${approval.approvalId}`, { approved: true })).status).toBe(204)
    await finished(client, team.id)

    const [, next] = callsOf(client, "session", "Max")
    expect(next!.prompt).toContain("[Brief] Login screen: Also support Apple sign-in.")
    const briefs = await reportsIn(client, team.roomConversationId, "brief")
    expect(briefs.map((brief: { text: string }) => brief.text)).toEqual([
      "Build a login screen with email and Google sign-in.",
      "Also support Apple sign-in."
    ])
    expect(activityIn(client, team.privateConversationId)).toContain("DELTA is working")
  })

  it("goes on with a brief that arrives during the manager's final turn", async () => {
    const session = steps<Parts>([
      [callTool("run_command", { command: "echo ship" }, "s1")[0]!, ...callTool("finish_task", { summary: "Shipped." }, "s2")],
      callTool("finish_task", { summary: "Shipped, with Apple sign-in." }, "s3")
    ])
    client = await makeClient(teamScript({
      session: () => session(),
      private: (call) =>
        afterTool(call)
          ? say("Okay.")
          : call.prompt.includes("Apple")
          ? callTool("brief_team", { task: "Login screen", brief: "Also support Apple sign-in." }, `b-${call.index}`)
          : briefLogin(call)
    }))
    const { team } = await delta(client, {}, annAsks)
    await instruct(client, team, "Build the login screen")
    const approval = await approvalIn(client, team.roomConversationId)
    const update = await instruct(client, team, "Also Apple sign-in please")
    expect(update.parts[1]).toMatchObject({ name: "brief_team", output: "Sent the update to DELTA." })
    expect((await client.request("POST", `/v1/approvals/${approval.approvalId}`, { approved: true })).status).toBe(204)
    await waitFor(async () => (await reportsIn(client!, team.privateConversationId, "summary")).length === 2)
    await statusIs(client, team.id, "idle")
    const [, next] = callsOf(client, "session", "Max")
    expect(lastUserTurn(next!)).toContain("The person sent an update in the latest brief; continue the task with it.")
    expect(next!.prompt).toContain("[Brief] Login screen: Also support Apple sign-in.")
  })

  it("pauses when the manager asks the person, and the answer relayed with brief_team resumes it", async () => {
    const session = steps([
      callTool("ask_person", { question: "Which platforms first?" }, "s1"),
      callTool("finish_task", { summary: "Android first, done." }, "s2")
    ])
    client = await makeClient(teamScript({
      session: () => session(),
      private: (call) =>
        afterTool(call)
          ? say("Passed it on.")
          : call.prompt.includes("Android only")
          ? callTool("brief_team", { task: "Login screen v2", brief: "Android only first." }, `b-${call.index}`)
          : briefLogin(call)
    }))
    const { team, max } = await delta(client)
    expect((await client.request("POST", `/v1/teams/${team.id}/resume`)).status).toBe(409)

    await instruct(client, team, "Build the login screen")
    const waiting = await statusIs(client, team.id, "waiting")
    expect(waiting.task).toMatchObject({ title: "Login screen" })
    expect(await reportsIn(client, team.privateConversationId, "question")).toEqual([
      { type: "report", kind: "question", teamId: team.id, title: null, text: "Which platforms first?" }
    ])
    const question = (await messagesOf(client, team.privateConversationId)).at(-1)
    expect(question).toMatchObject({ role: "assistant", botId: max.id, senderName: "Max", status: "done" })

    const answer = await instruct(client, team, "Android only for now")
    expect(answer.parts[1]).toMatchObject({ name: "brief_team", output: "DELTA is on it. Reports will appear here." })
    await finished(client, team.id)
    const [, resumed] = callsOf(client, "session", "Max")
    expect(systemOf(resumed!)).toContain("You're leading DELTA on: Login screen.")
    expect(resumed!.prompt).toContain("[Brief] Login screen v2: Android only first.")
    expect(lastUserTurn(resumed!)).toBe("The person sent an update in the latest brief; continue the task with it.")
  })

  it("stop interrupts the session and the member's reply", async () => {
    client = await makeClient(teamScript({
      session: () => callTool("ask_member", { member: "Ann", message: "Build it" }, "s1"),
      member: annRunsCommand
    }))
    const { team } = await delta(client, annAsks)
    await instruct(client, team, "Build the login screen")
    await approvalIn(client, team.roomConversationId)

    const stopped = await client.request("POST", `/v1/teams/${team.id}/stop`)
    expect(stopped).toMatchObject({ status: 200, json: { status: "idle", task: null } })
    const room = await messagesOf(client, team.roomConversationId)
    expect(room.map((m) => [m.senderName, m.status, show(m)])).toEqual([
      ["Max", "done", "brief:Login screen:Build a login screen with email and Google sign-in."],
      ["Max", "cancelled", "call:ask_member"],
      ["Max", "done", "@Ann Build it"],
      ["Ann", "cancelled", "call:run_command"],
      ["Max", "done", "Stopped by you."]
    ])
    expect(room[3].parts[0]).toMatchObject({ approval: "denied" })
    await waitFor(() =>
      client!.events.filter((event) =>
        event.type === "run-finished" && event.conversationId === team.roomConversationId && event.status === "cancelled"
      ).length === 2
    )
    expect(activityIn(client, team.privateConversationId).at(-1)).toBe("")
    expect((await client.request("POST", `/v1/teams/${team.id}/resume`)).status).toBe(409)
    expect((await client.request("POST", `/v1/teams/${team.id}/stop`)).json.status).toBe("idle")
    expect((await messagesOf(client, team.roomConversationId))).toHaveLength(5)
  })

  it("nudges a manager that doesn't report, then pauses to ask the person", async () => {
    client = await makeClient(
      teamScript({ session: () => say("Still thinking.") }),
      { config: { teamNudgeSteps: 2, teamPauseSteps: 4 } }
    )
    const { team } = await delta(client)
    await instruct(client, team, "Build the login screen")
    await statusIs(client, team.id, "waiting")

    const turns = callsOf(client, "session", "Max")
    expect(turns.map(lastUserTurn)).toEqual([
      "Lead the team on the brief above.",
      "Continue leading the team: ask members, report decisions, ask the person if blocked, or finish the task.",
      "You've taken 2 steps since your last report. Report progress to the person with report_decision, or ask them with ask_person if you're stuck.",
      "Continue leading the team: ask members, report decisions, ask the person if blocked, or finish the task."
    ])
    const room = await messagesOf(client, team.roomConversationId)
    expect(room.slice(1).map(show)).toEqual(Array(4).fill("Still thinking."))
    expect(await reportsIn(client, team.privateConversationId, "question")).toEqual([{
      type: "report",
      kind: "question",
      teamId: team.id,
      title: null,
      text: "We've been working on Login screen for a while without a decision. Should we keep going?"
    }])
  })

  it("asks whether to retry after an error, and resume carries on", async () => {
    let broken = true
    client = await makeClient(teamScript({
      session: () => {
        if (broken) throw new Error("model exploded")
        return callTool("finish_task", { summary: "Recovered." }, "s1")
      }
    }))
    const { team } = await delta(client)
    await instruct(client, team, "Build the login screen")
    await statusIs(client, team.id, "waiting")
    const [question] = await reportsIn(client, team.privateConversationId, "question")
    expect(question.text).toBe("DELTA hit a problem: model exploded. Should we retry?")

    broken = false
    const resumed = await client.request("POST", `/v1/teams/${team.id}/resume`)
    expect(resumed).toMatchObject({ status: 200, json: { status: "working", task: { title: "Login screen" } } })
    await finished(client, team.id)
    expect(lastUserTurn(callsOf(client, "session", "Max").at(-1)!)).toBe("The person asked you to continue; carry on with the task.")
  })

  it("delegates to a subgroup, whose lead reports up instead of finishing", async () => {
    const session = steps([
      callTool("delegate_to_subgroup", { subgroup: "mobile", brief: "Plan the Android tests." }, "s1"),
      callTool("finish_task", { summary: "Tests planned." }, "s2")
    ])
    const lead = steps([
      callTool("ask_member", { member: "QA", message: "Which tests?" }, "l1"),
      callTool("report_up", { summary: "Unit and UI tests, Xi owns them." }, "l2")
    ])
    client = await makeClient(teamScript({
      session: () => session(),
      lead: () => lead(),
      member: (call) => say(nameOf(call) === "Xi" ? "Unit and UI tests." : "Sure.")
    }))
    const { team, max, ann } = await delta(client)
    const xi = await bot(client, "Xi")
    const sub = (await client.request("POST", "/v1/teams", {
      name: "Mobile",
      managerBotId: ann.id,
      members: [{ botId: xi.id, role: "QA" }],
      parentTeamId: team.id
    })).json

    await instruct(client, team, "Plan the tests")
    await finished(client, team.id)

    const [managerTurn] = callsOf(client, "session", "Max")
    expect(managerTurn!.tools).toContain("delegate_to_subgroup")
    expect(systemOf(managerTurn!)).toContain("use open_round to brainstorm, delegate_to_subgroup for Mobile, decide.")
    const [leadTurn] = callsOf(client, "lead", "Ann")
    expect(leadTurn!.tools).toEqual(expect.arrayContaining(["ask_member", "open_round", "report_up"]))
    for (const tool of ["finish_task", "ask_person", "report_decision", "delegate_to_subgroup"]) {
      expect(leadTurn!.tools).not.toContain(tool)
    }
    expect(systemOf(leadTurn!)).toContain("You're leading Mobile, a subgroup of DELTA, on: Plan the Android tests.")
    expect(systemOf(leadTurn!)).toContain("call report_up with a clear summary for Max")
    expect(lastUserTurn(leadTurn!)).toContain("[Max]: [Brief] Plan the Android tests.: Plan the Android tests.")

    const subRoom = await messagesOf(client, sub.roomConversationId)
    expect(subRoom.map((m) => [m.senderName, show(m)])).toEqual([
      ["Max", "brief:Plan the Android tests.:Plan the Android tests."],
      ["Ann", "call:ask_member | result:ask_member"],
      ["Ann", "@Xi Which tests?"],
      ["Xi", "Unit and UI tests."],
      ["Ann", "call:report_up | result:report_up"]
    ])
    const room = await messagesOf(client, team.roomConversationId)
    expect(room[1].parts[1].output).toBe("Ann reported for Mobile:\n\nUnit and UI tests, Xi owns them.")
    expect(room.map((m) => [m.senderName, show(m)])).toContainEqual(["Ann", "Report from Mobile:\n\nUnit and UI tests, Xi owns them."])
    expect(await teamOf(client, sub.id)).toMatchObject({ status: "idle", task: null })
    const subChanges = client.events.filter((event) => event.type === "team-changed" && event.teamId === sub.id)
    expect(subChanges.length).toBeGreaterThanOrEqual(3)
    expect(subRoom[0].botId).toBe(max.id)
  })

  it("stop also interrupts a subgroup's work", async () => {
    client = await makeClient(teamScript({
      session: () => callTool("delegate_to_subgroup", { subgroup: "Mobile", brief: "Build the Android app." }, "s1"),
      lead: () => callTool("ask_member", { member: "Xi", message: "Build it" }, "l1"),
      member: (call) => (nameOf(call) === "Xi" ? annRunsCommand(call) : say("Sure."))
    }))
    const { team, ann } = await delta(client)
    const xi = await bot(client, "Xi", annAsks)
    const sub = (await client.request("POST", "/v1/teams", {
      name: "Mobile",
      managerBotId: ann.id,
      members: [{ botId: xi.id, role: "QA" }],
      parentTeamId: team.id
    })).json
    await instruct(client, team, "Build the apps")
    await approvalIn(client, sub.roomConversationId)
    expect((await teamOf(client, sub.id)).status).toBe("working")
    await waitFor(() => activityIn(client!, team.privateConversationId).includes("Waiting for your approval in Mobile's room"))

    expect((await client.request("POST", `/v1/teams/${team.id}/stop`)).json.status).toBe("idle")
    expect(await teamOf(client, sub.id)).toMatchObject({ status: "idle", task: null })
    const subRoom = await messagesOf(client, sub.roomConversationId)
    expect(subRoom.map((m) => [m.senderName, m.status])).toEqual([
      ["Max", "done"],
      ["Ann", "cancelled"],
      ["Ann", "done"],
      ["Xi", "cancelled"]
    ])
    expect(show((await messagesOf(client, team.roomConversationId)).at(-1))).toBe("Stopped by you.")
  })

  it("deleting a working team stops it and removes its conversations", async () => {
    client = await makeClient(teamScript({
      session: () => callTool("ask_member", { member: "Ann", message: "Build it" }, "s1"),
      member: annRunsCommand
    }))
    const { team } = await delta(client, annAsks)
    await instruct(client, team, "Build the login screen")
    await approvalIn(client, team.roomConversationId)
    expect((await client.request("DELETE", `/v1/teams/${team.id}`)).status).toBe(204)
    for (const id of [team.roomConversationId, team.privateConversationId]) {
      expect((await client.request("GET", `/v1/conversations/${id}`)).status).toBe(404)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await client.request("GET", "/v1/teams")).json).toEqual([])
    expect((await client.request("GET", "/v1/conversations")).json).toEqual([])
    expect(
      client.events.some((event) => event.type === "run-finished" && event.conversationId === team.roomConversationId && event.status === "cancelled")
    ).toBe(true)
  })

  it("regenerating the manager's private reply keeps the team's reports", async () => {
    const privateTurn = steps<(call: ModelCall) => Parts>([briefLogin, briefLogin, () => say("Regenerated.")])
    client = await makeClient(teamScript({
      session: () => callTool("ask_person", { question: "Which platforms first?" }, "s1"),
      private: (call) => privateTurn()(call)
    }))
    const { team } = await delta(client)
    await instruct(client, team, "Build the login screen")
    await statusIs(client, team.id, "waiting")
    expect((await client.request("POST", `/v1/conversations/${team.privateConversationId}/regenerate`)).status).toBe(200)
    await waitFor(async () => {
      const last = (await messagesOf(client!, team.privateConversationId)).at(-1)
      return last.status === "done" && show(last) === "Regenerated."
    })
    expect((await messagesOf(client, team.privateConversationId)).map(show)).toEqual([
      "Build the login screen",
      "question:null:Which platforms first?",
      "Regenerated."
    ])
  })

  it("saves decisions and summaries to the manager's memory, without failing when memory is down", async () => {
    for (const down of [false, true]) {
      const memory = fakeMemory()
      if (down) {
        memory.hooks.before = (call) =>
          call.name === "write_note" ? Effect.fail(new McpError({ server: "Memory", message: "memory is down" })) : Effect.void
      }
      const session = steps([
        callTool("report_decision", { decision: "Use Kotlin\nfor everything", rationale: "The team knows it." }, "s1"),
        callTool("finish_task", { summary: "Done in Kotlin." }, "s2")
      ])
      client = await makeClient(teamScript({ session: () => session() }), { memory })
      const { team } = await delta(client, {}, { tools: ["memory"] })
      await instruct(client, team, "Build the login screen")
      await finished(client, team.id)
      const writes = await waitFor(() => {
        const found = memory.calls.filter((call) => call.name === "write_note")
        return found.length === 2 ? found : undefined
      })
      expect(await reportsIn(client, team.privateConversationId, "decision")).toEqual([{
        type: "report",
        kind: "decision",
        teamId: team.id,
        title: "Use Kotlin",
        text: "Use Kotlin\nfor everything\n\nThe team knows it."
      }])
      if (!down) {
        expect(writes[0]!.args).toMatchObject({
          directory: "weaver/teams/delta",
          tags: ["team", "delta"],
          project: "weaver-test",
          output_format: "json",
          content: "## Decision\nUse Kotlin\nfor everything\n\n## Rationale\nThe team knows it.\n\n## Task\nLogin screen\n\n" +
            "## Relations\n- part_of [[DELTA]]\n- decided_by [[Max]]\n"
        })
        expect(writes[0]!.args.title).toMatch(/^DELTA decision: Use Kotlin for everything \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/)
        expect(writes[1]!.args).toMatchObject({
          directory: "weaver/teams/delta",
          content: "## Summary\nDone in Kotlin.\n\n## Task\nLogin screen\n\n## Relations\n- part_of [[DELTA]]\n- decided_by [[Max]]\n"
        })
        expect(writes[1]!.args.title).toMatch(/^DELTA summary: Login screen \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/)
      }
      await client.dispose()
      client = undefined
    }
  })
})

describe("team sessions across a restart", () => {
  it.live("marks working teams interrupted, and resume continues from the room", () => {
    const model = scriptedModel(teamScript({ session: () => callTool("finish_task", { summary: "Picked up and done." }, "s1") }))
    return Effect.gen(function*() {
      yield* withProviderKey
      const conversations = yield* ConversationRepo
      const teams = yield* TeamRepo
      const max = yield* createBot({ name: "Max" })
      const ann = yield* createBot({ name: "Ann" })
      const room = yield* conversations.create({ title: "DELTA room", botIds: [max.id, ann.id], team: { id: "delta", kind: "team-room" } })
      const privateChat = yield* conversations.create({
        title: "DELTA · Max",
        botIds: [max.id],
        team: { id: "delta", kind: "team-private" }
      })
      yield* teams.create("delta", {
        name: "DELTA",
        purpose: "",
        managerBotId: max.id,
        members: [{ botId: ann.id, role: "Android developer" }],
        parentTeamId: null,
        roomConversationId: room.id,
        privateConversationId: privateChat.id
      })
      const subRoom = yield* conversations.create({ title: "DELTA / Mobile room", botIds: [ann.id], team: { id: "mobile", kind: "team-room" } })
      yield* teams.create("mobile", {
        name: "Mobile",
        purpose: "",
        managerBotId: ann.id,
        members: [],
        parentTeamId: "delta",
        roomConversationId: subRoom.id,
        privateConversationId: null
      })
      const task = { title: "Login screen", startedAt: "2026-10-11T10:00:00.000Z" }
      yield* teams.update("delta", { status: "working", task })
      yield* teams.update("mobile", { status: "working", task })
      yield* conversations.insertMessage({
        conversationId: room.id,
        role: "assistant",
        botId: max.id,
        senderName: "Max",
        parts: [{ type: "report", kind: "brief", teamId: "delta", title: "Login screen", text: "Build the login screen." }]
      })

      expect(yield* teams.markInterrupted).toBe(2)
      expect(yield* teams.get("delta")).toMatchObject({ status: "interrupted", task })
      expect(yield* teams.get("mobile")).toMatchObject({ status: "idle", task: null })
      expect(yield* teams.markInterrupted).toBe(0)

      const sessions = yield* TeamSessions
      expect((yield* sessions.resume("delta")).status).toBe("working")
      expect(yield* sessions.isWorking("delta")).toBe(true)
      for (let i = 0; i < 400 && (yield* teams.get("delta")).status !== "idle"; i++) yield* Effect.sleep(Duration.millis(10))
      expect(yield* teams.get("delta")).toMatchObject({ status: "idle", task: null })
      const [turn] = model.calls.filter((call) => kindOf(call) === "session")
      expect(lastUserTurn(turn!)).toBe("You were interrupted; continue the task.")
      expect(turn!.prompt).toContain("[Brief] Login screen: Build the login screen.")
      const reports = (yield* conversations.messages(privateChat.id)).flatMap((m) => m.parts)
      expect(reports).toEqual([{ type: "report", kind: "summary", teamId: "delta", title: "Login screen", text: "Picked up and done." }])
    }).pipe(Effect.provide(testLayer(model.layer)))
  })
})
