import { BunHttpServer } from "@effect/platform-bun"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { AppRoutes } from "../../../src/main.ts"
import { callTool, type ModelCall, say, scriptedModel, testLayer } from "../../support/layers.ts"

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

const nameOf = (call: ModelCall) => /Your name is ([^.]+)\./.exec(call.prompt)?.[1]

/** Ada asks Bo through ask_bot; Bo answers. */
const makeClient = () => {
  const model = scriptedModel((call) =>
    nameOf(call) !== "Ada"
      ? say("Here you go.")
      : call.prompt.includes("\"role\":\"tool\"")
      ? say("Thanks, Bo.")
      : callTool("ask_bot", { bot: "Bo", request: "Help me out" }, `ask-${call.index}`)
  )
  const web = HttpRouter.toWebHandler(
    AppRoutes.pipe(Layer.provide(testLayer(model.layer)), Layer.provide(BunHttpServer.layerHttpServices)),
    { disableLogger: true }
  )
  dispose = web.dispose
  return async (method: string, path: string, body?: unknown) => {
    const response = await web.handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: "Bearer test-token", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    )
    const text = await response.text()
    return { status: response.status, json: text.length > 0 ? JSON.parse(text) : undefined }
  }
}

type Request = ReturnType<typeof makeClient>

/** Sends to Ada's chat and waits until her reply is done. */
const ask = async (request: Request, chatId: string) => {
  await request("POST", `/v1/conversations/${chatId}/messages`, { text: "Ask Bo" })
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const last = (await request("GET", `/v1/conversations/${chatId}/messages`)).json.at(-1)
    if (last.role === "assistant" && last.status === "done") return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("Ada didn't finish")
}

const handoffsOf = async (request: Request) =>
  ((await request("GET", "/v1/conversations")).json as Array<{ id: string; kind: string }>).filter((c) =>
    c.kind === "handoff"
  )

describe("teammates and handoffs over HTTP", () => {
  it("stores teammates and checks them", async () => {
    const request = makeClient()
    const ada = (await request("POST", "/v1/bots", { name: "Ada" })).json
    expect(ada.teammateIds).toEqual([])
    const bo = (await request("POST", "/v1/bots", { name: "Bo", teammateIds: [ada.id, ada.id] })).json
    expect(bo.teammateIds).toEqual([ada.id])
    expect((await request("GET", `/v1/bots/${bo.id}`)).json.teammateIds).toEqual([ada.id])

    expect((await request("PATCH", `/v1/bots/${ada.id}`, { teammateIds: [bo.id] })).json.teammateIds).toEqual([bo.id])
    const self = await request("PATCH", `/v1/bots/${ada.id}`, { teammateIds: [ada.id] })
    expect(self).toMatchObject({ status: 400, json: { message: "A bot can't be its own teammate." } })
    const unknown = await request("PATCH", `/v1/bots/${ada.id}`, { teammateIds: [bo.id, "nope"] })
    expect(unknown).toMatchObject({ status: 400, json: { message: "Unknown teammate: nope" } })
    expect((await request("POST", "/v1/bots", { name: "Cy", teammateIds: ["nope"] })).status).toBe(400)
    expect((await request("GET", `/v1/bots/${ada.id}`)).json.teammateIds).toEqual([bo.id])
    expect((await request("PATCH", `/v1/bots/${ada.id}`, { teammateIds: [] })).json.teammateIds).toEqual([])
  })

  it("lists handoffs, keeps them read-only for the person, and cleans up when a bot is deleted", async () => {
    const request = makeClient()
    expect((await request("GET", "/v1/health")).json).toMatchObject({ handoffs: true })
    await request("PUT", "/v1/providers/deepseek", { apiKey: "sk-test" })
    const bo = (await request("POST", "/v1/bots", { name: "Bo" })).json
    const ada = (await request("POST", "/v1/bots", { name: "Ada", teammateIds: [bo.id] })).json
    const chat = (await request("POST", "/v1/conversations", { botIds: [ada.id] })).json
    expect(chat).toMatchObject({ kind: "chat", requesterBotId: null })

    const reply = await ask(request, chat.id)
    const [handoff] = await handoffsOf(request)
    expect(handoff).toMatchObject({ kind: "handoff", requesterBotId: ada.id, botIds: [ada.id, bo.id], title: "Ada → Bo" })
    const id = handoff!.id
    expect(reply.parts[1]).toMatchObject({ type: "tool-result", handoffConversationId: id, output: "Bo replied:\n\nHere you go." })
    expect((await request("GET", `/v1/conversations/${id}`)).json.kind).toBe("handoff")

    const send = await request("POST", `/v1/conversations/${id}/messages`, { text: "Me too" })
    expect(send).toMatchObject({ status: 409, json: { message: "You can watch handoffs but not reply in them." } })
    expect((await request("POST", `/v1/conversations/${id}/regenerate`)).status).toBe(409)
    expect((await request("PATCH", `/v1/conversations/${id}`, { botIds: [bo.id] })).status).toBe(400)
    expect((await request("GET", `/v1/conversations/${id}/messages`)).json.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant"
    ])

    expect((await request("PATCH", `/v1/bots/${bo.id}`, { name: "Bobby" })).status).toBe(200)
    expect((await request("GET", `/v1/conversations/${id}`)).json.title).toBe("Ada → Bobby")
    expect((await request("PATCH", `/v1/bots/${bo.id}`, { name: "Bo" })).status).toBe(200)

    expect((await request("DELETE", `/v1/conversations/${id}`)).status).toBe(204)
    await ask(request, chat.id)
    const [again] = await handoffsOf(request)
    expect(again!.id).not.toBe(id)

    expect((await request("DELETE", `/v1/bots/${bo.id}`)).status).toBe(204)
    expect(await handoffsOf(request)).toEqual([])
    expect((await request("GET", `/v1/bots/${ada.id}`)).json.teammateIds).toEqual([])
    expect((await request("GET", `/v1/conversations/${chat.id}`)).status).toBe(200)
  })
})
