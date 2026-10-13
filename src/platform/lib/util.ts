import { DateTime, Effect, Schema } from "effect"

export const newId = (): string => crypto.randomUUID()

export const nowIso: Effect.Effect<string> = Effect.map(DateTime.now, DateTime.formatIso)

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String))
const StringRecordJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

export const decodeStringArray = (raw: unknown): ReadonlyArray<string> => {
  try {
    return Schema.decodeUnknownSync(StringArrayJson)(raw)
  } catch {
    return []
  }
}

export const decodeStringRecord = (raw: unknown): Record<string, string> => {
  try {
    return { ...Schema.decodeUnknownSync(StringRecordJson)(raw) }
  } catch {
    return {}
  }
}

/** The server's environment without its own secrets (`WEAVER_*`), for bot commands and MCP servers. */
export const childEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && !entry[0].startsWith("WEAVER_")
    )
  )

/** Cuts long tool output so one call can't flood the model's context. */
export const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated, ${text.length - limit} more characters)`

export const orDieWithLog = <A, E>(effect: Effect.Effect<A, E, never>) =>
  effect.pipe(Effect.tapError((error) => Effect.logError("SQL operation failed", error)), Effect.orDie)
