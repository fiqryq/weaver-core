import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Option } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { AppConfig, type AppConfigShape, minTokenLength } from "../../src/config/Config.ts"
import { Toolbox } from "../../src/features/runs/Toolbox.ts"
import { BotUsers } from "../../src/platform/os/BotUsers.ts"
import type { AgentTool } from "../../src/tools/AgentTool.ts"
import { ensureWorkspace, groupId } from "../../src/tools/builtin/Files.ts"
import { commandSpec, killGraceSeconds, runCommandTool } from "../../src/tools/builtin/Shell.ts"
import { createBot, say, scriptedModel, tempDir, testLayer } from "../support/layers.ts"

const env = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/weaver",
  USER: "weaver",
  LANG: "C.UTF-8",
  SOME_TOOL_HOME: "/opt/tool"
}

const modeOf = (path: string) => statSync(path).mode & 0o7777

describe("commandSpec", () => {
  it("runs bash in the workspace with the server's environment when there's no bot user", () => {
    const spec = commandSpec({ command: "ls -la", workspace: "/w", display: ":1", seconds: 30, runAs: undefined, env })
    expect(spec).toEqual({
      command: "bash",
      args: ["-c", "exec bash -lc \"$1\" 2>&1", "weaver", "ls -la"],
      cwd: "/w",
      env: { ...env, DISPLAY: ":1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" }
    })
  })

  it("runs as the bot user through sudo, under timeout, with umask and cwd set inside", () => {
    const spec = commandSpec({ command: "echo 'hi' $HOME", workspace: "/w s", display: ":1", seconds: 30, runAs: "weaver-bot", env })
    expect(spec.command).toBe("sudo")
    expect(spec.cwd).toBe("/w s")
    expect(spec.args).toEqual([
      "-n",
      "-u",
      "weaver-bot",
      "-H",
      "--",
      "env",
      "LANG=C.UTF-8",
      "TERM=dumb",
      "PAGER=cat",
      "GIT_PAGER=cat",
      "timeout",
      "-k",
      String(killGraceSeconds),
      "30",
      "bash",
      "-c",
      "umask 007 && cd -- \"$1\" && exec bash -lc \"$2\" 2>&1",
      "weaver",
      "/w s",
      "echo 'hi' $HOME"
    ])
  })

  it("gives the bot user a clean environment: no secrets, no server HOME or USER", () => {
    const spec = commandSpec({
      command: "true",
      workspace: "/w",
      display: ":1",
      seconds: 5,
      runAs: "weaver-bot",
      env: { ...env, WEAVER_TOKEN: "secret" }
    })
    expect(spec.env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" })
    const joined = spec.args.join(" ")
    for (const leaked of ["secret", "HOME=", "USER=", "SOME_TOOL_HOME", "DISPLAY="]) expect(joined).not.toContain(leaked)
  })

  it("leaves WEAVER_* out of the environment by default", () => {
    process.env.WEAVER_TOKEN = "server-secret"
    const plain = commandSpec({ command: "true", workspace: "/w", display: ":1", seconds: 5, runAs: undefined })
    const isolated = commandSpec({ command: "true", workspace: "/w", display: ":1", seconds: 5, runAs: "weaver-bot" })
    delete process.env.WEAVER_TOKEN
    expect(plain.env.WEAVER_TOKEN).toBeUndefined()
    expect(JSON.stringify(isolated)).not.toContain("server-secret")
  })
})

/** Puts fake `sudo` and `timeout` first on PATH; the fake sudo checks its options and runs the rest. */
const withFakeSudo = (sudo: string, f: (shell: AgentTool, workspace: string) => Effect.Effect<void, unknown>) =>
  Effect.gen(function*() {
    const bin = tempDir()
    writeFileSync(join(bin, "sudo"), sudo.replace("$BOT_HOME", tempDir()))
    writeFileSync(join(bin, "timeout"), "#!/bin/sh\n[ \"$1\" = -k ] || exit 99\nshift 3\nexec \"$@\"\n")
    chmodSync(join(bin, "sudo"), 0o755)
    chmodSync(join(bin, "timeout"), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const workspace = tempDir()
    yield* f(runCommandTool({ workspace, display: ":1", needsApproval: false, spawner, runAs: "weaver-bot" }), workspace)
      .pipe(Effect.ensuring(Effect.sync(() => (process.env.PATH = path))))
  }).pipe(Effect.provide(BunServices.layer))

const passThroughSudo = [
  "#!/bin/sh",
  "[ \"$1\" = -n ] && [ \"$2\" = -u ] && [ \"$3\" = weaver-bot ] || { echo \"sudo: unexpected $*\" >&2; exit 1; }",
  "while [ \"$1\" != -- ]; do shift; done",
  "shift",
  "HOME=$BOT_HOME exec \"$@\"",
  ""
].join("\n")

const brokenSudo = "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n"

describe("run_command as the bot user", () => {
  it.live("runs in the workspace with umask 007 and only the variables it should get", () =>
    withFakeSudo(passThroughSudo, (shell, workspace) =>
      Effect.gen(function*() {
        process.env.WEAVER_TOKEN = "server-secret"
        process.env.SOME_TOOL_HOME = "/opt/tool"
        const output = yield* shell.run({ command: "umask; pwd; echo \"[$WEAVER_TOKEN] [$SOME_TOOL_HOME] [$DISPLAY] [$TERM]\"" })
        delete process.env.WEAVER_TOKEN
        delete process.env.SOME_TOOL_HOME
        const [umask, pwd, vars] = output.split("\n")
        expect(umask).toBe("0007")
        expect(pwd).toContain(workspace.split("/").at(-1)!)
        expect(vars).toBe("[] [] [] [dumb]")
        expect(shell.description).toContain("no display")
        expect(shell.description).not.toContain("DISPLAY")
      })
    ))

  it.live("reports timeout's exit code as the command being stopped", () =>
    withFakeSudo(passThroughSudo, (shell) =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(shell.run({ command: "exit 124", timeout_seconds: 3 }))
        expect(failure.message).toContain("Stopped after 3 seconds")
      })
    ))

  it.live("keeps ordinary failures, even when the output starts like sudo's", () =>
    withFakeSudo(passThroughSudo, (shell) =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(shell.run({ command: "echo 'sudo: nope' >&2; exit 1" }))
        expect(failure.message).toContain("sudo: nope")
        expect(failure.message).toContain("Exit code: 1")
      })
    ))

  it.live("says clearly when sudo isn't set up for the bot user", () =>
    withFakeSudo(brokenSudo, (shell) =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(shell.run({ command: "ls" }))
        expect(failure.message).toContain("Can't run commands as weaver-bot")
        expect(failure.message).toContain("a password is required")
        expect(failure.message).toContain("Rerun the setup script")
      })
    ))
})

