import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { AppConfig } from "../../../src/config/Config.ts"
import { bodySize } from "../../../src/platform/http/middleware.ts"

describe("bodySize middleware", () => {
  const mockConfig = AppConfig.layerTest({ maxBodyBytes: 1024 * 1024 }) // 1MB for tests

  const createMockRequest = (contentLength?: string) => ({
    headers: contentLength !== undefined ? { "content-length": contentLength } : {},
    url: "http://localhost/test"
  })

  it("allows requests within size limit", async () => {
    const request = createMockRequest("1000") // 1000 bytes
    const effect = bodySize(
      Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }))
    )

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request as any),
        Effect.provide(mockConfig)
      )
    )

    expect(result.status).toBe(200)
  })

  it("rejects requests exceeding size limit", async () => {
    const request = createMockRequest("10000000") // 10MB (exceeds 1MB limit)
    const effect = bodySize(
      Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }))
    )

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request as any),
        Effect.provide(mockConfig)
      )
    )

    expect(result.status).toBe(413)
  })

  it("allows requests without Content-Length header", async () => {
    const request = createMockRequest() // No Content-Length
    const effect = bodySize(
      Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }))
    )

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request as any),
        Effect.provide(mockConfig)
      )
    )

    expect(result.status).toBe(200)
  })

  it("allows requests at exactly the size limit", async () => {
    const request = createMockRequest("1048576") // Exactly 1MB
    const effect = bodySize(
      Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }))
    )

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request as any),
        Effect.provide(mockConfig)
      )
    )

    expect(result.status).toBe(200)
  })

  it("rejects requests one byte over the limit", async () => {
    const request = createMockRequest("1048577") // 1MB + 1 byte
    const effect = bodySize(
      Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }))
    )

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request as any),
        Effect.provide(mockConfig)
      )
    )

    expect(result.status).toBe(413)
  })

  it("handles invalid Content-Length gracefully", async () => {
    const request = createMockRequest("not-a-number")
    const effect = bodySize(
      Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }))
    )

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request as any),
        Effect.provide(mockConfig)
      )
    )

    // Should pass through since we can't parse the size
    expect(result.status).toBe(200)
  })
})
