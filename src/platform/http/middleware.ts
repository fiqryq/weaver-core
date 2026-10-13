import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { AppConfig } from "../../config/Config.ts"

/** HTTP middleware that enforces a maximum request body size */
export class RequestTooLarge extends Error {
  readonly _tag = "RequestTooLarge"
  constructor(readonly size: number, readonly maxSize: number) {
    super(`Request body too large: ${size} bytes (max ${maxSize} bytes)`)
  }
}

/**
 * Middleware to enforce maximum request body size.
 * Returns 413 Payload Too Large if the request exceeds the configured limit.
 */
export const bodySize = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
): Effect.Effect<HttpServerResponse.HttpServerResponse, E | RequestTooLarge, R | AppConfig | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function*() {
    const config = yield* AppConfig
    const request = yield* HttpServerRequest.HttpServerRequest
    
    // Check Content-Length header if present
    const contentLength = request.headers["content-length"]
    if (contentLength !== undefined) {
      const size = Number.parseInt(contentLength, 10)
      if (!Number.isNaN(size) && size > config.maxBodyBytes) {
        return HttpServerResponse.jsonUnsafe(
          {
            _tag: "RequestTooLarge",
            message: `Request body too large: ${size} bytes (max ${config.maxBodyBytes} bytes)`
          },
          { status: 413 }
        )
      }
    }
    
    return yield* effect
  })