describe("ensureWorkspace", () => {
  it.effect("leaves permissions alone without a bot user", () =>
    Effect.gen(function*() {
      const dataDir = tempDir()
      const workspace = yield* ensureWorkspace(dataDir, "b1")
      expect(workspace).toBe(join(dataDir, "bots", "b1", "workspace"))
      expect(modeOf(workspace) & 0o2000).toBe(0)
    }))

  it.effect("shares the workspace with the bot user's group and closes off the rest", () =>
    Effect.gen(function*() {
      const dataDir = tempDir()
      mkdirSync(join(dataDir, "bots", "b1", "skills"), { recursive: true, mode: 0o755 })
      const group = String(process.getgid!())
      const workspace = yield* ensureWorkspace(dataDir, "b1", { group })
      expect(modeOf(join(dataDir, "bots"))).toBe(0o711)
      expect(modeOf(join(dataDir, "bots", "b1"))).toBe(0o711)
      expect(modeOf(join(dataDir, "bots", "b1", "skills"))).toBe(0o700)
      expect(modeOf(workspace)).toBe(0o2770)
      expect(statSync(workspace).gid).toBe(process.getgid!())
      // A second call finds everything in place.
      yield* ensureWorkspace(dataDir, "b1", { group })
      expect(modeOf(workspace)).toBe(0o2770)
    }))

  it.effect("still returns the workspace when the group doesn't exist", () =>
    Effect.gen(function*() {
      const dataDir = tempDir()
      const workspace = yield* ensureWorkspace(dataDir, "b1", { group: "no-such-group-weaver" })
      expect(statSync(workspace).isDirectory()).toBe(true)
    }))

  it.effect("finds group IDs by name or number", () =>
    Effect.gen(function*() {
      const file = join(tempDir(), "group")
      writeFileSync(file, "root:x:0:\nweaver:x:999:\nweaver-work:x:998:weaver,weaver-bot\n")
      expect(yield* Effect.promise(() => groupId("weaver-work", file))).toBe(998)
      expect(yield* Effect.promise(() => groupId("1234", file))).toBe(1234)
      expect(yield* Effect.promise(() => groupId("missing", file))).toBeUndefined()
    }))

  it("reads WEAVER_BOT_USER and WEAVER_BOT_GROUP, off by default", () => {
    const load = (vars: Record<string, string>) =>
      Effect.runSync(loadConfig(vars).pipe(Effect.map((config) => config.botUser)))
    expect(load({})).toEqual(Option.none())
    expect(load({ WEAVER_BOT_USER: " " })).toEqual(Option.none())
    expect(load({ WEAVER_BOT_USER: "weaver-bot" })).toEqual(Option.some({ user: "weaver-bot", group: "weaver-work" }))
    expect(load({ WEAVER_BOT_USER: "b", WEAVER_BOT_GROUP: "g" })).toEqual(Option.some({ user: "b", group: "g" }))
    expect(load({ WEAVER_BOT_USER: "per-bot" })).toEqual(Option.some({ user: "per-bot", group: "weaver-work" }))
  })

  it("defaults the per-bot user helper and lets it be overridden", () => {
    const helper = (vars: Record<string, string>) =>
      Effect.runSync(loadConfig(vars).pipe(Effect.map((config) => config.botUserHelper)))
    expect(helper({})).toBe("/usr/local/lib/weaver/weaver-bot-user")
    expect(helper({ WEAVER_BOT_USER_HELPER: "/tmp/helper" })).toBe("/tmp/helper")
  })
})

