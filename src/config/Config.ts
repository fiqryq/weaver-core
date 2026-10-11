import { Config, Context, Effect, Layer, Option, Redacted } from "effect"

export const version = "0.1.0"

export interface AppConfigShape {
  readonly dataDir: string
  readonly token: Redacted.Redacted<string>
  readonly host: string
  readonly port: number
  readonly display: string
  /** Basic Memory's MCP endpoint, shared by every bot with memory on. */
  readonly memory: Option.Option<{
    readonly url: string
    readonly token: string
    readonly project: string
  }>
  /** Command that starts the Playwright MCP server for the browser tool. */
  readonly browserCommand: ReadonlyArray<string>
  /** Tool-calling steps between background skill reviews; 0 turns them off. */
  readonly reviewSkillInterval: number
  /** Replies between background memory reviews; 0 turns them off. */
  readonly reviewMemoryInterval: number
  /**
   * The unprivileged user bot commands run as (through `sudo`), and the group it shares with the
   * server for workspaces. None runs them as the server's own user.
   */
  readonly botUser: Option.Option<{ readonly user: string; readonly group: string }>
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("weaver/Config") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const dataDir = yield* Config.String("WEAVER_DATA_DIR").pipe(Config.withDefault("/var/lib/weaver"))
      const token = yield* Config.Redacted("WEAVER_TOKEN")
      const listen = yield* Config.String("WEAVER_LISTEN").pipe(Config.withDefault(":7700"))
      const display = yield* Config.String("DISPLAY").pipe(Config.withDefault(":1"))
      const memoryUrl = yield* Config.option(Config.String("WEAVER_MEMORY_URL"))
      const memoryToken = yield* Config.String("WEAVER_MEMORY_TOKEN").pipe(Config.withDefault(""))
      const memoryProject = yield* Config.String("WEAVER_MEMORY_PROJECT").pipe(Config.withDefault(""))
      const browserCommand = yield* Config.String("WEAVER_BROWSER_COMMAND").pipe(
        Config.withDefault("npx -y @playwright/mcp@latest")
      )
      const reviewSkillInterval = yield* Config.Int("WEAVER_REVIEW_SKILL_INTERVAL").pipe(Config.withDefault(10))
      const reviewMemoryInterval = yield* Config.Int("WEAVER_REVIEW_MEMORY_INTERVAL").pipe(Config.withDefault(10))
      const botUser = yield* Config.String("WEAVER_BOT_USER").pipe(Config.withDefault(""))
      const botGroup = yield* Config.String("WEAVER_BOT_GROUP").pipe(Config.withDefault("weaver-work"))
      const { host, port } = parseListen(listen)
      return AppConfig.of({
        dataDir,
        token,
        host,
        port,
        display,
        memory: Option.map(
          Option.filter(memoryUrl, (url) => url.trim().length > 0),
          (url) => ({ url: url.trim(), token: memoryToken, project: memoryProject.trim() })
        ),
        browserCommand: browserCommand.split(/\s+/).filter((part) => part.length > 0),
        reviewSkillInterval: Math.max(reviewSkillInterval, 0),
        reviewMemoryInterval: Math.max(reviewMemoryInterval, 0),
        botUser: botUser.trim().length > 0
          ? Option.some({ user: botUser.trim(), group: botGroup.trim() || "weaver-work" })
          : Option.none()
      })
    })
  )

  static readonly layerTest = (overrides: Partial<AppConfigShape> = {}) =>
    Layer.succeed(
      AppConfig,
      AppConfig.of({
        dataDir: "/tmp/weaver-test",
        token: Redacted.make("test-token"),
        host: "127.0.0.1",
        port: 0,
        display: ":1",
        memory: Option.none(),
        browserCommand: ["true"],
        reviewSkillInterval: 10,
        reviewMemoryInterval: 10,
        botUser: Option.none(),
        ...overrides
      })
    )
}

/** Accepts `:7700`, `7700`, `100.64.0.1:7700` or `100.64.0.1`. */
export const parseListen = (listen: string): { host: string; port: number } => {
  const trimmed = listen.trim()
  const index = trimmed.lastIndexOf(":")
  if (index === -1) {
    const port = Number(trimmed)
    return Number.isInteger(port) && port > 0 ? { host: "0.0.0.0", port } : { host: trimmed, port: 7700 }
  }
  const host = trimmed.slice(0, index) || "0.0.0.0"
  const port = Number(trimmed.slice(index + 1))
  return { host, port: Number.isInteger(port) && port > 0 ? port : 7700 }
}
