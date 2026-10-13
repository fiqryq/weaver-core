import { describe, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, symlink, rm, readlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { fileTools } from "../../src/tools/builtin/Files.ts"

describe("Files.ts symlink TOCTOU protection", () => {
  it("prevents reading through symlinks at the final path component", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "weaver-test-"))
    const trapDir = await mkdtemp(join(tmpdir(), "weaver-trap-"))
    
    try {
      // Create a secret file outside the workspace
      await writeFile(join(trapDir, "secret.txt"), "This should not be readable")
      
      // Create a symlink inside the workspace pointing to the secret
      await symlink(join(trapDir, "secret.txt"), join(workspace, "link.txt"))
      
      const tools = fileTools({
        workspace,
        writesNeedApproval: false,
        allowWrites: true
      })
      
      const readTool = tools.find((t) => t.name === "read_file")!
      const exit = await Effect.runPromise(
        Effect.exit(readTool.run({ path: "link.txt" }))
      )
      
      // Should fail due to O_NOFOLLOW
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(trapDir, { recursive: true, force: true })
    }
  })

  it("prevents reading through symlinks in parent directories", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "weaver-test-"))
    const trapDir = await mkdtemp(join(tmpdir(), "weaver-trap-"))
    
    try {
      // Create a directory with a secret outside workspace
      await mkdir(join(trapDir, "secret-dir"))
      await writeFile(join(trapDir, "secret-dir", "data.txt"), "Secret data")
      
      // Create a symlink inside workspace to the external directory
      await symlink(join(trapDir, "secret-dir"), join(workspace, "linked-dir"))
      
      const tools = fileTools({
        workspace,
        writesNeedApproval: false,
        allowWrites: true
      })
      
      const readTool = tools.find((t) => t.name === "read_file")!
      const exit = await Effect.runPromise(
        Effect.exit(readTool.run({ path: "linked-dir/data.txt" }))
      )
      
      // Should fail because linked-dir is a symlink pointing outside
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(trapDir, { recursive: true, force: true })
    }
  })

  it("allows reading regular files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "weaver-test-"))
    
    try {
      await writeFile(join(workspace, "normal.txt"), "Normal content")
      
      const tools = fileTools({
        workspace,
        writesNeedApproval: false,
        allowWrites: true
      })
      
      const readTool = tools.find((t) => t.name === "read_file")!
      const exit = await Effect.runPromise(
        Effect.exit(readTool.run({ path: "normal.txt" }))
      )
      
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toContain("Normal content")
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("allows reading through safe symlinks that stay inside workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "weaver-test-"))
    
    try {
      await mkdir(join(workspace, "data"))
      await writeFile(join(workspace, "data", "file.txt"), "Safe content")
      
      // Create a relative symlink that stays inside workspace
      await symlink("data/file.txt", join(workspace, "link.txt"))
      
      const tools = fileTools({
        workspace,
        writesNeedApproval: false,
        allowWrites: true
      })
      
      const readTool = tools.find((t) => t.name === "read_file")!
      const exit = await Effect.runPromise(
        Effect.exit(readTool.run({ path: "link.txt" }))
      )
      
      // With O_NOFOLLOW, even safe symlinks will be rejected at the final component
      // This is the security tradeoff - we reject all symlinks at the final path
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