const strongToken = "0123456789abcdef0123"

const loadConfig = (vars: Record<string, string>) =>
  Effect.map(AppConfig, (config) => config).pipe(
    Effect.provide(AppConfig.layer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ WEAVER_TOKEN: strongToken, ...vars })))
  )

describe("WEAVER_TOKEN", () => {
  it("refuses to start with a missing, empty, blank or short token", () => {
    const check = (vars: Record<string, unknown>) => {
      const failure = Effect.runSync(Effect.flip(Effect.map(AppConfig, (config) => config).pipe(
        Effect.provide(AppConfig.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars)))
      )))
      expect(failure._tag).toBe("InvalidConfig")
      expect(failure.message).toContain(`at least ${minTokenLength} characters`)
    }
    check({})
    for (const token of ["", "   ", "short", " ".repeat(10) + "x".repeat(15)]) check({ WEAVER_TOKEN: token })
  })

  it("accepts a token of 16 characters or more", () => {
    expect(Effect.runSync(loadConfig({ WEAVER_TOKEN: "x".repeat(16) })).port).toBe(7700)
  })
})

const botId = "0F8FAD5B-D9CB-469F-A165-70867728950E"
const botUserName = "wb-0f8fad5bd9cb"

/** A fake `sudo -n <helper> …` that runs the helper, and a helper that logs its calls and prints the user. */
const fakeHelper = (helperScript?: string) => {
  const dir = tempDir()
  const log = join(dir, "calls.log")
  writeFileSync(join(dir, "sudo"), "#!/bin/sh\n[ \"$1\" = -n ] || exit 98\nshift\nexec \"$@\"\n")
  writeFileSync(
    join(dir, "helper"),
    helperScript ??
      [
        "#!/bin/sh",
        `echo "$1 $2" >> ${log}`,
        "[ \"$1\" = ensure ] && echo wb-$(echo \"$2\" | tr -d - | tr A-Z a-z | cut -c1-12)",
        "exit 0",
        ""
      ].join("\n")
  )
  chmodSync(join(dir, "sudo"), 0o755)
  chmodSync(join(dir, "helper"), 0o755)
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((line) => line.length > 0) : [])
  return { dir, log, helper: join(dir, "helper"), calls }
}

