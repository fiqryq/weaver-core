import { Effect, Schema } from "effect"

export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", {
  message: Schema.String
}) {}

/** A function the model can call. Output is plain text; failures are reported back to the model, not thrown. */
export interface AgentTool {
  readonly name: string
  readonly description: string
  /** JSON Schema for the arguments, sent to the model as-is. */
  readonly parameters: Record<string, unknown>
  /** Pauses for the person's approval first, when the bot's approval mode is `ask`. */
  readonly needsApproval: boolean
  /** Short label for the typing indicator while it runs, e.g. "Running a command". */
  readonly activity: string
  /** Human summary of a call, e.g. "Ran `ls -la`". */
  title(params: unknown): string
  run(params: unknown): Effect.Effect<string, ToolFailure>
}

/** Runs a call, reporting a crash inside the tool as a failed call instead of failing the whole reply. */
export const runTool = (tool: AgentTool, params: unknown): Effect.Effect<string, ToolFailure> =>
  tool.run(params).pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(new ToolFailure({ message: `${tool.name} failed unexpectedly: ${defect instanceof Error ? defect.message : String(defect)}` }))
    )
  )

/** Decodes the model's arguments with a schema, turning mistakes into a failure the model can correct. */
export const decodeParams = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, params: unknown) =>
  Schema.decodeUnknownEffect(schema)(params ?? {}).pipe(
    Effect.mapError((error) => new ToolFailure({ message: `Invalid arguments: ${error.message}` }))
  )

/** JSON Schema for a tool's arguments. */
export const jsonSchemaOf = (schema: Schema.Top): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(schema)
  const { $schema: _, ...rest } = document.schema as Record<string, unknown>
  return Object.keys(document.definitions).length > 0 ? { ...rest, $defs: document.definitions } : rest
}

export const shorten = (text: string, limit = 80): string => {
  const single = text.replace(/\s+/g, " ").trim()
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`
}
