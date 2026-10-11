import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { messageText } from "../../../src/features/conversations/Conversation.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { IntegrationRepo } from "../../../src/features/integrations/IntegrationRepo.ts"
import { McpHub, type McpServerConfig } from "../../../src/features/integrations/McpHub.ts"
import { Toolbox } from "../../../src/features/runs/Toolbox.ts"
import {
  callTool,
  createBot,
  createConversation,
  say,
  scriptedModel,
  sendAndWait,
  tempDir,
  testLayer,
  withProviderKey
} from "../../support/layers.ts"

const fixture = join(import.meta.dirname, "..", "..", "support", "fixtures", "echo-mcp.ts")

const echoServer = (env: Record<string, string> = {}): McpServerConfig => ({
  key: `test:echo:${JSON.stringify(env)}`,
  name: "Echo",
  transport: "stdio",
  command: process.execPath,
  args: [fixture],
  env,
  url: "",
  headers: {}
})

const HubLayer = McpHub.layer
const echoTools = ["echo", "whoami.env", "fail", "pid", "hang", "throw"]

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitUntilDead = (pid: number) =>
  Effect.gen(function*() {
    for (let i = 0; i < 80 && isAlive(pid); i++) yield* Effect.sleep("100 millis")
    return !isAlive(pid)
  })

const serverPid = (hub: McpHub["Service"], server: McpServerConfig) =>
  Effect.map(hub.call(server, "pid", {}), (result) => Number(result.text))

describe("McpHub", () => {
  it.live("lists and calls tools on a stdio server", () =>
    Effect.gen(function*() {
      const hub = yield* McpHub
      const server = echoServer()
      const tools = yield* hub.tools(server)
      expect(tools.map((tool) => tool.name)).toEqual(echoTools)

      expect(yield* hub.call(server, "echo", { text: "hi" })).toEqual({ text: "echo: hi", isError: false })
      expect(yield* hub.call(server, "fail", {})).toEqual({ text: "something broke", isError: true })
    }).pipe(Effect.provide(HubLayer)), 20_000)

  it.live("passes integration env vars but never the server's own secrets", () =>
    Effect.gen(function*() {
      const hub = yield* McpHub
      process.env.WEAVER_TOKEN = "server-secret"
      const own = yield* hub.call(echoServer({ ECHO_SECRET: "app-key" }), "whoami.env", {})
      expect(own.text).toBe("app-key")
      process.env.ECHO_SECRET = "from-parent"
      process.env.WEAVER_ECHO_SECRET = "x"
      const inherited = yield* hub.call(echoServer({}), "whoami.env", {})
      expect(inherited.text).toBe("from-parent")
      delete process.env.ECHO_SECRET
      delete process.env.WEAVER_ECHO_SECRET
    }).pipe(Effect.provide(HubLayer)), 20_000)

  it.live("reports connection failures in tests instead of throwing", () =>
    Effect.gen(function*() {
      const hub = yield* McpHub
      const result = yield* hub.test({ ...echoServer(), key: "missing", command: "/nonexistent/binary" })
      expect(result.ok).toBe(false)
      expect(result.error).toContain("Couldn't connect")

      const ok = yield* hub.test(echoServer())
      expect(ok.ok).toBe(true)
      expect(ok.tools).toHaveLength(echoTools.length)
    }).pipe(Effect.provide(HubLayer)), 20_000)

  it.live("reconnects after the server process dies", () =>
    Effect.gen(function*() {
      const hub = yield* McpHub
      const server = echoServer({ CASE: "dies" })
      const first = yield* serverPid(hub, server)
      process.kill(first, "SIGKILL")
      expect(yield* waitUntilDead(first)).toBe(true)
      yield* Effect.sleep("100 millis")
      const second = yield* serverPid(hub, server)
      expect(second).not.toBe(first)
      expect(yield* hub.call(server, "echo", { text: "back" })).toEqual({ text: "echo: back", isError: false })
    }).pipe(Effect.provide(HubLayer)), 20_000)

  it.live("keeps the connection when a tool reports an error or the server rejects one call", () =>
    Effect.gen(function*() {
      const hub = yield* McpHub
      const server = echoServer({ CASE: "tool-errors" })
      const pid = yield* serverPid(hub, server)
      expect((yield* hub.call(server, "fail", {})).isError).toBe(true)
      const rejected = yield* Effect.flip(hub.call(server, "throw", {}))
      expect(rejected.message).toContain("bad arguments")
      expect(yield* serverPid(hub, server)).toBe(pid)
      expect(isAlive(pid)).toBe(true)
    }).pipe(Effect.provide(HubLayer)), 20_000)

  it.live("kills a server that stops responding after a timeout, and reconnects on the next call", () =>
    Effect.gen(function*() {
      const hub = yield* McpHub
      const server = echoServer({ CASE: "hangs" })
      const pid = yield* serverPid(hub, server)
      const timedOut = yield* Effect.flip(hub.call(server, "hang", {}, Duration.millis(300)))
      expect(timedOut.message).toContain("hang didn't finish within")
      expect(yield* waitUntilDead(pid)).toBe(true)
      const next = yield* serverPid(hub, server)
      expect(next).not.toBe(pid)
    }).pipe(Effect.provide(HubLayer)), 30_000)

  it.live("connects once when many calls need the same server at the same time", () =>
    Effect.gen(function*() {
      const hub = yield* McpHub
      const starts = join(tempDir(), "starts.log")
      const server = echoServer({ ECHO_STARTS_FILE: starts })
      const all = yield* Effect.all(Array.from({ length: 6 }, () => hub.tools(server)), { concurrency: "unbounded" })
      expect(all.every((tools) => tools.length === echoTools.length)).toBe(true)
      yield* Effect.all(Array.from({ length: 6 }, () => hub.call(server, "echo", { text: "x" })), { concurrency: "unbounded" })
      expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1)
    }).pipe(Effect.provide(HubLayer)), 20_000)

  it.live("stops every server process when the hub shuts down", () =>
    Effect.gen(function*() {
      const pids = yield* Effect.gen(function*() {
        const hub = yield* McpHub
        return yield* Effect.all([serverPid(hub, echoServer({ CASE: "a" })), serverPid(hub, echoServer({ CASE: "b" }))])
      }).pipe(Effect.provide(HubLayer))
      for (const pid of pids) expect(yield* waitUntilDead(pid)).toBe(true)
    }), 20_000)
})

