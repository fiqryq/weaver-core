import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { jsonSchemaOf } from "../../../src/tools/AgentTool.ts"
import { teamStatusTool } from "../../../src/tools/builtin/Team.ts"
import { callTool, say } from "../../support/layers.ts"
import { afterTool, bot, type Client, delta, instruct, kindOf, makeClient, systemOf, waitFor } from "./support.ts"

let client: Client | undefined
afterEach(async () => {
  await client?.dispose()
  client = undefined
})

describe("teams over HTTP", () => {
  it("creates teams with their conversations, checks them, and keeps titles and bots in step", async () => {
    client = await makeClient(() => say("ok"))
    const { request } = client
    expect((await request("GET", "/v1/health")).json).toMatchObject({ teams: true })
    const max = await bot(client, "Max")
    const ann = await bot(client, "Ann")
    const wes = await bot(client, "Wes")
    const xi = await bot(client, "Xi")
    const members = [{ botId: ann.id, role: " Android developer " }, { botId: wes.id, role: "Web developer" }]

    const invalid = async (body: Record<string, unknown>) => {
      const response = await request("POST", "/v1/teams", { name: "DELTA", managerBotId: max.id, members, ...body })
      expect(response.status).toBe(400)
      return response.json.message
    }
    expect(await invalid({ name: "  " })).toBe("Give the team a name.")
    expect(await invalid({ managerBotId: "nope" })).toBe("Unknown bot: nope")
    expect(await invalid({ members: [...members, { botId: max.id, role: "Boss" }] })).toBe(
      "Max manages DELTA, so it can't also be a member."
    )
    expect(await invalid({ members: [...members, { botId: ann.id, role: "QA" }] })).toBe("Ann is listed twice.")
    expect(await invalid({ members: [{ botId: ann.id, role: " " }] })).toBe("Give Ann a role of 1 to 60 characters.")
    expect(await invalid({ members: [{ botId: ann.id, role: "x".repeat(61) }] })).toBe("Give Ann a role of 1 to 60 characters.")
    expect(await invalid({ parentTeamId: "nope" })).toBe("Unknown parent team: nope")

    const created = await request("POST", "/v1/teams", { name: " DELTA ", purpose: "Apps", managerBotId: max.id, members })
    expect(created.status).toBe(200)
    const team = created.json
    expect(team).toMatchObject({
      name: "DELTA",
      purpose: "Apps",
      managerBotId: max.id,
      members: [{ botId: ann.id, role: "Android developer" }, { botId: wes.id, role: "Web developer" }],
      parentTeamId: null,
      status: "idle",
      task: null
    })
    const room = (await request("GET", `/v1/conversations/${team.roomConversationId}`)).json
    expect(room).toMatchObject({ kind: "team-room", teamId: team.id, title: "DELTA room", botIds: [max.id, ann.id, wes.id] })
    const privateChat = (await request("GET", `/v1/conversations/${team.privateConversationId}`)).json
    expect(privateChat).toMatchObject({ kind: "team-private", teamId: team.id, title: "DELTA · Max", botIds: [max.id] })

    const subInvalid = async (body: Record<string, unknown>) =>
      (await request("POST", "/v1/teams", { name: "Mobile", members: [{ botId: xi.id, role: "QA" }], ...body })).json.message
    expect(await subInvalid({ managerBotId: xi.id, members: [], parentTeamId: team.id })).toBe(
      "Xi must be a member of DELTA to lead a subgroup of it."
    )
    const sub = (await request("POST", "/v1/teams", {
      name: "Mobile",
      managerBotId: ann.id,
      members: [{ botId: xi.id, role: "QA" }],
      parentTeamId: team.id
    })).json
    expect(sub).toMatchObject({ parentTeamId: team.id, privateConversationId: null, managerBotId: ann.id })
    expect((await request("GET", `/v1/conversations/${sub.roomConversationId}`)).json).toMatchObject({
      kind: "team-room",
      teamId: sub.id,
      title: "DELTA / Mobile room",
      botIds: [ann.id, xi.id]
    })
    expect(await subInvalid({ managerBotId: xi.id, members: [], parentTeamId: sub.id })).toBe(
      "Mobile is a subgroup itself; subgroups go only one level deep."
    )
    expect((await request("GET", "/v1/teams")).json.map((t: { name: string }) => t.name)).toEqual(["DELTA", "Mobile"])

    const patch = (id: string, body: Record<string, unknown>) => request("PATCH", `/v1/teams/${id}`, body)
    expect((await patch(team.id, { members: [{ botId: wes.id, role: "Web developer" }] })).json.message).toBe(
      "Ann leads Mobile, so it has to stay a member of DELTA."
    )
    expect((await patch(team.id, { parentTeamId: sub.id })).json.message).toBe("A team can't move to another parent team.")
    expect((await patch(sub.id, { managerBotId: xi.id, members: [] })).json.message).toBe(
      "Xi must be a member of DELTA to lead a subgroup of it."
    )
    const renamed = await patch(team.id, { name: "Delta", purpose: "Apps for everyone", members: [...members, { botId: xi.id, role: "QA" }] })
    expect(renamed.json).toMatchObject({ name: "Delta", purpose: "Apps for everyone" })
    expect(renamed.json.members.map((m: { botId: string }) => m.botId)).toEqual([ann.id, wes.id, xi.id])
    expect((await request("GET", `/v1/conversations/${team.roomConversationId}`)).json).toMatchObject({
      title: "Delta room",
      botIds: [max.id, ann.id, wes.id, xi.id]
    })
    expect((await request("GET", `/v1/conversations/${team.privateConversationId}`)).json.title).toBe("Delta · Max")
    expect((await request("GET", `/v1/conversations/${sub.roomConversationId}`)).json.title).toBe("Delta / Mobile room")
    expect((await request("PATCH", `/v1/bots/${max.id}`, { name: "Maxine" })).status).toBe(200)
    expect((await request("GET", `/v1/conversations/${team.privateConversationId}`)).json.title).toBe("Delta · Maxine")

    const teamChanged = () =>
      client!.events.flatMap((event) => (event.type === "team-changed" ? [event.teamId] : []))
    await waitFor(() => teamChanged().length >= 3)
    expect(teamChanged()).toEqual([team.id, sub.id, team.id])

    const removed = await request("DELETE", `/v1/teams/${team.id}`)
    expect(removed.status).toBe(204)
    for (const id of [team.roomConversationId, team.privateConversationId, sub.roomConversationId]) {
      expect((await request("GET", `/v1/conversations/${id}`)).status).toBe(404)
    }
    expect((await request("GET", `/v1/teams/${sub.id}`)).status).toBe(404)
    expect((await request("GET", "/v1/teams")).json).toEqual([])
    expect((await request("DELETE", `/v1/teams/${team.id}`)).status).toBe(404)
  })

  it("lets the person watch rooms but not post, and keeps team conversations tied to the team", async () => {
    client = await makeClient(() => say("ok"))
    const { request } = client
    const { team, max, ann } = await delta(client)
    const xi = await bot(client, "Xi")
    await request("PATCH", `/v1/teams/${team.id}`, { members: [...team.members, { botId: xi.id, role: "QA" }] })
    const sub = (await request("POST", "/v1/teams", {
      name: "Mobile",
      managerBotId: ann.id,
      members: [{ botId: xi.id, role: "QA" }],
      parentTeamId: team.id
    })).json

    const watchOnly = "You can watch the team room but not post in it. Give instructions to Max in your private chat."
    for (const room of [team.roomConversationId, sub.roomConversationId]) {
      expect(await request("POST", `/v1/conversations/${room}/messages`, { text: "Hi team" })).toMatchObject({
        status: 409,
        json: { message: watchOnly }
      })
      expect(await request("POST", `/v1/conversations/${room}/regenerate`)).toMatchObject({ status: 409, json: { message: watchOnly } })
      expect((await request("GET", `/v1/conversations/${room}/messages`)).json).toEqual([])
    }
    for (const id of [team.roomConversationId, team.privateConversationId]) {
      expect((await request("PATCH", `/v1/conversations/${id}`, { botIds: [max.id] })).status).toBe(400)
      expect(await request("DELETE", `/v1/conversations/${id}`)).toMatchObject({
        status: 409,
        json: { message: "This conversation belongs to a team; delete the team instead." }
      })
    }
    expect((await request("PATCH", `/v1/conversations/${team.privateConversationId}`, { title: "Mine" })).status).toBe(200)

    expect((await request("POST", `/v1/conversations/${team.privateConversationId}/messages`, { text: "Hello" })).status).toBe(200)
  })

  it("won't delete a bot that manages a team, and takes deleted members off their teams", async () => {
    client = await makeClient(() => say("ok"))
    const { request } = client
    const { team, max, ann, wes } = await delta(client)
    const xi = await bot(client, "Xi")
    await request("PATCH", `/v1/teams/${team.id}`, { members: [...team.members, { botId: xi.id, role: "QA" }] })
    const sub = (await request("POST", "/v1/teams", {
      name: "Mobile",
      managerBotId: ann.id,
      members: [{ botId: xi.id, role: "QA" }],
      parentTeamId: team.id
    })).json

    expect(await request("DELETE", `/v1/bots/${max.id}`)).toMatchObject({
      status: 409,
      json: { message: "Max manages DELTA. Choose another manager first." }
    })
    expect(await request("DELETE", `/v1/bots/${ann.id}`)).toMatchObject({
      status: 409,
      json: { message: "Ann manages Mobile. Choose another manager first." }
    })
    expect((await request("GET", `/v1/bots/${max.id}`)).status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 50))
    const before = client.events.length
    expect((await request("DELETE", `/v1/bots/${wes.id}`)).status).toBe(204)
    expect((await request("DELETE", `/v1/bots/${xi.id}`)).status).toBe(204)
    expect((await request("GET", `/v1/teams/${team.id}`)).json.members).toEqual([{ botId: ann.id, role: "Android developer" }])
    expect((await request("GET", `/v1/teams/${sub.id}`)).json.members).toEqual([])
    expect((await request("GET", `/v1/conversations/${team.roomConversationId}`)).json.botIds).toEqual([max.id, ann.id])
    expect((await request("GET", `/v1/conversations/${sub.roomConversationId}`)).json.botIds).toEqual([ann.id])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(client.events.slice(before).flatMap((event) => (event.type === "team-changed" ? [event.teamId] : []))).toEqual([
      team.id,
      team.id,
      sub.id
    ])
  })

  it("offers brief_team and team_status only to the manager in its team's private chat", async () => {
    client = await makeClient((call) => (kindOf(call) === "private" && !afterTool(call) ? callTool("team_status", {}) : say("ok")))
    const { request } = client
    const { team, max, ann } = await delta(client)
    await instruct(client, team, "How's the team?")
    const chat = (await request("POST", "/v1/conversations", { botIds: [max.id] })).json
    await request("POST", `/v1/conversations/${chat.id}/messages`, { text: "Hi" })
    const annChat = (await request("POST", "/v1/conversations", { botIds: [ann.id] })).json
    await request("POST", `/v1/conversations/${annChat.id}/messages`, { text: "Hi" })
    const calls = client.model.calls
    await new Promise((resolve) => setTimeout(resolve, 100))

    const [inPrivate] = calls
    expect(inPrivate!.tools).toEqual(expect.arrayContaining(["brief_team", "team_status"]))
    expect(systemOf(inPrivate!)).toContain(
      "## Your team\nYou manage team DELTA (Mobile and web apps). Members: Ann — Android developer; Wes — Web developer. " +
        "The person gives you tasks here. Hand work to the team with brief_team"
    )
    expect(systemOf(inPrivate!)).toContain("Right now DELTA is idle.")
    const status = (await request("GET", `/v1/conversations/${team.privateConversationId}/messages`)).json[1]
    expect(status.parts[1]).toMatchObject({
      type: "tool-result",
      name: "team_status",
      isFailure: false,
      output: "DELTA is idle.\n\nNothing in the room yet.\n\nNo decisions reported yet."
    })
    for (const call of calls.slice(2)) {
      expect(call.tools).not.toContain("brief_team")
      expect(call.tools).not.toContain("team_status")
      expect(systemOf(call)).not.toContain("You manage team")
    }
    expect(calls.length).toBe(4)
  })

  it("describes tools without arguments with an object schema, which providers require", () => {
    expect(jsonSchemaOf(Schema.Struct({}))).toEqual({ type: "object", properties: {} })
    expect(teamStatusTool({ team: "DELTA", status: Effect.succeed("") }).parameters).toEqual({ type: "object", properties: {} })
  })
})
