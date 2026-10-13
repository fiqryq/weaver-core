import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"

export const version = "0.1.0"

export const minTokenLength = 16

/** `WEAVER_BOT_USER` value that gives every bot its own Linux user, made by the root helper. */
export const perBotUsers = "per-bot"

export const defaultSkillCatalog = "anthropics/skills/skills"

export const browserEngines = ["camofox", "playwright", "off"] as const
export type BrowserEngine = typeof browserEngines[number]

export class InvalidConfig extends Schema.TaggedError<InvalidConfig>()("InvalidConfig", {
  message: Schema.String
}) {}

export interface AppConfigShape {
  readonly dataDir: string
  readonly token: Redacted.Redacted<string>
  readonly host: string
  readonly port: number
  /** Maximum request body size in bytes (default 10MB) */
  readonly maxBodyBytes: number
  readonly display: string
  /** Basic Memory's MCP endpoint, shared by every bot with memory on. */
  readonly memory: Option.Option<{
    readonly url: string
    readonly token: string
    readonly project: string
  }>
  /** Searches memory for notes related to the user's message before each reply of a bot with memory. */
  readonly memoryRecall: boolean
  /**
   * Minutes between checks for memory notes that changed, so their history has every version even when
   * they're edited outside Weaver; 0 only saves versions around bot writes and when history is opened.
   */
  readonly memoryHistoryMinutes: number
  /** Folder (on Basic Memory's machine) new memory projects go in; empty puts them next to the default project's folder. */
  readonly memoryProjectsDir: string
  /** Which browser the browser tool drives; `off` leaves it out. */
  readonly browser: BrowserEngine
  /** camofox-browser's REST API, used in `camofox` mode and by the web tools when it's reachable. */
  readonly camofoxUrl: string
  /** Sent as camofox-browser's access key (`CAMOFOX_ACCESS_KEY`); empty sends none. */
  readonly camofoxKey: string
  /** Command that starts the Playwright MCP server for the browser tool, in `playwright` mode. */
  readonly browserCommand: ReadonlyArray<string>
  /** Tool-calling steps between background skill reviews; 0 turns them off. */
  readonly reviewSkillInterval: number
  /** Replies between background memory reviews; 0 turns them off. */
  readonly reviewMemoryInterval: number
  /** Core Memory longer than this many characters is condensed in the background; 0 turns that off. */
  readonly coreMemoryCondenseAt: number
  /** Longest a bot waits for a teammate it asked with `ask_bot`. */
  readonly handoffTimeoutMinutes: number
  /** Team manager steps without a report before it's nudged to report progress or ask the person. */
  readonly teamNudgeSteps: number
  /** Team manager steps without a report before the session pauses to ask the person whether to go on. */
  readonly teamPauseSteps: number
  /**
   * The unprivileged user bot commands run as (through `sudo`), and the group it shares with the
   * server for workspaces. None runs them as the server's own user; a user of `per-bot` gives each
   * bot its own user from `botUserHelper`.
   */
  readonly botUser: Option.Option<{ readonly user: string; readonly group: string }>
  /** Root helper that creates and removes per-bot users, run through `sudo`. */
  readonly botUserHelper: string
  /** GitHub folders the skills catalog lists, as `owner/repo[/path][@ref]`. */
  readonly skillCatalog: ReadonlyArray<string>
  /** Sent to GitHub when installing skills and reading the catalog; empty sends none. */
  readonly githubToken: Redacted.Redacted<string>
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("weaver/Config") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const dataDir = yield* Config.String("WEAVER_DATA_DIR").pipe(Config.withDefault("/var/lib/weaver"))
      const token = yield* Config.Redacted("WEAVER_TOKEN").pipe(Config.withDefault(Redacted.make("")))
      if (Redacted.value(token).trim().length < minTokenLength) {
        return yield* new InvalidConfig({
          message: `WEAVER_TOKEN must be at least ${minTokenLength} characters (try \`openssl rand -hex 32\`).`
        })
      }
      const listen = yield* Config.String("WEAVER_LISTEN").pipe(Config.withDefault(":7700"))
      const maxBodyBytes = yield* Config.Int("WEAVER_MAX_BODY_MB").pipe(Config.withDefault(10))
      const display = yield* Config.String("DISPLAY").pipe(Config.withDefault(":1"))
      const memoryUrl = yield* Config.option(Config.String("WEAVER_MEMORY_URL"))
      const memoryToken = yield* Config.String("WEAVER_MEMORY_TOKEN").pipe(Config.withDefault(""))
      const memoryProject = yield* Config.String("WEAVER_MEMORY_PROJECT").pipe(Config.withDefault(""))
      const memoryRecall = yield* Config.String("WEAVER_MEMORY_RECALL").pipe(Config.withDefault("on"))
      const memoryHistoryMinutes = yield* Config.Int("WEAVER_MEMORY_HISTORY_MINUTES").pipe(Config.withDefault(10))
      const memoryProjectsDir = yield* Config.String("WEAVER_MEMORY_PROJECTS_DIR").pipe(Config.withDefault(""))
      const browser = (yield* Config.String("WEAVER_BROWSER").pipe(Config.withDefault("camofox"))).trim().toLowerCase()
      if (!browserEngines.includes(browser as BrowserEngine)) {
        return yield* new InvalidConfig({
          message: `WEAVER_BROWSER must be one of ${browserEngines.join(", ")}, not ${JSON.stringify(browser)}.`
        })
      }
      const camofoxUrl = yield* Config.String("WEAVER_CAMOFOX_URL").pipe(Config.withDefault("http://127.0.0.1:9377"))
      const camofoxKey = yield* Config.String("WEAVER_CAMOFOX_KEY").pipe(Config.withDefault(""))
      const browserCommand = yield* Config.String("WEAVER_BROWSER_COMMAND").pipe(
        Config.withDefault("npx -y @playwright/mcp@latest")
      )
      const reviewSkillInterval = yield* Config.Int("WEAVER_REVIEW_SKILL_INTERVAL").pipe(Config.withDefault(10))
      const reviewMemoryInterval = yield* Config.Int("WEAVER_REVIEW_MEMORY_INTERVAL").pipe(Config.withDefault(10))
      const coreMemoryCondenseAt = yield* Config.Int("WEAVER_CORE_MEMORY_CONDENSE_AT").pipe(Config.withDefault(3200))
      const handoffTimeoutMinutes = yield* Config.Int("WEAVER_HANDOFF_TIMEOUT_MINUTES").pipe(Config.withDefault(15))
      const teamNudgeSteps = yield* Config.Int("WEAVER_TEAM_NUDGE_STEPS").pipe(Config.withDefault(40))
      const teamPauseSteps = yield* Config.Int("WEAVER_TEAM_PAUSE_STEPS").pipe(Config.withDefault(150))
      const botUser = yield* Config.String("WEAVER_BOT_USER").pipe(Config.withDefault(""))
      const botGroup = yield* Config.String("WEAVER_BOT_GROUP").pipe(Config.withDefault("weaver-work"))
      const botUserHelper = yield* Config.String("WEAVER_BOT_USER_HELPER").pipe(
        Config.withDefault("/usr/local/lib/weaver/weaver-bot-user")
      )
      const skillCatalog = yield* Config.String("WEAVER_SKILL_CATALOG").pipe(Config.withDefault(defaultSkillCatalog))
      const githubToken = yield* Config.Redacted("WEAVER_GITHUB_TOKEN").pipe(Config.withDefault(Redacted.make("")))
      const { host, port } = parseListen(listen)
      return AppConfig.of({
        dataDir,
        token,
        host,
        port,
        maxBodyBytes: Math.max(maxBodyBytes, 1) * 1024 * 1024,
        display,
        memory: Option.map(
          Option.filter(memoryUrl, (url) => url.trim().length > 0),
          (url) => ({ url: url.trim(), token: memoryToken, project: memoryProject.trim() })
        ),
        memoryRecall: !["off", "false", "0", "no"].includes(memoryRecall.trim().toLowerCase()),
        memoryHistoryMinutes: Math.max(memoryHistoryMinutes, 0),
        memoryProjectsDir: memoryProjectsDir.trim().replace(/\/+$/, ""),
        browser: browser as BrowserEngine,
        camofoxUrl: camofoxUrl.trim().replace(/\/+$/, "") || "http://127.0.0.1:9377",
        camofoxKey: camofoxKey.trim(),
        browserCommand: browserCommand.split(/\s+/).filter((part) => part.length > 0),
        reviewSkillInterval: Math.max(reviewSkillInterval, 0),
        reviewMemoryInterval: Math.max(reviewMemoryInterval, 0),
        coreMemoryCondenseAt: Math.max(coreMemoryCondenseAt, 0),
        handoffTimeoutMinutes: Math.max(handoffTimeoutMinutes, 1),
        teamNudgeSteps: Math.max(teamNudgeSteps, 1),
        teamPauseSteps: Math.max(teamPauseSteps, 1),
        botUser: botUser.trim().length > 0
          ? Option.some({ user: botUser.trim(), group: botGroup.trim() || "weaver-work" })
          : Option.none(),
        botUserHelper: botUserHelper.trim(),
        skillCatalog: skillCatalog.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0),
        githubToken: Redacted.make(Redacted.value(githubToken).trim())
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
        maxBodyBytes: 10 * 1024 * 1024,
        display: ":1",
        memory: Option.none(),
        memoryRecall: true,
        memoryHistoryMinutes: 0,
        memoryProjectsDir: "",
        browser: "off",
        camofoxUrl: "http://127.0.0.1:9377",
        camofoxKey: "",
        browserCommand: ["true"],
        reviewSkillInterval: 10,
        reviewMemoryInterval: 10,
        coreMemoryCondenseAt: 3200,
        handoffTimeoutMinutes: 15,
        teamNudgeSteps: 40,
        teamPauseSteps: 150,
        botUser: Option.none(),
        botUserHelper: "/usr/local/lib/weaver/weaver-bot-user",
        skillCatalog: [defaultSkillCatalog],
        githubToken: Redacted.make(""),
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