describe("integrations", () => {
  it.live("gives a bot prefixed integration tools and routes calls to the server", () => {
    const model = scriptedModel((call) => call.index === 0 ? callTool("echo__echo", { text: "ping" }) : say("It said ping."))
    return Effect.gen(function*() {
      yield* withProviderKey
      const integrations = yield* IntegrationRepo
      const integration = yield* integrations.create({
        name: "Echo",
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      })
      const other = yield* integrations.create({ name: "Unused", transport: "stdio", command: "/nonexistent" })
      const bot = yield* createBot({ name: "Ada", integrationIds: [integration.id] })

      const toolbox = yield* Toolbox
      const botTools = yield* toolbox.forBot(bot)
      expect(botTools.tools.map((tool) => tool.name)).toEqual(echoTools.map((name) => `echo__${name.replace(".", "_")}`))
      expect(botTools.integrations).toEqual([{ name: "Echo", prefix: "echo" }])
      expect(botTools.unavailable).toEqual([])
      expect(other.id).not.toBe(integration.id)

      const conversation = yield* createConversation([bot.id])
      yield* sendAndWait(conversation.id, "Ping the echo app")

      expect(model.calls[0]!.prompt).toContain("Echo")
      expect(model.calls[1]!.prompt).toContain("echo: ping")
      const conversations = yield* ConversationRepo
      const message = (yield* conversations.messages(conversation.id)).at(-1)!
      expect(message.parts[1]).toMatchObject({ type: "tool-result", output: "echo: ping", isFailure: false })
      expect(messageText(message.parts)).toBe("It said ping.")
    }).pipe(Effect.provide(testLayer(model.layer)))
  }, 20_000)

  it.live("lists unreachable integrations so the bot can mention them", () => {
    const model = scriptedModel(() => say("ok"))
    return Effect.gen(function*() {
      const integrations = yield* IntegrationRepo
      const broken = yield* integrations.create({ name: "Broken", transport: "stdio", command: "/nonexistent/binary" })
      const bot = yield* createBot({ name: "Ada", integrationIds: [broken.id] })
      const botTools = yield* (yield* Toolbox).forBot(bot)
      expect(botTools.tools).toHaveLength(0)
      expect(botTools.unavailable[0]).toContain("Broken")
    }).pipe(Effect.provide(testLayer(model.layer)))
  }, 20_000)
})