const withBotUsers = <A, E>(
  config: Partial<AppConfigShape>,
  bin: string | undefined,
  f: (users: BotUsers["Service"]) => Effect.Effect<A, E>
) =>
  Effect.gen(function*() {
    const path = process.env.PATH
    if (bin !== undefined) process.env.PATH = `${bin}:${path}`
    return yield* Effect.flatMap(BotUsers, f).pipe(
      Effect.provide(BotUsers.layer),
      Effect.provide(AppConfig.layerTest(config)),
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.sync(() => (process.env.PATH = path)))
    )
  })

describe("BotUsers", () => {
  it.live("runs commands as the server's user when bot users are off", () =>
    withBotUsers({}, undefined, (users) =>
      Effect.gen(function*() {
        expect(yield* users.userFor(botId)).toBeUndefined()
        yield* users.remove(botId)
      })))

  it.live("uses the one shared user in shared mode, without the helper", () => {
    const fake = fakeHelper()
    return withBotUsers(
      { botUser: Option.some({ user: "weaver-bot", group: "weaver-work" }), botUserHelper: fake.helper },
      fake.dir,
      (users) =>
        Effect.gen(function*() {
          expect(yield* users.userFor(botId)).toBe("weaver-bot")
          yield* users.remove(botId)
          expect(fake.calls()).toEqual([])
        })
    )
  })

  it.live("ensures each bot's own user once, even when asked concurrently", () => {
    const fake = fakeHelper()
    return withBotUsers(
      { botUser: Option.some({ user: "per-bot", group: "weaver-work" }), botUserHelper: fake.helper },
      fake.dir,
      (users) =>
        Effect.gen(function*() {
          const all = yield* Effect.all(Array.from({ length: 5 }, () => users.userFor(botId)), { concurrency: "unbounded" })
          expect(all).toEqual(Array(5).fill(botUserName))
          expect(yield* users.userFor(botId)).toBe(botUserName)
          expect(yield* users.userFor("other-bot")).toBe("wb-otherbot")
          expect(fake.calls()).toEqual([`ensure ${botId}`, "ensure other-bot"])
        })
    )
  })

  it.live("retries a failed ensure on the next call, with a clear message meanwhile", () => {
    const dir = tempDir()
    const flag = join(dir, "failed-once")
    const fake = fakeHelper([
      "#!/bin/sh",
      `if [ ! -e ${flag} ]; then touch ${flag}; echo 'useradd: cannot lock /etc/passwd' >&2; exit 1; fi`,
      "echo wb-abc",
      ""
    ].join("\n"))
    return withBotUsers(
      { botUser: Option.some({ user: "per-bot", group: "weaver-work" }), botUserHelper: fake.helper },
      fake.dir,
      (users) =>
        Effect.gen(function*() {
          const failure = yield* Effect.flip(users.userFor("abc"))
          expect(failure.message).toContain("Can't set up this bot's Linux user")
          expect(failure.message).toContain("cannot lock /etc/passwd")
          expect(failure.message).toContain("Rerun the setup script")
          expect(yield* users.userFor("abc")).toBe("wb-abc")
        })
    )
  })

  it.live("says so when sudo or the helper is missing", () => {
    const fake = fakeHelper()
    return withBotUsers(
      { botUser: Option.some({ user: "per-bot", group: "weaver-work" }), botUserHelper: join(fake.dir, "missing-helper") },
      fake.dir,
      (users) =>
        Effect.gen(function*() {
          const failure = yield* Effect.flip(users.userFor(botId))
          expect(failure.message).toContain("missing-helper ensure failed")
        })
    )
  })

  it.live("never passes an invalid bot ID or trusts an odd user name", () => {
    const fake = fakeHelper("#!/bin/sh\necho \"$1 $2\" >> " + "$(dirname \"$0\")/calls.log\necho root\n")
    return withBotUsers(
      { botUser: Option.some({ user: "per-bot", group: "weaver-work" }), botUserHelper: fake.helper },
      fake.dir,
      (users) =>
        Effect.gen(function*() {
          for (const bad of ["../etc", "-rf", "a b", "", "x;id"]) {
            const failure = yield* Effect.flip(users.userFor(bad))
            expect(failure.message).toContain("Can't set up a Linux user for bot ID")
          }
          yield* users.remove("../etc")
          expect(fake.calls()).toEqual([])
          const odd = yield* Effect.flip(users.userFor(botId))
          expect(odd.message).toContain("unexpected user name")
        })
    )
  })

  it.live("removes a bot's user, and only warns when that fails", () => {
    const fake = fakeHelper()
    const failing = fakeHelper("#!/bin/sh\necho 'userdel: user is busy' >&2\nexit 1\n")
    const config = (helper: string) => ({ botUser: Option.some({ user: "per-bot", group: "weaver-work" }), botUserHelper: helper })
    return Effect.gen(function*() {
      yield* withBotUsers(config(fake.helper), fake.dir, (users) =>
        Effect.gen(function*() {
          yield* users.userFor(botId)
          yield* users.remove(botId)
          yield* users.userFor(botId)
          expect(fake.calls()).toEqual([`ensure ${botId}`, `remove ${botId}`, `ensure ${botId}`])
        }))
      yield* withBotUsers(config(failing.helper), failing.dir, (users) => users.remove(botId))
    })
  })
})

