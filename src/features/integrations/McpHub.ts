import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { ErrorCode, McpError as ProtocolError } from "@modelcontextprotocol/sdk/types.js"
import { Context, Duration, Effect, Layer, RcMap, Schema, type Scope } from "effect"
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
  /** Signs HTTP requests in with OAuth and refreshes the tokens. */
  readonly authProvider?: McpAuthProvider
}

/** The person has to sign in (again) before the server can be used; the message says how. */
export class SignInRequired extends Error {}

export interface McpAuthProvider extends OAuthClientProvider {
  /** Records that the stored sign-in no longer works, answering the error to report. */
  signInRequired(): Promise<SignInRequired>
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
  /** The transport closed, e.g. the server process exited. */
  closed: boolean
}

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** How long a server that let a call time out gets to answer a ping before it's restarted. */
const pingTimeout = Duration.seconds(5)

/**
 * Whether a failed request means the connection is broken. A JSON-RPC error answers just that one
 * request, so the connection stays; anything else (closed pipes, network errors) needs a reconnect.
 */
const isConnectionFailure = (cause: unknown): boolean =>
  !(cause instanceof ProtocolError) || cause.code === ErrorCode.ConnectionClosed

const isTimeout = (cause: unknown): boolean => cause instanceof ProtocolError && cause.code === ErrorCode.RequestTimeout

/** Closing a stdio client ends the server process, escalating to SIGKILL if it doesn't exit. */
const closeClient = (client: Client) => Effect.promise(() => client.close().catch(() => undefined))

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
  const options = {
    requestInit: { headers: { ...config.headers } },
    ...(config.authProvider !== undefined ? { authProvider: config.authProvider } : {})
  }
  return legacySse
    ? new SSEClientTransport(url, options)
    : new StreamableHTTPClientTransport(url, options) as Transport
}

/** The server turned the stored sign-in down, e.g. a 401 right after refreshing the token. */
const isAuthFailure = (cause: unknown): boolean =>
  cause instanceof SignInRequired ||
  cause instanceof UnauthorizedError ||
  ((cause instanceof StreamableHTTPError || cause instanceof SseError) && cause.code === 401)

/** What to report for a failure; sign-in problems say how to sign in instead of how the request failed. */
const failureMessage = (config: McpServerConfig, cause: unknown, describe: (cause: unknown) => string) => {
  if (cause instanceof SignInRequired) return Effect.succeed(cause.message)
  const provider = config.authProvider
  if (provider !== undefined && isAuthFailure(cause)) {
    return Effect.promise(() => provider.signInRequired().then((error) => error.message, () => describe(cause)))
  }
  return Effect.succeed(describe(cause))
}

const failWith = (config: McpServerConfig, describe: (cause: unknown) => string) => (cause: unknown) =>
  Effect.flatMap(failureMessage(config, cause, describe), (message) => Effect.fail(new McpError({ server: config.name, message })))

/** Connects once; a client that doesn't finish connecting, including on timeout, is closed again. */
const open = (config: McpServerConfig, legacySse: boolean): Effect.Effect<Client, unknown> =>
  Effect.suspend(() => {
    const client = new Client({ name: "weaver", version })
    return Effect.tryPromise({
      try: (signal) => client.connect(makeTransport(config, legacySse), { signal }),
      catch: (cause) => cause
    }).pipe(
      Effect.onError(() => closeClient(client)),
      Effect.as(client)
    )
  })

const connect = (config: McpServerConfig): Effect.Effect<Client, McpError> =>
  open(config, false).pipe(
    // Older HTTP servers only speak the SSE transport.
    Effect.catch((error) =>
      config.transport === "http" && !isAuthFailure(error) ? open(config, true) : Effect.fail(error)
    ),
    Effect.catch(failWith(config, (cause) => `Couldn't connect: ${errorMessage(cause)}`)),
    Effect.timeoutOrElse({
      duration: Duration.seconds(90),
      orElse: () => Effect.fail(new McpError({ server: config.name, message: "Timed out connecting." }))
    })
  )

