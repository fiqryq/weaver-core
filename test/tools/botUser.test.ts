import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Option } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { AppConfig } from "../../src/config/Config.ts"
import type { AgentTool } from "../../src/tools/AgentTool.ts"
import { ensureWorkspace, groupId } from "../../src/tools/builtin/Files.ts"
import { commandSpec, killGraceSeconds, runCommandTool } from "../../src/tools/builtin/Shell.ts"
import { tempDir } from "../support/layers.ts"

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
      args: ["-lc", "ls -la"],
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
      "DISPLAY=:1",
      "TERM=dumb",
      "PAGER=cat",
      "GIT_PAGER=cat",
      "timeout",
      "-k",
      String(killGraceSeconds),
      "30",
      "bash",
      "-c",
      "umask 007 && cd -- \"$1\" && exec bash -lc \"$2\"",
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
    for (const leaked of ["secret", "HOME=", "USER=", "SOME_TOOL_HOME"]) expect(joined).not.toContain(leaked)
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
        expect(vars).toBe("[] [] [:1] [dumb]")
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
      Effect.runSync(
        Effect.map(AppConfig, (config) => config.botUser).pipe(
          Effect.provide(AppConfig.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ WEAVER_TOKEN: "t", ...vars })))
        )
      )
    expect(load({})).toEqual(Option.none())
    expect(load({ WEAVER_BOT_USER: " " })).toEqual(Option.none())
    expect(load({ WEAVER_BOT_USER: "weaver-bot" })).toEqual(Option.some({ user: "weaver-bot", group: "weaver-work" }))
    expect(load({ WEAVER_BOT_USER: "b", WEAVER_BOT_GROUP: "g" })).toEqual(Option.some({ user: "b", group: "g" }))
  })
})
