import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentTool } from "../../src/tools/AgentTool.ts"
import { fileTools, formatBytes, maxFileBytes, resolveInWorkspace } from "../../src/tools/builtin/Files.ts"
import { sanitizeToolName, slugify } from "../../src/tools/builtin/Mcp.ts"
import {
  attribute,
  coreExcerpt,
  coreHeadLimit,
  coreLimit,
  noteWriteError,
  pinProject
} from "../../src/tools/builtin/Memory.ts"
import { headBytes, killGraceSeconds, OutputBuffer, runCommandTool, tailBytes } from "../../src/tools/builtin/Shell.ts"
import { tempDir } from "../support/layers.ts"

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits up to a few seconds for a process to be gone. */
const waitUntilDead = (pid: number) =>
  Effect.gen(function*() {
    for (let i = 0; i < 50 && isAlive(pid); i++) yield* Effect.sleep("100 millis")
    return !isAlive(pid)
  })

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

describe("file tool limits", () => {
  const setup = () => {
    const workspace = tempDir()
    return { workspace, tools: fileTools({ workspace, writesNeedApproval: false, allowWrites: true }) }
  }

  it.effect("treats null arguments as left out and still reports missing ones", () =>
    Effect.gen(function*() {
      const { tools, workspace } = setup()
      writeFileSync(join(workspace, "a.txt"), "one\ntwo\nthree")
      expect(yield* tool(tools, "read_file").run({ path: "a.txt", offset: null, limit: null })).toBe("one\ntwo\nthree")
      expect(yield* tool(tools, "read_file").run({ path: "a.txt", offset: 2, limit: null })).toBe("two\nthree")
      expect(yield* tool(tools, "list_files").run({ path: null })).toBe("a.txt")
      const missing = yield* Effect.flip(tool(tools, "write_file").run({ path: null, content: "x" }))
      expect(missing.message).toContain("Invalid arguments")
    }))

  it.effect("reads only the first megabyte of a big file and says so", () =>
    Effect.gen(function*() {
      const { tools, workspace } = setup()
      writeFileSync(join(workspace, "big.log"), `${"line\n".repeat(300_000)}LAST`)
      const output = yield* tool(tools, "read_file").run({ path: "big.log" })
      expect(output).toContain("more than")
      expect(output).toContain(`only the first ${formatBytes(maxFileBytes)} of this 1.4 MB file can be read`)
      expect(output).not.toContain("LAST")
      const past = yield* tool(tools, "read_file").run({ path: "big.log", offset: 290_000, limit: 5 })
      expect(past).toContain("nothing at this offset")
    }))

  it.effect("recognizes binary files instead of returning garbage", () =>
    Effect.gen(function*() {
      const { tools, workspace } = setup()
      writeFileSync(join(workspace, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
      expect(yield* tool(tools, "read_file").run({ path: "image.png" })).toBe("image.png is a binary file (7 bytes); read_file only shows text.")
      const edit = yield* Effect.flip(tool(tools, "edit_file").run({ path: "image.png", old_text: "PNG", new_text: "JPG" }))
      expect(edit.message).toContain("binary")
    }))

  it.effect("refuses to write or edit files over the size limit", () =>
    Effect.gen(function*() {
      const { tools, workspace } = setup()
      const tooBig = yield* Effect.flip(tool(tools, "write_file").run({ path: "big.txt", content: "x".repeat(maxFileBytes + 1) }))
      expect(tooBig.message).toContain("at most 1.0 MB")
      expect(existsSync(join(workspace, "big.txt"))).toBe(false)

      writeFileSync(join(workspace, "huge.txt"), "y".repeat(maxFileBytes + 10))
      const huge = yield* Effect.flip(tool(tools, "edit_file").run({ path: "huge.txt", old_text: "yy", new_text: "z" }))
      expect(huge.message).toContain("only edits files up to 1.0 MB")

      writeFileSync(join(workspace, "edge.txt"), `${"y".repeat(maxFileBytes - 1)}A`)
      const grow = yield* Effect.flip(tool(tools, "edit_file").run({ path: "edge.txt", old_text: "A", new_text: "AB" }))
      expect(grow.message).toContain("at most 1.0 MB")
      yield* tool(tools, "edit_file").run({ path: "edge.txt", old_text: "A", new_text: "B" })
      expect(readFileSync(join(workspace, "edge.txt"), "utf8").endsWith("yB")).toBe(true)
    }))
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

  it.live("keeps only the start and end of output over a megabyte", () =>
    withShell((shell) =>
      Effect.gen(function*() {
        const output = yield* shell.run({ command: "seq 1 300000" })
        expect(output.startsWith("1\n2\n3\n")).toBe(true)
        expect(output.endsWith("299999\n300000")).toBe(true)
        expect(output).toMatch(/… \d+ bytes omitted …/)
        expect(output.length).toBeLessThanOrEqual(headBytes + tailBytes + 100)
      })
    ), 10_000)

  it.live("interleaves stdout and stderr in the order they were written", () =>
    withShell((shell) =>
      Effect.gen(function*() {
        const output = yield* shell.run({ command: "echo out1; echo err1 >&2; echo out2; echo err2 >&2" })
        expect(output).toBe("out1\nerr1\nout2\nerr2")
      })
    ))

  it.live("kills a command that ignores SIGTERM after the grace period", () =>
    withShell((shell, workspace) =>
      Effect.gen(function*() {
        const startedAt = Date.now()
        const failure = yield* Effect.flip(
          shell.run({ command: "trap '' TERM; echo started; sleep 30 & echo $! > sleep.pid; wait", timeout_seconds: 1 })
        )
        expect(failure.message).toContain("started")
        expect(failure.message).toContain("Stopped after 1 seconds")
        expect(Date.now() - startedAt).toBeLessThan((1 + killGraceSeconds + 3) * 1000)
        expect(yield* waitUntilDead(Number(readFileSync(join(workspace, "sleep.pid"), "utf8")))).toBe(true)
      })
    ), 20_000)

  it.live("stops background jobs when the command ends", () =>
    withShell((shell, workspace) =>
      Effect.gen(function*() {
        const startedAt = Date.now()
        const output = yield* shell.run({ command: "sleep 30 & echo $! > bg.pid; echo done" })
        expect(output).toBe("done")
        expect(Date.now() - startedAt).toBeLessThan(5_000)
        expect(yield* waitUntilDead(Number(readFileSync(join(workspace, "bg.pid"), "utf8")))).toBe(true)
      })
    ), 15_000)

  it.live("treats null arguments as left out", () =>
    withShell((shell) =>
      Effect.gen(function*() {
        expect(yield* shell.run({ command: "echo hi", timeout_seconds: null })).toBe("hi")
      })
    ))
})

describe("OutputBuffer", () => {
  const bytes = (text: string) => new TextEncoder().encode(text)

  it("keeps everything that fits", () => {
    const buffer = new OutputBuffer(4, 6)
    for (const chunk of ["ab", "cdef", "ghij"]) buffer.push(bytes(chunk))
    expect(buffer.text()).toBe("abcdefghij")
  })

  it("keeps the head and the tail across chunks, counting what's left out", () => {
    const buffer = new OutputBuffer(4, 6)
    for (const chunk of ["abc", "defgh", "ijklmno", "p"]) buffer.push(bytes(chunk))
    expect(buffer.text()).toBe("abcd\n… 6 bytes omitted …\nklmnop")
    const big = new OutputBuffer(4, 6)
    big.push(bytes("0123456789abcdefghij"))
    expect(big.text()).toBe("0123\n… 10 bytes omitted …\nefghij")
  })

  it("never shows half a character at the cuts", () => {
    const buffer = new OutputBuffer(5, 5)
    buffer.push(bytes("ééééééééé"))
    expect(buffer.text()).not.toContain("\uFFFD")
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
    expect(coreExcerpt("  # Rules\n- [fact] Tea  \n")).toBe("# Rules\n- [fact] Tea")
    expect(coreExcerpt("x".repeat(10_000))!.length).toBeLessThanOrEqual(4100)
  })

  it("keeps the start and the newest lines of an over-long core memory, cutting whole lines", () => {
    const head = "# Who the user is\nThe user is Fiqry, a developer in Jakarta."
    const facts = Array.from({ length: 200 }, (_, i) => `- [fact] Fact number ${i} is worth keeping (via Ada)`)
    const note = [head, ...facts].join("\n")
    const excerpt = coreExcerpt(note)!
    const lines = excerpt.split("\n")

    expect(excerpt.length).toBeLessThanOrEqual(coreLimit + 100)
    expect(excerpt.startsWith(head)).toBe(true)
    expect(excerpt.endsWith(facts.at(-1)!)).toBe(true)
    const marker = lines.findIndex((line) => line.startsWith("… ("))
    expect(lines[marker]).toMatch(/^… \(\d+ characters of older facts omitted — Core Memory is being condensed\)$/)
    for (const line of lines.filter((_, i) => i !== marker)) expect(note.split("\n")).toContain(line)
    const kept = lines.slice(0, marker).join("\n").length
    expect(kept).toBeLessThanOrEqual(coreHeadLimit)
    expect(kept).toBeGreaterThan(coreHeadLimit - 60)

    const omitted = Number(/\d+/.exec(lines[marker]!)![0])
    const rest = [...lines.slice(0, marker), ...lines.slice(marker + 1)].join("\n").length
    expect(omitted + rest).toBe(note.length - 1)
  })

  it("reads whether a note write worked from Basic Memory's JSON answer", () => {
    expect(noteWriteError(`{"permalink":"weaver/x","action":"created","error":null}`)).toBeUndefined()
    expect(noteWriteError(`{"action":"conflict","error":"NOTE_ALREADY_EXISTS"}`)).toBe("NOTE_ALREADY_EXISTS")
    expect(noteWriteError("# Edit Failed - Text Not Found")).toContain("unexpected answer")
  })

  it("makes provider-safe tool names", () => {
    expect(slugify("Google Calendar!")).toBe("google_calendar")
    expect(sanitizeToolName("github__create issue.v2")).toBe("github__create_issue_v2")
    expect(sanitizeToolName("x".repeat(100))).toHaveLength(64)
  })
})
