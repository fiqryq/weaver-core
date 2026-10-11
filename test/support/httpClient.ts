import { BunHttpServer } from "@effect/platform-bun"
import type { AppConfigShape } from "../../src/config/Config.ts"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import type { RunEvent } from "../../src/features/runs/Events.ts"
import { AppRoutes } from "../../src/main.ts"
import { realModelLayer } from "./realModel.ts"

/** The whole HTTP API in process, with models reached through the real OpenAI-compatible client. */
export const makeApiClient = (config: Partial<AppConfigShape> = {}) => {
  const web = HttpRouter.toWebHandler(
    AppRoutes.pipe(Layer.provide(realModelLayer(config)), Layer.provide(BunHttpServer.layerHttpServices)),
    { disableLogger: true }
  )
  const headers = (body: unknown) => ({
    authorization: "Bearer test-token",
    ...(body !== undefined ? { "content-type": "application/json" } : {})
  })

  const request = async (method: string, path: string, body?: unknown) => {
    const response = await web.handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: headers(body),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    )
    const text = await response.text()
    // deno-lint-ignore no-explicit-any
    return { status: response.status, json: (text.length > 0 ? JSON.parse(text) : undefined) as any }
  }

  /** Opens `/v1/conversations/:id/events` and collects every event until closed. */
  const events = async (conversationId: string) => {
    const response = await web.handler(
      new Request(`http://localhost/v1/conversations/${conversationId}/events`, { headers: headers(undefined) })
    )
    const reader = response.body!.getReader()
    const received: Array<RunEvent> = []
    const waiters: Array<() => void> = []
    const decoder = new TextDecoder()
    let buffer = ""
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = block.split("\n").find((line) => line.startsWith("data: "))
          if (data !== undefined) received.push(JSON.parse(data.slice(6)) as RunEvent)
        }
        waiters.splice(0).forEach((wake) => wake())
      }
    })()
    const waitFor = async (predicate: (event: RunEvent) => boolean, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs
      while (!received.some(predicate)) {
        if (Date.now() > deadline) throw new Error(`Timed out; got ${received.map((event) => event.type).join(", ")}`)
        await new Promise<void>((resolve) => {
          waiters.push(resolve)
          setTimeout(resolve, 50)
        })
      }
      return received.find(predicate)!
    }
    const close = async () => {
      await reader.cancel().catch(() => undefined)
      await pump
    }
    // Let the subscription attach before anything is published.
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { received, waitFor, close }
  }

  return { request, events, dispose: web.dispose }
}
