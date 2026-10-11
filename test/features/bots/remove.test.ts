import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BunHttpServer } from "@effect/platform-bun"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Layer, Option } from "effect"
import { HttpRouter } from "effect/http"
import type { AppConfigShape } from "../../../src/config/Config.ts"
import { AppRoutes } from "../../../src/main.ts"
import { callTool, type Script, say, scriptedModel, tempDir, testLayer } from "../../support/layers.ts"

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

const makeClient = (script: Script, dataDir: string, config: Partial<AppConfigShape> = {}) => {
  const model = scriptedModel(script)
  const web = HttpRouter.toWebHandler(
    AppRoutes.pipe(Layer.provide(testLayer(model.layer, dataDir, config)), Layer.provide(BunHttpServer.layerHttpServices)),
    { disableLogger: true }
  )
  dispose = web.dispose
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await web.handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: "Bearer test-token", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    )
    const text = await response.text()
    return { status: response.status, json: text.length > 0 ? JSON.parse(text) : undefined }
  }
  return { request, model }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check: () => boolean, millis = 8_000) => {
  const deadline = Date.now() + millis
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  return check()
}

describe("deleting a bot", () => {
  it("stops its running reply, kills its command and deletes its files", async () => {
    const dataDir = tempDir()
    const { model, request } = makeClient(
      (call) =>
        call.index === 0 ? callTool("run_command", { command: "echo $$ > ../command.pid; sleep 30" }) : say("done"),
      dataDir
    )
    expect((await request("PUT", "/v1/providers/deepseek", { apiKey: "sk-test" })).status).toBe(200)
    const bot = (await request("POST", "/v1/bots", { name: "Ada", tools: ["shell", "files"], approvalMode: "auto" })).json
    const conversation = (await request("POST", "/v1/conversations", { botIds: [bot.id] })).json
    expect((await request("POST", `/v1/conversations/${conversation.id}/messages`, { text: "Work" })).status).toBe(200)

    const botDir = join(dataDir, "bots", bot.id)
    const pidFile = join(botDir, "command.pid")
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0)).toBe(true)
    const pid = Number(readFileSync(pidFile, "utf8"))
    expect(isAlive(pid)).toBe(true)

    expect((await request("DELETE", `/v1/bots/${bot.id}`)).status).toBe(204)
    expect(await waitFor(() => !isAlive(pid))).toBe(true)
    expect(existsSync(botDir)).toBe(false)
    expect((await request("GET", `/v1/conversations/${conversation.id}`)).status).toBe(404)
    expect((await request("GET", `/v1/bots/${bot.id}`)).status).toBe(404)
    expect(model.calls).toHaveLength(1)
  }, 20_000)

  it("removes the bot's own Linux user in per-bot mode, after its skills and before its files", async () => {
    const dataDir = tempDir()
    const bin = tempDir()
    const log = join(bin, "calls.log")
    writeFileSync(join(bin, "sudo"), "#!/bin/sh\n[ \"$1\" = -n ] || exit 98\nshift\nexec \"$@\"\n")
    writeFileSync(
      join(bin, "helper"),
      `#!/bin/sh\necho "$1 $2 skills=$([ -e "${dataDir}/bots/$2/skills" ] && echo yes || echo no) files=$([ -e "${dataDir}/bots/$2/workspace" ] && echo yes || echo no)" >> ${log}\n`
    )
    chmodSync(join(bin, "sudo"), 0o755)
    chmodSync(join(bin, "helper"), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      const { request } = makeClient(() => say("ok"), dataDir, {
        botUser: Option.some({ user: "per-bot", group: "weaver-work" }),
        botUserHelper: join(bin, "helper")
      })
      const bot = (await request("POST", "/v1/bots", { name: "Ada" })).json
      const keep = (await request("POST", "/v1/bots", { name: "Grace" })).json
      for (const id of [bot.id, keep.id]) {
        mkdirSync(join(dataDir, "bots", id, "workspace", "project"), { recursive: true })
        mkdirSync(join(dataDir, "bots", id, "skills"), { recursive: true })
        writeFileSync(join(dataDir, "bots", id, "workspace", "project", "notes.md"), "hi")
      }

      expect((await request("DELETE", `/v1/bots/${bot.id}`)).status).toBe(204)
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([`remove ${bot.id} skills=no files=yes`])
      expect(existsSync(join(dataDir, "bots", bot.id))).toBe(false)
      expect(existsSync(join(dataDir, "bots", keep.id, "workspace", "project", "notes.md"))).toBe(true)
      expect((await request("DELETE", `/v1/bots/${bot.id}`)).status).toBe(404)
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1)
    } finally {
      process.env.PATH = path
    }
  }, 20_000)
})
