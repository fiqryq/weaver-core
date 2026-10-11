import { Effect, Predicate } from "effect"
import type { McpHub, McpServerConfig, McpTool } from "../../features/integrations/McpHub.ts"
import { truncate } from "../../platform/lib/util.ts"
import { type AgentTool, shorten, ToolFailure } from "../AgentTool.ts"

export const mcpOutputLimit = 12_000

/** OpenAI-style function names allow letters, digits, `_` and `-`, up to 64 characters. */
export const sanitizeToolName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20) || "app"

const firstStringArg = (params: unknown): string | undefined => {
  if (!Predicate.isObject(params)) return undefined
  for (const key of ["url", "query", "identifier", "title", "path", "text", "name"]) {
    const value = (params as Record<string, unknown>)[key]
    if (Predicate.isString(value) && value.length > 0) return value
  }
  return undefined
}

export interface McpToolOptions {
  readonly hub: McpHub["Service"]
  readonly server: McpServerConfig
  readonly tool: McpTool
  /** The name the model sees (prefixed and sanitized). */
  readonly exposedName: string
  readonly activity: string
  readonly title?: (params: unknown) => string
  /** Rewrites arguments before the call, e.g. to pin a project. */
  readonly prepare?: (params: Record<string, unknown>) => Record<string, unknown>
  readonly label?: string
}

export const mcpTool = (options: McpToolOptions): AgentTool => ({
  name: options.exposedName,
  description: options.label === undefined ? options.tool.description : `[${options.label}] ${options.tool.description}`,
  parameters: options.tool.inputSchema,
  needsApproval: false,
  activity: options.activity,
  title: options.title ??
    ((params) => {
      const detail = firstStringArg(params)
      const base = `${options.label ?? options.server.name}: ${options.tool.name.replace(/_/g, " ")}`
      return detail === undefined ? base : `${base} (${shorten(detail, 50)})`
    }),
  run: (params) => {
    const args = Predicate.isObject(params) ? { ...(params as Record<string, unknown>) } : {}
    return options.hub.call(options.server, options.tool.name, options.prepare ? options.prepare(args) : args).pipe(
      Effect.mapError((error) => new ToolFailure({ message: `${options.server.name}: ${error.message}` })),
      Effect.flatMap((result) => {
        const text = truncate(result.text || "(no output)", mcpOutputLimit)
        return result.isError ? Effect.fail(new ToolFailure({ message: text })) : Effect.succeed(text)
      })
    )
  }
})

/** Titles for the Playwright MCP tools, so tool steps read like what happened. */
export const browserTitle = (name: string) => (params: unknown): string => {
  const detail = firstStringArg(params)
  switch (name) {
    case "browser_navigate":
      return detail ? `Opened ${shorten(detail, 60)}` : "Opened a page"
    case "browser_click":
      return `Clicked ${shorten((params as { element?: string })?.element ?? "an element", 50)}`
    case "browser_type":
      return `Typed into ${shorten((params as { element?: string })?.element ?? "a field", 50)}`
    case "browser_snapshot":
      return "Read the page"
    case "browser_take_screenshot":
      return "Took a screenshot"
    default:
      return `Browser: ${name.replace(/^browser_/, "").replace(/_/g, " ")}`
  }
}
