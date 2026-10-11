import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { defaultProviderId } from "../providers/Provider.ts"
import { Profile, type ProfileUpdate } from "./Profile.ts"

/** Small key/value settings: the person's profile and the default provider. */
export class Settings extends Context.Service<Settings, {
  readonly profile: Effect.Effect<Profile>
  updateProfile(update: ProfileUpdate): Effect.Effect<Profile>
  readonly defaultProviderId: Effect.Effect<string>
  setDefaultProviderId(id: string): Effect.Effect<void>
}>()("weaver/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const read = (key: string) =>
        sql<{ value: string }>`SELECT value FROM settings WHERE key = ${key}`.pipe(
          Effect.map((rows) => rows[0]?.value),
          Effect.orDie
        )

      const write = (key: string, value: string) =>
        sql`INSERT INTO settings (key, value) VALUES (${key}, ${value})
            ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(Effect.asVoid, Effect.orDie)

      const profile = Effect.gen(function*() {
        return new Profile({
          displayName: (yield* read("displayName")) ?? "",
          email: (yield* read("email")) ?? "",
          timezone: (yield* read("timezone")) ?? ""
        })
      })

      const updateProfile = Effect.fn("Settings.updateProfile")(function*(update: ProfileUpdate) {
        if (update.displayName !== undefined) yield* write("displayName", update.displayName.trim())
        if (update.email !== undefined) yield* write("email", update.email.trim())
        if (update.timezone !== undefined) yield* write("timezone", update.timezone.trim())
        return yield* profile
      })

      return Settings.of({
        profile,
        updateProfile,
        defaultProviderId: Effect.map(read("defaultProviderId"), (id) => id || defaultProviderId),
        setDefaultProviderId: (id) => write("defaultProviderId", id)
      })
    })
  )
}