const listTools = (client: Client): Effect.Effect<ReadonlyArray<McpTool>, unknown> =>
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
    catch: (cause) => cause
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
      /** The live connection for each key, so dropping a stale one never drops its replacement. */
      const current = new Map<string, Connection>()

      // Concurrent calls for a key share one connect, and the layer's shutdown closes every connection.
      const connections = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.suspend(() => {
              const config = configs.get(key)
              if (config === undefined) {
                return Effect.fail(new McpError({ server: key, message: "Unknown integration." }))
              }
              return Effect.map(connect(config), (client): Connection => {
                const connection: Connection = { client, tools: undefined, closed: false }
                client.onclose = () => {
                  connection.closed = true
                }
                current.set(key, connection)
                return connection
              })
            }),
            (connection) =>
              Effect.andThen(
                Effect.sync(() => {
                  if (current.get(key) === connection) current.delete(key)
                }),
                closeClient(connection.client)
              )
          ),
        idleTimeToLive: Duration.minutes(10)
      })

      /** Forgets a broken connection so the next call reconnects, closing it even if other calls still hold it. */
      const drop = (key: string, connection: Connection) =>
        Effect.suspend(() => {
          connection.closed = true
          if (current.get(key) !== connection) return closeClient(connection.client)
          current.delete(key)
          return Effect.andThen(RcMap.invalidate(connections, key), closeClient(connection.client))
        })

      const acquire = (config: McpServerConfig, retried = false): Effect.Effect<Connection, McpError, Scope.Scope> =>
        RcMap.get(connections, config.key).pipe(
          // A failed connect isn't kept, so the next call tries again.
          Effect.tapError(() => RcMap.invalidate(connections, config.key)),
          Effect.flatMap((connection) =>
            connection.closed && !retried
              ? Effect.andThen(drop(config.key, connection), acquire(config, true))
              : Effect.succeed(connection)
          )
        )

      /** A timed-out call only restarts the server when it doesn't answer a ping either. */
      const afterFailure = (config: McpServerConfig, connection: Connection, cause: unknown): Effect.Effect<void> => {
        if (isTimeout(cause)) {
          return Effect.tryPromise(() => connection.client.ping({ timeout: Duration.toMillis(pingTimeout) })).pipe(
            Effect.asVoid,
            Effect.catch(() =>
              Effect.andThen(
                Effect.logWarning(`${config.name} stopped responding, so it's restarted on the next call`),
                drop(config.key, connection)
              )
            )
          )
        }
        return isConnectionFailure(cause) ? drop(config.key, connection) : Effect.void
      }

      const withConnection = <A>(
        config: McpServerConfig,
        use: (connection: Connection) => Effect.Effect<A, unknown>,
        describe: (cause: unknown) => string
      ): Effect.Effect<A, McpError> =>
        Effect.suspend(() => {
          configs.set(config.key, config)
          return acquire(config).pipe(
            Effect.flatMap((connection) =>
              use(connection).pipe(
                Effect.catch((cause) =>
                  Effect.andThen(afterFailure(config, connection, cause), failWith(config, describe)(cause))
                )
              )
            ),
            Effect.scoped
          )
        })

      const tools = (config: McpServerConfig) =>
        withConnection(
          config,
          (connection) =>
            connection.tools !== undefined
              ? Effect.succeed(connection.tools)
              : Effect.tap(listTools(connection.client), (listed) =>
                Effect.sync(() => {
                  connection.tools = listed
                })),
          (cause) => `Couldn't list tools: ${errorMessage(cause)}`
        )

      const call = (
        config: McpServerConfig,
        name: string,
        args: Record<string, unknown>,
        timeout: Duration.Duration = Duration.minutes(2)
      ) =>
        withConnection(
          config,
          (connection) =>
            Effect.tryPromise({
              try: (signal) =>
                connection.client.callTool({ name, arguments: args }, undefined, {
                  signal,
                  timeout: Duration.toMillis(timeout)
                }),
              catch: (cause) => cause
            }).pipe(
              Effect.map((result) => ({
                text: contentToText(result as { content?: unknown; structuredContent?: unknown }),
                isError: result.isError === true
              }))
            ),
          (cause) =>
            isTimeout(cause)
              ? `${name} didn't finish within ${Math.round(Duration.toMillis(timeout) / 1000)} seconds.`
              : errorMessage(cause)
        )

      const test = (config: McpServerConfig) =>
        Effect.acquireUseRelease(
          connect(config),
          (client) =>
            Effect.catch(listTools(client), failWith(config, (cause) => `Couldn't list tools: ${errorMessage(cause)}`)),
          closeClient
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
        invalidate: (key) =>
          Effect.andThen(
            Effect.sync(() => current.delete(key)),
            RcMap.invalidate(connections, key)
          )
      })
    })
  )
}
