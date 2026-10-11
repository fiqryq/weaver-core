import { Schema } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String
}, { httpApiStatus: 401 }) {}

/** Every route except health requires `Authorization: Bearer <WEAVER_TOKEN>`. */
export class Authorization extends HttpApiMiddleware.Service<Authorization>()("weaver/api/Authorization", {
  requiredForClient: true,
  security: {
    bearer: HttpApiSecurity.bearer
  },
  error: Unauthorized
}) {}

/** Constant-time comparison, so response timing doesn't leak how much of a token matched. */
export const tokensMatch = (given: string, expected: string): boolean => {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
