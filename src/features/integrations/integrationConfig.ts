import type { Integration, IntegrationAuth, IntegrationCreate } from "./Integration.ts"
import type { McpAuthProvider, McpServerConfig } from "./McpHub.ts"

/**
 * The connection settings for a stored integration. The key changes with the config, so edits reconnect,
 * but not with OAuth tokens, which the provider reads fresh on every request.
 */
export const toMcpConfig = (integration: Integration, authProvider?: McpAuthProvider): McpServerConfig => ({
  key: `${integration.id}:${Bun.hash(JSON.stringify([
    integration.transport,
    integration.command,
    integration.args,
    integration.env,
    integration.url,
    integration.headers,
    integration.auth
  ]))}`,
  name: integration.name,
  transport: integration.transport,
  command: integration.command,
  args: integration.args,
  env: integration.env,
  url: integration.url,
  headers: integration.headers,
  ...(authProvider !== undefined && integration.auth === "oauth" ? { authProvider } : {})
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

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"])

/** Checks an integration's settings before saving, returning what's wrong or undefined. */
export const validateIntegration = (input: {
  transport: "stdio" | "http"
  command?: string | undefined
  url?: string | undefined
  auth?: IntegrationAuth | undefined
}): string | undefined => {
  if (input.transport === "stdio" && (input.command ?? "").trim().length === 0) {
    return "A command is required for a stdio MCP server."
  }
  if (input.auth === "oauth" && input.transport !== "http") {
    return "Sign-in only works with HTTP MCP servers."
  }
  if (input.transport === "http") {
    let url: URL
    try {
      url = new URL(input.url ?? "")
    } catch {
      return "Enter the MCP server's URL."
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "The URL must start with http:// or https://."
    if (input.auth === "oauth" && url.protocol !== "https:" && !loopbackHosts.has(url.hostname)) {
      return "Sign-in needs an https:// URL."
    }
  }
  return undefined
}

/** Whether a redirect goes back to the Mac over loopback: `http://127.0.0.1:<port>/…`, `localhost` or `[::1]`. */
export const isLoopbackRedirect = (redirectUri: string): boolean => {
  try {
    const url = new URL(redirectUri)
    return url.protocol === "http:" && loopbackHosts.has(url.hostname) && url.port !== "" && url.username === "" &&
      url.password === ""
  } catch {
    return false
  }
}
