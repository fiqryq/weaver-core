import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { Context, Duration, Effect, Layer, RcMap, Schema } from "effect"
import { version } from "../../config/Config.ts"
import { childEnv } from "../../platform/lib/util.ts"
import { IntegrationTestResult, IntegrationTool } from "./Integration.ts"

/** Everything needed to reach one MCP server. `key` identifies a shared connection. */
export interface McpServerConfig {
  readonly key: string
  readonly name: string
  readonly transport: "stdio" | "http"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly cwd?: string
}

export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  readonly text: string
  readonly isError: boolean
}

export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  server: Schema.String,
  message: Schema.String
}) {}

interface Connection {
  readonly client: Client
  tools: ReadonlyArray<McpTool> | undefined
}

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const makeTransport = (config: McpServerConfig, legacySse: boolean): Transport => {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: { ...getDefaultEnvironment(), ...childEnv(), ...config.env },
      stderr: "ignore",
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {})
    })
  }
  const url = new URL(config.url)
  const requestInit = { headers: { ...config.headers } }
  return legacySse
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit }) as Transport
}

const connect = (config: McpServerConfig): Effect.Effect<Client, McpError> =>
  Effect.tryPromise({
    try: async () => {
      const open = async (legacySse: boolean) => {
        const client = new Client({ name: "weaver", version })
        await client.connect(makeTransport(config, legacySse))
        return client
      }
      try {
        return await open(false)
      } catch (error) {
        // Older HTTP servers only speak the SSE transport.
        if (config.transport === "http") return await open(true)
        throw error
      }
    },
    catch: (cause) => new McpError({ server: config.name, message: `Couldn't connect: ${errorMessage(cause)}` })
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(90),
      orElse: () => Effect.fail(new McpError({ server: config.name, message: "Timed out connecting." }))
    })
  )

const listTools = (config: McpServerConfig, client: Client): Effect.Effect<ReadonlyArray<McpTool>, McpError> =>
  Effect.tryPromise({
    try: async () => {
      const tools: Array<McpTool> = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor })
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            description: (tool.description ?? tool.name).slice(0, 1000),
            inputSchema: (tool.inputSchema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} }
          })
        }
        cursor = page.nextCursor
      } while (cursor !== undefined)
      return tools
    },
    catch: (cause) => new McpError({ server: config.name, message: `Couldn't list tools: ${errorMessage(cause)}` })
  })

/** Flattens MCP content blocks into text a model can read. */
export const contentToText = (result: { content?: unknown; structuredContent?: unknown }): string => {
  const blocks = Array.isArray(result.content) ? result.content : []
  const parts = blocks.map((block: { type?: string; text?: string; uri?: string; resource?: { text?: string; uri?: string } }) => {
    switch (block.type) {
      case "text":
        return block.text ?? ""
      case "image":
        return "[image]"
      case "audio":
        return "[audio]"
      case "resource":
        return block.resource?.text ?? `[resource ${block.resource?.uri ?? ""}]`
      case "resource_link":
        return `[resource ${block.uri ?? ""}]`
      default:
        return JSON.stringify(block)
    }
  }).filter((text) => text.length > 0)
  if (parts.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
  return parts.join("\n")
}

/** Keeps MCP connections open while they're in use and for a while after, shared across runs. */
export class McpHub extends Context.Service<McpHub, {
  tools(config: McpServerConfig): Effect.Effect<ReadonlyArray<McpTool>, McpError>
  call(
    config: McpServerConfig,
    name: string,
    args: Record<string, unknown>,
    timeout?: Duration.Duration
  ): Effect.Effect<McpCallResult, McpError>
  /** Connects without caching, lists the tools and disconnects. */
  test(config: McpServerConfig): Effect.Effect<IntegrationTestResult>
  invalidate(key: string): Effect.Effect<void>
}>()("weaver/McpHub") {
  static readonly layer = Layer.effect(
    McpHub,
    Effect.gen(function*() {
      const configs = new Map<string, McpServerConfig>()

      const connections = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.suspend(() => {
              const config = configs.get(key)
              if (config === undefined) {
                return Effect.fail(new McpError({ server: key, message: "Unknown integration." }))
              }
              return Effect.map(connect(config), (client): Connection => ({ client, tools: undefined }))
            }),
            (connection) => Effect.promise(() => connection.client.close().catch(() => undefined))
          ),
        idleTimeToLive: Duration.minutes(10)
      })

      const withConnection = <A>(
        config: McpServerConfig,
        use: (connection: Connection) => Effect.Effect<A, McpError>
      ): Effect.Effect<A, McpError> =>
        Effect.suspend(() => {
          configs.set(config.key, config)
          return RcMap.get(connections, config.key).pipe(
            Effect.flatMap(use),
            Effect.scoped,
            // A broken connection is dropped so the next call reconnects.
            Effect.tapError(() => RcMap.invalidate(connections, config.key))
          )
        })

      const tools = (config: McpServerConfig) =>
        withConnection(config, (connection) =>
          connection.tools !== undefined
            ? Effect.succeed(connection.tools)
            : Effect.tap(listTools(config, connection.client), (listed) =>
              Effect.sync(() => {
                connection.tools = listed
              })))

      const call = (
        config: McpServerConfig,
        name: string,
        args: Record<string, unknown>,
        timeout: Duration.Duration = Duration.minutes(2)
      ) =>
        withConnection(config, (connection) =>
          Effect.tryPromise({
            try: (signal) =>
              connection.client.callTool({ name, arguments: args }, undefined, {
                signal,
                timeout: Duration.toMillis(timeout)
              }),
            catch: (cause) => new McpError({ server: config.name, message: errorMessage(cause) })
          }).pipe(
            Effect.map((result) => ({
              text: contentToText(result as { content?: unknown; structuredContent?: unknown }),
              isError: result.isError === true
            }))
          ))

      const test = (config: McpServerConfig) =>
        Effect.acquireUseRelease(
          connect(config),
          (client) => listTools(config, client),
          (client) => Effect.promise(() => client.close().catch(() => undefined))
        ).pipe(
          Effect.map((listed) =>
            new IntegrationTestResult({
              ok: true,
              tools: listed.map((tool) => new IntegrationTool({ name: tool.name, description: tool.description })),
              error: null
            })
          ),
          Effect.catch((error) => Effect.succeed(new IntegrationTestResult({ ok: false, tools: [], error: error.message })))
        )

      return McpHub.of({
        tools,
        call,
        test,
        invalidate: (key) => RcMap.invalidate(connections, key)
      })
    })
  )
}
