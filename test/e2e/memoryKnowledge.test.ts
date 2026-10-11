import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Option } from "effect"
import { McpHub } from "../../src/features/integrations/McpHub.ts"
import { KnowledgeBase } from "../../src/features/memory/KnowledgeBase.ts"
import type { MemoryGraph } from "../../src/features/memory/Memory.ts"
import { memoryServerConfig, pinProject } from "../../src/tools/builtin/Memory.ts"
import { say, scriptedModel, testLayer } from "../support/layers.ts"

/**
 * Projects, the knowledge graph and note history against a real Basic Memory server. Opt in with
 * `WEAVER_E2E_MEMORY_URL` (e.g. http://127.0.0.1:8765/mcp) and `WEAVER_E2E_MEMORY_PROJECT`, a throwaway
 * project: notes are written there, and a project is created and removed next to it.
 */
const url = process.env.WEAVER_E2E_MEMORY_URL ?? ""
const project = process.env.WEAVER_E2E_MEMORY_PROJECT ?? ""
const enabled = url.length > 0 && project.length > 0
const memory = { url, token: process.env.WEAVER_E2E_MEMORY_TOKEN ?? "", project }

describe.skipIf(!enabled)("memory knowledge with a real Basic Memory", () => {
  it.live("summarizes the graph, keeps note history and restores a version exactly", () => {
    const word = `narwhal${Date.now()}`
    return Effect.gen(function*() {
      const hub = yield* McpHub
      const call = (name: string, args: Record<string, unknown>) =>
        hub.call(memoryServerConfig(memory), name, pinProject({ ...args, output_format: "json" }, project))
      yield* call("write_note", {
        title: `Captain ${word}`,
        directory: "e2e",
        note_type: "character",
        content: `# Captain\n\n- [trait] Restless ${word}\n- [quote] "Call me" ${word}\n- commands [[Ship ${word}]]\n- part_of [[Nowhere ${word}]]`
      })
      yield* call("write_note", { title: `Ship ${word}`, directory: "e2e", content: `- [fact] Sails ${word}` })
      yield* call("write_note", { title: `Alone ${word}`, directory: "e2e", content: "No links here." })

      const knowledge = yield* KnowledgeBase
      const linked = (graph: MemoryGraph) => {
        const captain = graph.nodes.find((node) => node.title === `Captain ${word}`)
        return graph.edges.some((edge) => edge.source === captain?.id && edge.type === "commands")
      }
      // Basic Memory resolves a link to a note written later in the background.
      let graph = yield* knowledge.graph(project, true)
      for (let attempt = 0; attempt < 50 && !linked(graph); attempt++) {
        yield* Effect.sleep(Duration.millis(100))
        graph = yield* knowledge.graph(project, true)
      }
      expect(graph.project).toBe(project)
      expect(graph.nodes.find((node) => node.title === `Captain ${word}`)).toMatchObject({ type: "character", observations: 2 })
      expect(linked(graph)).toBe(true)
      expect(graph.unresolvedRelations).toBeGreaterThanOrEqual(1)
      expect(graph.unlinked.some((note) => note.title === `Alone ${word}`)).toBe(true)
      expect(graph.noteTypes.some((type) => type.name === "character")).toBe(true)
      expect(graph.observationCategories.map((category) => category.name)).toEqual(expect.arrayContaining(["trait", "quote"]))

      const identifier = `e2e/Ship ${word}`
      const first = yield* knowledge.history(project, identifier)
      expect(first.versions).toHaveLength(1)
      const original = yield* knowledge.version(first.versions[0]!.id)
      expect(original.content).toContain("permalink:")

      yield* call("edit_note", { identifier, operation: "append", content: `- [fact] Changed ${word}` })
      const second = yield* knowledge.history(project, identifier)
      expect(second.versions).toHaveLength(2)

      const restored = yield* knowledge.restore(first.versions[0]!.id, "You")
      expect(restored).toMatchObject({ source: "You", checksum: first.versions[0]!.checksum })
      const read = yield* call("read_note", { identifier, include_frontmatter: true })
      expect(JSON.parse(read.text).content).toBe(original.content)

      const extra = `weaver-e2e-${Date.now()}`
      const created = yield* knowledge.createProject(extra)
      expect(created.path.endsWith(`/basic-memory-projects/${extra}`)).toBe(true)
      expect((yield* knowledge.projects).projects.map((p) => p.name)).toContain(extra)
      yield* knowledge.removeProject(extra)
      expect((yield* knowledge.projects).projects.map((p) => p.name)).not.toContain(extra)
    }).pipe(Effect.provide(testLayer(scriptedModel(() => say("")).layer, undefined, { memory: Option.some(memory) })))
  })
})
