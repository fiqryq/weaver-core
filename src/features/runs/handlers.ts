import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { BadRequest } from "../../platform/http/errors.ts"
import { AgentRunner } from "./AgentRunner.ts"
import { Approvals } from "./Approvals.ts"

export const RunsHandlers = HttpApiBuilder.group(
  Api,
  "runs",
  Effect.fn(function*(handlers) {
    const runner = yield* AgentRunner
    const approvals = yield* Approvals
    return handlers
      .handle("cancel", ({ params }) => runner.cancelRun(params.id))
      .handle("approve", ({ params, payload }) =>
        Effect.gen(function*() {
          const found = yield* approvals.resolve(params.id, payload.approved)
          if (!found) return yield* new BadRequest({ message: "Nothing is waiting for that approval." })
        }))
  })
)
