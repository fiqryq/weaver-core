import { BunHttpServer } from "@effect/platform-bun"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { AppRoutes } from "../../../src/main.ts"
import { say, scriptedModel, testLayer } from "../../support/layers.ts"

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

const makeClient = () => {
  const model = scriptedModel(() => say("Hi!"))
  const web = HttpRouter.toWebHandler(
    AppRoutes.pipe(Layer.provide(testLayer(model.layer)), Layer.provide(BunHttpServer.layerHttpServices)),
    { disableLogger: true }
  )
  dispose = web.dispose
  return async (method: string, path: string, body?: unknown, token: string | null = "test-token") => {
    const headers: Record<string, string> = {}
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers["content-type"] = "application/json"
    const response = await web.handler(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    )
    const text = await response.text()
    return { status: response.status, headers: response.headers, json: text.length > 0 ? JSON.parse(text) : undefined }
  }
}

describe("HTTP API", () => {
  it("serves health without a token and rejects bad tokens elsewhere", async () => {
    const request = makeClient()
    expect((await request("GET", "/v1/health", undefined, null)).json).toMatchObject({ status: "ok" })
    expect((await request("GET", "/v1/bots", undefined, null)).status).toBe(401)
    expect((await request("GET", "/v1/bots", undefined, "wrong")).status).toBe(401)
    expect((await request("GET", "/v1/bots")).status).toBe(200)
  })

  it("creates bots and conversations and validates input", async () => {
    const request = makeClient()
    expect((await request("POST", "/v1/bots", { name: "" })).status).toBe(400)
    const bot = (await request("POST", "/v1/bots", { name: "Ada", tools: ["files"] })).json
    expect(bot).toMatchObject({ name: "Ada", tools: ["files"], approvalMode: "ask" })

    expect((await request("POST", "/v1/conversations", { botIds: ["missing"] })).status).toBe(400)
    const conversation = (await request("POST", "/v1/conversations", { botIds: [bot.id] })).json
    expect(conversation.botIds).toEqual([bot.id])

    expect((await request("POST", `/v1/conversations/${conversation.id}/messages`, { text: "  " })).status).toBe(400)
    expect((await request("GET", "/v1/conversations/nope/messages")).status).toBe(404)

    const sent = (await request("POST", `/v1/conversations/${conversation.id}/messages`, { text: "hi" })).json
    expect(sent.message).toMatchObject({ role: "user", parts: [{ type: "text", text: "hi" }] })
    expect((await request("DELETE", `/v1/conversations/${conversation.id}/messages/missing`)).status).toBe(404)
    expect((await request("DELETE", `/v1/conversations/${conversation.id}/messages/${sent.message.id}`)).status).toBe(204)
    expect((await request("DELETE", `/v1/conversations/${conversation.id}/messages`)).status).toBe(204)
    expect((await request("GET", `/v1/conversations/${conversation.id}/messages`)).json).toEqual([])

    const renamed = (await request("PATCH", `/v1/bots/${bot.id}`, { name: "Ada Lovelace" })).json
    expect(renamed.name).toBe("Ada Lovelace")
    expect((await request("DELETE", `/v1/bots/${bot.id}`)).status).toBe(204)
    expect((await request("GET", `/v1/conversations/${conversation.id}`)).status).toBe(404)
  })

  it("sends the server's clock with conversation and message lists", async () => {
    const request = makeClient()
    const bot = (await request("POST", "/v1/bots", { name: "Ada" })).json
    const conversation = (await request("POST", "/v1/conversations", { botIds: [bot.id] })).json
    const before = new Date().toISOString()
    const sent = (await request("POST", `/v1/conversations/${conversation.id}/messages`, { text: "hi" })).json
    expect(sent.message.finishedAt).toBeNull()

    const list = await request("GET", "/v1/conversations")
    const messages = await request("GET", `/v1/conversations/${conversation.id}/messages`)
    for (const response of [list, messages]) {
      const now = response.headers.get("x-weaver-now")
      expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(now! >= before).toBe(true)
    }
    expect(Array.isArray(list.json)).toBe(true)
    expect(messages.json[0]).toMatchObject({ role: "user", finishedAt: null })
    expect((await request("GET", "/v1/bots")).headers.get("x-weaver-now")).toBeNull()
  })

  it("refuses to regenerate a conversation with no message from the user", async () => {
    const request = makeClient()
    const bot = (await request("POST", "/v1/bots", { name: "Ada" })).json
    const conversation = (await request("POST", "/v1/conversations", { botIds: [bot.id] })).json
    const response = await request("POST", `/v1/conversations/${conversation.id}/regenerate`)
    expect(response.status).toBe(400)
    expect(response.json.message).toBe("There's nothing to regenerate yet.")
  })

  it("never returns integration secrets and keeps them on update", async () => {
    const request = makeClient()
    const created = (await request("POST", "/v1/integrations", {
      name: "GitHub",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer real-secret" }
    })).json
    expect(created.headers.Authorization).toBe("********")

    const updated = (await request("PATCH", `/v1/integrations/${created.id}`, {
      name: "GitHub work",
      headers: { Authorization: "********" }
    })).json
    expect(updated.name).toBe("GitHub work")
    expect(JSON.stringify((await request("GET", "/v1/integrations")).json)).not.toContain("real-secret")
  })

  it("removes a deleted integration from the bots that used it", async () => {
    const request = makeClient()
    const integration = (await request("POST", "/v1/integrations", { name: "Docs", transport: "http", url: "https://example.com/mcp" })).json
    const bot = (await request("POST", "/v1/bots", { name: "Ada", integrationIds: [integration.id] })).json
    expect(bot.integrationIds).toEqual([integration.id])

    expect((await request("DELETE", `/v1/integrations/${integration.id}`)).status).toBe(204)
    expect((await request("GET", `/v1/bots/${bot.id}`)).json.integrationIds).toEqual([])
    expect((await request("PATCH", `/v1/bots/${bot.id}`, { label: "Still editable" })).status).toBe(200)
  })

  it("saves provider keys without exposing them", async () => {
    const request = makeClient()
    const saved = (await request("PUT", "/v1/providers/openai", { apiKey: "sk-secret", makeDefault: true })).json
    expect(saved).toMatchObject({ id: "openai", hasKey: true, isDefault: true })
    expect(JSON.stringify((await request("GET", "/v1/providers")).json)).not.toContain("sk-secret")
    expect((await request("PUT", "/v1/providers/nope", { apiKey: "x" })).status).toBe(404)
  })
})
