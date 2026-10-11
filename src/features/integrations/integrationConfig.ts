import type { Integration, IntegrationCreate } from "./Integration.ts"
import type { McpServerConfig } from "./McpHub.ts"

/** The connection settings for a stored integration. The key changes with the config, so edits reconnect. */
export const toMcpConfig = (integration: Integration): McpServerConfig => ({
  key: `${integration.id}:${Bun.hash(JSON.stringify([
    integration.transport,
    integration.command,
    integration.args,
    integration.env,
    integration.url,
    integration.headers
  ]))}`,
  name: integration.name,
  transport: integration.transport,
  command: integration.command,
  args: integration.args,
  env: integration.env,
  url: integration.url,
  headers: integration.headers
})

export const draftToMcpConfig = (draft: IntegrationCreate): McpServerConfig => ({
  key: `draft:${crypto.randomUUID()}`,
  name: draft.name,
  transport: draft.transport,
  command: draft.command ?? "",
  args: draft.args ?? [],
  env: draft.env ?? {},
  url: draft.url ?? "",
  headers: draft.headers ?? {}
})

/** Checks an integration's settings before saving, returning what's wrong or undefined. */
export const validateIntegration = (input: {
  transport: "stdio" | "http"
  command?: string | undefined
  url?: string | undefined
}): string | undefined => {
  if (input.transport === "stdio" && (input.command ?? "").trim().length === 0) {
    return "A command is required for a stdio MCP server."
  }
  if (input.transport === "http") {
    try {
      const url = new URL(input.url ?? "")
      if (url.protocol !== "http:" && url.protocol !== "https:") return "The URL must start with http:// or https://."
    } catch {
      return "Enter the MCP server's URL."
    }
  }
  return undefined
}
