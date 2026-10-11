import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { McpHub } from "../../src/features/integrations/McpHub.ts"
import { CoreMemory } from "../../src/features/learning/memory/CoreMemory.ts"
import { memoryServerConfig, pinProject } from "../../src/tools/builtin/Memory.ts"
import { startOpenAiMock } from "../support/fixtures/openAiMock.ts"
import { createBot, createConversation, sendAndWait } from "../support/layers.ts"
import { realModelLayer, useEndpoint } from "../support/realModel.ts"

/**
 * Memory recall against a real Basic Memory server. Opt in with `WEAVER_E2E_MEMORY_URL` (e.g.
 * http://127.0.0.1:8765/mcp) and `WEAVER_E2E_MEMORY_PROJECT`, a throwaway project: notes are written there.
 */
const url = process.env.WEAVER_E2E_MEMORY_URL ?? ""
const project = process.env.WEAVER_E2E_MEMORY_PROJECT ?? ""
const enabled = url.length > 0 && project.length > 0
const memory = { url, token: process.env.WEAVER_E2E_MEMORY_TOKEN ?? "", project }

const mock = startOpenAiMock(() => ({ text: "Noted." }))
afterAll(() => mock.close())

describe.skipIf(!enabled)("memory recall with a real Basic Memory", () => {
  it.live("recalls a note written moments ago, without Core Memory or its backups", () => {
    const word = `quokka${Date.now()}`
    return Effect.gen(function*() {
      const hub = yield* McpHub
      const call = (name: string, args: Record<string, unknown>) =>
        hub.call(memoryServerConfig(memory), name, pinProject({ ...args, output_format: "json" }, project))
      const write = (title: string, directory: string, content: string) =>
        call("write_note", { title, directory, content, overwrite: true })
      yield* write(`Recall probe ${word}`, "weaver", `The user's ${word} lives in   Bandung.\n\n- [fact] ${word}`)
      yield* write("Core Memory", "weaver", `# Core Memory\n- [fact] The user's ${word} is mentioned here too (via Probe)`)
      yield* write(`Core Memory before condensing ${word}`, "weaver/core-memory-history", `- [fact] Older ${word}`)

      const raw = yield* call("search_notes", { query: word, search_type: "text" })
      expect(JSON.parse(raw.text).results).toHaveLength(3)
      const recalled = yield* (yield* CoreMemory).recall(`Where does my ${word} live?`, project)
      expect(recalled.map((note) => note.title)).toContain(`Recall probe ${word}`)
      expect(recalled.filter((note) => note.title.startsWith("Core Memory"))).toEqual([])

      yield* useEndpoint(mock.url, "mock-model")
      const bot = yield* createBot({ name: "Ada", tools: ["memory"] })
      const conversation = yield* createConversation([bot.id])
      const events = yield* sendAndWait(conversation.id, `Where does my ${word} live?`)
      expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "done" })

      const system = String(mock.streamed().at(-1)!.body.messages[0]!.content)
      expect(system).toContain("## Memory recall")
      expect(system).toMatch(
        new RegExp(`- \\*\\*Recall probe ${word}\\*\\* \\(\`[^\`]*weaver/recall-probe-${word}\`\\) — The user's ${word} lives in Bandung\\.`)
      )
      expect(system).not.toContain(`Older ${word}`)
    }).pipe(Effect.provide(realModelLayer({ memory: Option.some(memory) })))
  })
})
