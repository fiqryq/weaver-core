import { Context, Effect, Layer, PubSub, Stream } from "effect"
import type { RunEvent } from "./Events.ts"

/** Events a subscriber can fall behind by before its oldest unread ones are dropped. */
export const subscriberCapacity = 1024

/**
 * In-process event bus for run progress; the SSE endpoint streams it to clients.
 * Publishing never waits on subscribers: one that falls more than `subscriberCapacity` events
 * behind (e.g. a slow SSE client) loses the oldest, and catches up from the messages endpoint.
 */
export class RunEvents extends Context.Service<RunEvents, {
  publish(event: RunEvent): Effect.Effect<void>
  /** Events for one conversation, or for all of them when `conversationId` is omitted. */
  subscribe(conversationId?: string): Stream.Stream<RunEvent>
}>()("weaver/RunEvents") {
  static readonly layer = Layer.effect(
    RunEvents,
    Effect.gen(function*() {
      const pubsub = yield* PubSub.sliding<RunEvent>(subscriberCapacity)
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

      return RunEvents.of({
        publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
        subscribe: (conversationId) => {
          const all = Stream.fromPubSub(pubsub)
          return conversationId === undefined
            ? all
            : all.pipe(Stream.filter((event) => "conversationId" in event && event.conversationId === conversationId))
        }
      })
    })
  )
}
