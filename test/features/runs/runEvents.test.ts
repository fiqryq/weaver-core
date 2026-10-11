import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Stream } from "effect"
import type { RunEvent } from "../../../src/features/runs/Events.ts"
import { RunEvents, subscriberCapacity } from "../../../src/features/runs/RunEvents.ts"

const activity = (index: number): RunEvent => ({ type: "activity", conversationId: "c1", text: String(index) })

describe("RunEvents", () => {
  it.live("never makes publishers wait on a slow subscriber, which keeps only the newest events", () =>
    Effect.gen(function*() {
      const events = yield* RunEvents
      const total = subscriberCapacity * 3
      const gate = yield* Deferred.make<void>()
      const slow: Array<RunEvent> = []
      const slowFiber = yield* events.subscribe().pipe(
        Stream.runForEach((event) =>
          Effect.andThen(Deferred.await(gate), Effect.sync(() => void slow.push(event)))
        ),
        Effect.forkChild
      )
      const fast = yield* events.subscribe("c1").pipe(Stream.take(total), Stream.runCollect, Effect.forkChild)
      yield* Effect.sleep(Duration.millis(20))

      yield* Effect.forEach(Array.from({ length: total }, (_, index) => activity(index)), events.publish, { discard: true }).pipe(
        Effect.timeout(Duration.seconds(2))
      )
      expect(yield* Fiber.join(fast)).toHaveLength(total)

      yield* Deferred.succeed(gate, undefined)
      yield* Effect.sleep(Duration.millis(50))
      yield* Fiber.interrupt(slowFiber)
      expect(slow.length).toBeLessThanOrEqual(subscriberCapacity + 1)
      expect(slow.at(-1)).toEqual(activity(total - 1))
    }).pipe(Effect.provide(RunEvents.layer)))
})
