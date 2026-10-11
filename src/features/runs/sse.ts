import { Duration, Effect, Redacted, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { AppConfig } from "../../config/Config.ts"
import { tokensMatch } from "../../platform/http/Authorization.ts"
import type { RunEvent } from "./Events.ts"
import { RunEvents } from "./RunEvents.ts"

export const encodeEvent = (event: RunEvent): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

/**
 * Server-sent events: `/v1/events` streams every conversation, `/v1/conversations/:id/events` one of them.
 * A comment line every 15 seconds keeps idle connections open through proxies. Runs never wait on a
 * slow client: it misses the oldest events it hasn't read (see `RunEvents`) and catches up from the
 * messages endpoint.
 */
export const EventsRoutes = HttpRouter.use(Effect.fn(function*(router) {
  const config = yield* AppConfig
  const events = yield* RunEvents
  const expected = Redacted.value(config.token)

  const respond = (conversationId: string | undefined) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const header = request.headers["authorization"] ?? ""
      const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : ""
      if (!tokensMatch(token, expected)) {
        return HttpServerResponse.jsonUnsafe(
          { _tag: "Unauthorized", message: "Missing or invalid bearer token." },
          { status: 401 }
        )
      }
      const body = Stream.merge(
        events.subscribe(conversationId).pipe(Stream.map(encodeEvent)),
        Stream.tick(Duration.seconds(15)).pipe(Stream.map(() => ": ping\n\n"))
      ).pipe(Stream.encodeText)
      return HttpServerResponse.stream(body, {
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache",
          "x-accel-buffering": "no"
        }
      })
    })

  yield* router.add("GET", "/v1/events", (request) => {
    const url = new URL(request.url, "http://localhost")
    return respond(url.searchParams.get("conversationId") ?? undefined)
  })
  yield* router.add("GET", "/v1/conversations/:id/events", Effect.flatMap(HttpRouter.params, (params) => respond(params.id)))
}))
