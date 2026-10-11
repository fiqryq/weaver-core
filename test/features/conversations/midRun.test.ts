import { afterAll, afterEach, describe, expect, it } from "@effect/vitest"
import { startOpenAiMock } from "../../support/fixtures/openAiMock.ts"
import { makeApiClient } from "../../support/httpClient.ts"

const mock = startOpenAiMock()
afterAll(() => mock.close())

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

const slowReply = { text: Array.from({ length: 40 }, (_, index) => `word${index} `), delayMs: 25 }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A conversation whose bot is partway through a slowly streamed reply. */
const midReply = async () => {
  mock.setScript(() => slowReply)
  const api = makeApiClient()
  dispose = api.dispose
  expect((await api.request("PUT", "/v1/providers/custom", {
    baseUrl: mock.url,
    apiKey: "sk-mock",
    model: "mock-model",
    makeDefault: true
  })).status).toBe(200)
  const bot = (await api.request("POST", "/v1/bots", { name: "Ada", tools: [] })).json
  const conversation = (await api.request("POST", "/v1/conversations", { botIds: [bot.id] })).json
  const events = await api.events(conversation.id)
  await api.request("POST", `/v1/conversations/${conversation.id}/messages`, { text: "Tell me a long story" })
  await events.waitFor((event) => event.type === "text-delta")
  return { api, bot, conversation, events }
}

/** The run was cancelled, and nothing about it arrives afterwards while the model would still be streaming. */
const expectStoppedFor = async (events: Awaited<ReturnType<ReturnType<typeof makeApiClient>["events"]>>) => {
  const finished = await events.waitFor((event) => event.type === "run-finished")
  expect(finished).toMatchObject({ status: "cancelled" })
  await sleep(300)
  expect(events.received.slice(events.received.indexOf(finished) + 1)).toEqual([])
}

describe("changing a conversation while a bot replies", () => {
  it("clearing the messages stops the reply for good", async () => {
    const { api, conversation, events } = await midReply()
    expect((await api.request("DELETE", `/v1/conversations/${conversation.id}/messages`)).status).toBe(204)
    await expectStoppedFor(events)
    expect((await api.request("GET", `/v1/conversations/${conversation.id}/messages`)).json).toEqual([])
    await events.close()

    mock.setScript(() => ({ text: "A fresh reply." }))
    const next = await api.events(conversation.id)
    await api.request("POST", `/v1/conversations/${conversation.id}/messages`, { text: "Hi again" })
    await next.waitFor((event) => event.type === "run-finished")
    const messages = (await api.request("GET", `/v1/conversations/${conversation.id}/messages`)).json
    expect(messages.map((message: { role: string; status: string }) => [message.role, message.status])).toEqual([
      ["user", "done"],
      ["assistant", "done"]
    ])
    await next.close()
  })

  it("deleting the conversation stops the reply without errors", async () => {
    const { api, conversation, events } = await midReply()
    expect((await api.request("DELETE", `/v1/conversations/${conversation.id}`)).status).toBe(204)
    await expectStoppedFor(events)
    expect(events.received.some((event) => event.type === "error")).toBe(false)
    expect((await api.request("GET", `/v1/conversations/${conversation.id}`)).status).toBe(404)
    await events.close()
  })

  it("deleting the streaming reply doesn't bring it back", async () => {
    const { api, conversation, events } = await midReply()
    const messages = (await api.request("GET", `/v1/conversations/${conversation.id}/messages`)).json
    const reply = messages.find((message: { role: string }) => message.role === "assistant")
    expect((await api.request("DELETE", `/v1/conversations/${conversation.id}/messages/${reply.id}`)).status).toBe(204)
    await events.waitFor((event) => event.type === "run-finished")
    expect(events.received.some((event) => event.type === "message-done")).toBe(false)
    const remaining = (await api.request("GET", `/v1/conversations/${conversation.id}/messages`)).json
    expect(remaining.map((message: { role: string }) => message.role)).toEqual(["user"])
    await events.close()
  })
})