describe("run_command with per-bot users", () => {
  it.live("runs each bot's commands as its own user through sudo", () => {
    const dir = tempDir()
    const sudoLog = join(dir, "sudo.log")
    const helper = join(dir, "helper")
    writeFileSync(
      join(dir, "sudo"),
      [
        "#!/bin/sh",
        "[ \"$1\" = -n ] || exit 98",
        "shift",
        `if [ "$1" = -u ]; then echo "$2" >> ${sudoLog}; while [ "$1" != -- ]; do shift; done; shift; fi`,
        `HOME=${tempDir()} exec "$@"`,
        ""
      ].join("\n")
    )
    writeFileSync(join(dir, "timeout"), "#!/bin/sh\n[ \"$1\" = -k ] || exit 99\nshift 3\nexec \"$@\"\n")
    writeFileSync(helper, "#!/bin/sh\necho wb-$(echo \"$2\" | tr -d - | cut -c1-12)\n")
    for (const name of ["sudo", "timeout", "helper"]) chmodSync(join(dir, name), 0o755)
    const model = scriptedModel(() => say("ok"))
    const path = process.env.PATH
    process.env.PATH = `${dir}:${path}`
    return Effect.gen(function*() {
      const bot = yield* createBot({ name: "Ada", tools: ["shell"] })
      const botTools = yield* (yield* Toolbox).forBot(bot)
      const shell = botTools.tools.find((t) => t.name === "run_command")!
      expect(yield* shell.run({ command: "echo hi" })).toBe("hi")
      expect(yield* shell.run({ command: "echo again" })).toBe("again")
      const expected = `wb-${bot.id.replace(/-/g, "").slice(0, 12)}`
      expect(readFileSync(sudoLog, "utf8").trim().split("\n")).toEqual([expected, expected])
    }).pipe(
      Effect.provide(testLayer(model.layer, tempDir(), {
        botUser: Option.some({ user: "per-bot", group: String(process.getgid!()) }),
        botUserHelper: helper
      })),
      Effect.ensuring(Effect.sync(() => (process.env.PATH = path)))
    )
  }, 20_000)

  it.live("reports a bot user that can't be set up as a failed command", () => {
    const model = scriptedModel(() => say("ok"))
    return Effect.gen(function*() {
      const bot = yield* createBot({ name: "Ada", tools: ["shell"] })
      const shell = (yield* (yield* Toolbox).forBot(bot)).tools.find((t) => t.name === "run_command")!
      const failure = yield* Effect.flip(shell.run({ command: "echo hi" }))
      expect(failure.message).toContain("Can't set up this bot's Linux user")
    }).pipe(
      Effect.provide(testLayer(model.layer, tempDir(), {
        botUser: Option.some({ user: "per-bot", group: "weaver-work" }),
        botUserHelper: "/nonexistent/weaver-bot-user"
      }))
    )
  }, 20_000)
})
