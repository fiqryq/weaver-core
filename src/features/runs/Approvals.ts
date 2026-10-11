import { Context, Deferred, Effect, Layer } from "effect"

/** Tool calls waiting for the person to approve or deny them. Runs block on these while they're pending. */
export class Approvals extends Context.Service<Approvals, {
  /**
   * Registers the request, runs `announce` (which tells the person), then waits until `resolve` is called.
   * Interrupting the wait forgets the request.
   */
  wait<E, R>(approvalId: string, announce: Effect.Effect<void, E, R>): Effect.Effect<boolean, E, R>
  /** False when nothing is waiting on this id (already answered, or the run ended). */
  resolve(approvalId: string, approved: boolean): Effect.Effect<boolean>
  readonly pending: Effect.Effect<ReadonlyArray<string>>
}>()("weaver/Approvals") {
  static readonly layer = Layer.sync(Approvals, () => {
    const waiting = new Map<string, Deferred.Deferred<boolean>>()

    const wait = <E, R>(approvalId: string, announce: Effect.Effect<void, E, R>) =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<boolean>()
        waiting.set(approvalId, deferred)
        yield* announce
        return yield* Deferred.await(deferred)
      }).pipe(Effect.ensuring(Effect.sync(() => waiting.delete(approvalId))))

    const resolve = (approvalId: string, approved: boolean) =>
      Effect.suspend(() => {
        const deferred = waiting.get(approvalId)
        if (deferred === undefined) return Effect.succeed(false)
        waiting.delete(approvalId)
        return Deferred.succeed(deferred, approved)
      })

    return Approvals.of({
      wait,
      resolve,
      pending: Effect.sync(() => [...waiting.keys()])
    })
  })
}
