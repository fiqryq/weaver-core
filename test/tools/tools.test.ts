import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentTool } from "../../src/tools/AgentTool.ts"
import { fileTools, resolveInWorkspace } from "../../src/tools/builtin/Files.ts"
import { sanitizeToolName, slugify } from "../../src/tools/builtin/Mcp.ts"
import { attribute, coreExcerpt, pinProject } from "../../src/tools/builtin/Memory.ts"
import { clip, runCommandTool } from "../../src/tools/builtin/Shell.ts"
import { tempDir } from "../support/layers.ts"

const workspaceWithOutside = () => {
  const root = tempDir()
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  writeFileSync(join(root, "secret.txt"), "top secret")
  return { root, workspace }
}

const tool = (tools: ReadonlyArray<AgentTool>, name: string) => tools.find((t) => t.name === name)!

describe("workspace sandbox", () => {
  it.effect("resolves paths inside the workspace", () =>
    Effect.gen(function*() {
      const { workspace } = workspaceWithOutside()
      const resolved = yield* resolveInWorkspace(workspace, "notes/today.md")
      expect(resolved.endsWith(join("workspace", "notes", "today.md"))).toBe(true)
    }))

  it.effect("refuses parent-directory escapes and absolute paths outside", () =>
    Effect.gen(function*() {
      const { root, workspace } = workspaceWithOutside()
      const up = yield* Effect.flip(resolveInWorkspace(workspace, "../secret.txt"))
      expect(up.message).toContain("outside your workspace")
      const absolute = yield* Effect.flip(resolveInWorkspace(workspace, join(root, "secret.txt")))
      expect(absolute.message).toContain("outside your workspace")
      yield* Effect.flip(resolveInWorkspace(workspace, "/etc/passwd"))
    }))

  it.effect("refuses symlinks that point outside", () =>
    Effect.gen(function*() {
      const { root, workspace } = workspaceWithOutside()
      symlinkSync(root, join(workspace, "escape"))
      const failure = yield* Effect.flip(resolveInWorkspace(workspace, "escape/secret.txt"))
      expect(failure.message).toContain("outside your workspace")
      const newFile = yield* Effect.flip(resolveInWorkspace(workspace, "escape/new.txt"))
      expect(newFile.message).toContain("outside your workspace")
    }))

  it.effect("refuses writing through a broken symlink that points outside", () =>
    Effect.gen(function*() {
      const { root, workspace } = workspaceWithOutside()
      const outside = join(root, "created-outside.txt")
      symlinkSync(outside, join(workspace, "dangling.txt"))
      const tools = fileTools({ workspace, writesNeedApproval: false, allowWrites: true })

      const write = yield* Effect.flip(tool(tools, "write_file").run({ path: "dangling.txt", content: "pwned" }))
      expect(write._tag).toBe("ToolFailure")
      const edit = yield* Effect.flip(tool(tools, "edit_file").run({ path: "dangling.txt", old_text: "a", new_text: "b" }))
      expect(edit._tag).toBe("ToolFailure")
      expect(existsSync(outside)).toBe(false)
    }))

  it.effect("refuses every file tool through a symlinked folder that points outside", () =>
    Effect.gen(function*() {
      const { root, workspace } = workspaceWithOutside()
      symlinkSync(root, join(workspace, "escape"))
      const tools = fileTools({ workspace, writesNeedApproval: false, allowWrites: true })

      for (const [name, params] of [
        ["read_file", { path: "escape/secret.txt" }],
        ["list_files", { path: "escape" }],
        ["write_file", { path: "escape/new/deep.txt", content: "pwned" }],
        ["edit_file", { path: "escape/secret.txt", old_text: "top", new_text: "no" }]
      ] as const) {
        const failure = yield* Effect.flip(tool(tools, name).run(params))
        expect(failure.message).toContain("outside your workspace")
      }
      expect(existsSync(join(root, "new"))).toBe(false)
      expect(readFileSync(join(root, "secret.txt"), "utf8")).toBe("top secret")
    }))

  it.effect("follows symlinks that stay inside the workspace", () =>
    Effect.gen(function*() {
      const { workspace } = workspaceWithOutside()
      mkdirSync(join(workspace, "real"))
      writeFileSync(join(workspace, "real", "note.txt"), "inside")
      symlinkSync(join(workspace, "real"), join(workspace, "alias"))
      symlinkSync("real/note.txt", join(workspace, "note-link.txt"))
      const tools = fileTools({ workspace, writesNeedApproval: false, allowWrites: true })

      expect(yield* tool(tools, "read_file").run({ path: "alias/note.txt" })).toBe("inside")
      expect(yield* tool(tools, "read_file").run({ path: "note-link.txt" })).toBe("inside")
      yield* tool(tools, "write_file").run({ path: "alias/sub/new.txt", content: "via link" })
      expect(readFileSync(join(workspace, "real", "sub", "new.txt"), "utf8")).toBe("via link")
    }))

  it.effect("creates new nested folders inside the workspace", () =>
    Effect.gen(function*() {
      const { workspace } = workspaceWithOutside()
      const tools = fileTools({ workspace, writesNeedApproval: false, allowWrites: true })
      yield* tool(tools, "write_file").run({ path: "x/y/z/deep.txt", content: "deep" })
      expect(readFileSync(join(workspace, "x", "y", "z", "deep.txt"), "utf8")).toBe("deep")
      expect(yield* tool(tools, "list_files").run({ path: "x/y" })).toBe("z/")
    }))

  it.effect("file tools read, write and edit inside the workspace only", () =>
    Effect.gen(function*() {
      const { workspace } = workspaceWithOutside()
      const tools = fileTools({ workspace, writesNeedApproval: false, allowWrites: true })
      yield* tool(tools, "write_file").run({ path: "a/b.txt", content: "one two one" })
      expect(yield* tool(tools, "read_file").run({ path: "a/b.txt" })).toBe("one two one")
      expect(yield* tool(tools, "list_files").run({})).toBe("a/")

      const ambiguous = yield* Effect.flip(tool(tools, "edit_file").run({ path: "a/b.txt", old_text: "one", new_text: "1" }))
      expect(ambiguous.message).toContain("more than once")
      yield* tool(tools, "edit_file").run({ path: "a/b.txt", old_text: "two", new_text: "2" })
      expect(yield* tool(tools, "read_file").run({ path: "a/b.txt" })).toBe("one 2 one")

      const outside = yield* Effect.flip(tool(tools, "read_file").run({ path: "../secret.txt" }))
      expect(outside.message).toContain("outside your workspace")
      const bad = yield* Effect.flip(tool(tools, "write_file").run({ path: 5 }))
      expect(bad._tag).toBe("ToolFailure")
    }))

  it("approval mode controls which file tools exist and need approval", () => {
    const workspace = tempDir()
    const readOnly = fileTools({ workspace, writesNeedApproval: false, allowWrites: false })
    expect(readOnly.map((t) => t.name)).toEqual(["read_file", "list_files"])
    const ask = fileTools({ workspace, writesNeedApproval: true, allowWrites: true })
    expect(ask.filter((t) => t.needsApproval).map((t) => t.name)).toEqual(["write_file", "edit_file"])
  })
})

describe("run_command", () => {
  const withShell = (f: (shell: AgentTool, workspace: string) => Effect.Effect<void, unknown>) =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const workspace = tempDir()
      yield* f(runCommandTool({ workspace, display: ":1", needsApproval: false, spawner }), workspace)
    }).pipe(Effect.provide(BunServices.layer))

  it.live("runs in the workspace and returns output", () =>
    withShell((shell, workspace) =>
      Effect.gen(function*() {
        const output = yield* shell.run({ command: "pwd && echo $DISPLAY" })
        expect(output).toContain(workspace.split("/").at(-1)!)
        expect(output).toContain(":1")
      })
    ))

  it.live("hides the server's own secrets from commands", () =>
    withShell((shell) =>
      Effect.gen(function*() {
        process.env.WEAVER_TOKEN = "server-secret"
        process.env.SOME_TOOL_HOME = "/opt/tool"
        const output = yield* shell.run({ command: "echo \"[$WEAVER_TOKEN] [$SOME_TOOL_HOME]\"" })
        expect(output).toBe("[] [/opt/tool]")
        delete process.env.SOME_TOOL_HOME
      })
    ))

  it.live("reports a non-zero exit code as a failure", () =>
    withShell((shell) =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(shell.run({ command: "echo oops >&2; exit 3" }))
        expect(failure.message).toContain("oops")
        expect(failure.message).toContain("3")
      })
    ))

  it.live("times out long commands", () =>
    withShell((shell) =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(shell.run({ command: "sleep 5", timeout_seconds: 1 }))
        expect(failure.message).toContain("Stopped after 1 seconds")
      })
    ), 10_000)

  it("clips long output, keeping the start and end", () => {
    const text = `${"a".repeat(10_000)}MIDDLE${"z".repeat(10_000)}`
    const clipped = clip(text, 1000)
    expect(clipped.length).toBeLessThan(1200)
    expect(clipped.startsWith("a")).toBe(true)
    expect(clipped.endsWith("z")).toBe(true)
    expect(clipped).not.toContain("MIDDLE")
  })
})

describe("memory and MCP helpers", () => {
  it("pins every memory call to the configured project", () => {
    expect(pinProject({ query: "x", project: "other", search_all_projects: true, workspace: "w" }, "weaver"))
      .toEqual({ query: "x", project: "weaver" })
  })

  it("attributes notes to the bot that wrote them", () => {
    expect(attribute({ content: "Likes tea" }, "Ada").content).toContain("Ada")
    expect(attribute({ title: "t" }, "Ada")).toEqual({ title: "t" })
  })

  it("keeps core memory excerpts short", () => {
    expect(coreExcerpt("   ")).toBeUndefined()
    expect(coreExcerpt("x".repeat(10_000))!.length).toBeLessThanOrEqual(4100)
  })

  it("makes provider-safe tool names", () => {
    expect(slugify("Google Calendar!")).toBe("google_calendar")
    expect(sanitizeToolName("github__create issue.v2")).toBe("github__create_issue_v2")
    expect(sanitizeToolName("x".repeat(100))).toHaveLength(64)
  })
})
