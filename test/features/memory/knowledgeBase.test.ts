import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/http"
import { AppConfig, type AppConfigShape } from "../../../src/config/Config.ts"
import { BotRepo } from "../../../src/features/bots/BotRepo.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { IntegrationOAuth } from "../../../src/features/integrations/IntegrationOAuth.ts"
import { IntegrationRepo } from "../../../src/features/integrations/IntegrationRepo.ts"
import { LibraryStore } from "../../../src/features/learning/library/LibraryStore.ts"
import { SkillSources } from "../../../src/features/learning/library/SkillSources.ts"
import { CoreMemory } from "../../../src/features/learning/memory/CoreMemory.ts"
import { SelfReview } from "../../../src/features/learning/review/SelfReview.ts"
import { SkillStore } from "../../../src/features/learning/skills/SkillStore.ts"
import { directoryPage, noteFile, observationPage, projectListing, relationPage } from "../../../src/features/memory/basicMemory.ts"
import { buildGraph } from "../../../src/features/memory/graph.ts"
import { KnowledgeBase, writeTarget } from "../../../src/features/memory/KnowledgeBase.ts"
import { Settings } from "../../../src/features/profile/Settings.ts"
import { type LanguageModelFactory, ProviderRegistry } from "../../../src/features/providers/ProviderRegistry.ts"
import { AgentRunnerLive } from "../../../src/features/runs/AgentRunnerLive.ts"
import { Approvals } from "../../../src/features/runs/Approvals.ts"
import { RunEvents } from "../../../src/features/runs/RunEvents.ts"
import { Toolbox } from "../../../src/features/runs/Toolbox.ts"
import { TeamRepo } from "../../../src/features/teams/TeamRepo.ts"
import { TeamSessions } from "../../../src/features/teams/TeamSessions.ts"
import { AppRoutes } from "../../../src/main.ts"
import { DatabaseTest } from "../../../src/platform/db/Database.ts"
import { BotUsers } from "../../../src/platform/os/BotUsers.ts"
import { Camofox } from "../../../src/tools/builtin/Camofox.ts"
import { fakeMemory, type FakeMemory } from "../../support/fakeMemory.ts"
import { callTool, createConversation, say, scriptedModel, sendAndWait, tempDir } from "../../support/layers.ts"
import { Updates } from "../../../src/features/updates/Updates.ts"

const services = (memory: FakeMemory, model: Layer.Layer<LanguageModelFactory>, config: Partial<AppConfigShape> = {}) =>
  TeamSessions.layer.pipe(
    Layer.provideMerge(AgentRunnerLive),
    Layer.provideMerge(SelfReview.layer),
    Layer.provideMerge(Toolbox.layer),
    Layer.provideMerge(KnowledgeBase.layer),
    Layer.provideMerge(CoreMemory.layer),
    Layer.provideMerge(Layer.mergeAll(LibraryStore.layer, SkillSources.layer)),
    Layer.provideMerge(Layer.mergeAll(SkillStore.layer, IntegrationOAuth.layer)),
    Layer.provideMerge(Layer.mergeAll(memory.layer, RunEvents.layer, Approvals.layer, BotUsers.layer, Camofox.layer, Updates.layer)),
    Layer.provideMerge(ProviderRegistry.layer),
    Layer.provideMerge(Layer.mergeAll(BotRepo.layer, ConversationRepo.layer, IntegrationRepo.layer, Settings.layer, TeamRepo.layer)),
    Layer.provideMerge(model),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(AppConfig.layerTest({
      dataDir: tempDir(),
      memory: Option.some({ url: "http://memory.test/mcp", token: "", project: "" }),
      browserCommand: [],
      reviewSkillInterval: 0,
      reviewMemoryInterval: 0,
      coreMemoryCondenseAt: 0,
      ...config
    }))
  )

/** Waits for background saves, polling with real time. */
const eventually = <A>(check: Effect.Effect<A, unknown, KnowledgeBase>, until: (value: A) => boolean) =>
  Effect.gen(function*() {
    for (let i = 0; i < 100; i++) {
      const value = yield* check
      if (until(value)) return value
      yield* Effect.sleep(Duration.millis(10))
    }
    throw new Error("Timed out waiting")
  })

describe("Basic Memory output", () => {
  it("reads projects, directory listings, search rows and notes as Basic Memory 0.23 writes them", () => {
    expect(projectListing(JSON.stringify({
      projects: [{ name: "main", path: "/home/weaver/basic-memory", is_default: true }, { name: "Research", path: "/r" }],
      default_project: "main"
    }))).toEqual({
      projects: [
        { name: "main", path: "/home/weaver/basic-memory", isDefault: true },
        { name: "Research", path: "/r", isDefault: false }
      ],
      defaultProject: "main"
    })
    const listing = directoryPage(JSON.stringify({
      nodes: [
        { name: "people", type: "directory", children: [], permalink: null, file_path: null },
        {
          name: "Ahab.md",
          type: "file",
          title: "Ahab",
          permalink: "main/people/ahab",
          file_path: "people/Ahab.md",
          note_type: "character",
          updated_at: "2026-10-11T21:26:24.434782+07:00"
        }
      ],
      total: 1,
      has_more: false
    }))
    expect(listing?.items).toEqual([{
      permalink: "main/people/ahab",
      title: "Ahab",
      filePath: "people/Ahab.md",
      noteType: "character",
      updatedAt: "2026-10-11T21:26:24.434782+07:00"
    }])
    expect(observationPage(JSON.stringify({
      results: [{ type: "observation", entity: "main/people/ahab", observation_id: 4, category: "trait" }],
      has_more: true
    }))).toEqual({ items: [{ id: "4", note: "main/people/ahab", category: "trait" }], hasMore: true, total: undefined })
    expect(relationPage(JSON.stringify({
      results: [
        { type: "relation", entity: "main/people/ahab", relation_id: 1, from_entity: "main/people/ahab", to_entity: "main/pequod", relation_type: "captain_of" },
        { type: "relation", entity: "main/people/ahab", relation_id: 3, from_entity: "main/people/ahab", relation_type: "part_of" }
      ]
    }))?.items).toEqual([
      { id: "1", from: "main/people/ahab", to: "main/pequod", type: "captain_of" },
      { id: "3", from: "main/people/ahab", to: undefined, type: "part_of" }
    ])
    expect(noteFile(JSON.stringify({ title: null, permalink: null, file_path: null, content: "" }))).toBeUndefined()
    expect(directoryPage("Error: not JSON")).toBeUndefined()
  })

  it("finds the note a write changes", () => {
    expect(writeTarget("write_note", { title: "Ahab", directory: "/people/" })).toBe("people/Ahab")
    expect(writeTarget("write_note", { title: "Top", directory: "" })).toBe("Top")
    expect(writeTarget("edit_note", { identifier: "weaver/core-memory" })).toBe("weaver/core-memory")
    expect(writeTarget("search_notes", { query: "x" })).toBeUndefined()
  })
})

describe("the knowledge graph", () => {
  const note = (permalink: string, noteType = "note") => ({
    permalink,
    title: permalink.split("/").at(-1)!,
    filePath: `${permalink}.md`,
    noteType,
    updatedAt: permalink
  })

  it("counts each row once and finds unlinked notes and unresolved relations", () => {
    const graph = buildGraph({
      project: "main",
      notes: [note("a", "character"), note("b"), note("c"), note("a", "character")],
      observations: [
        { id: "1", note: "a", category: "quote" },
        { id: "1", note: "a", category: "quote" },
        { id: "2", note: "b", category: "fact" },
        { id: "3", note: "a", category: "quote" }
      ],
      relations: [
        { id: "1", from: "a", to: "b", type: "knows" },
        { id: "1", from: "a", to: "b", type: "knows" },
        { id: "2", from: "a", to: undefined, type: "part_of" }
      ],
      generatedAt: "now"
    })
    expect(graph).toMatchObject({
      notes: 3,
      observations: 3,
      relations: 2,
      unresolvedRelations: 1,
      unlinkedNotes: 1,
      noteTypes: [{ name: "character", count: 1 }, { name: "note", count: 2 }].sort((x, y) => y.count - x.count),
      observationCategories: [{ name: "quote", count: 2 }, { name: "fact", count: 1 }],
      unlinked: [{ id: "c", title: "c" }],
      edges: [{ source: "a", target: "b", type: "knows" }],
      truncated: false
    })
    expect(graph.nodes[0]).toEqual({ id: "a", title: "a", type: "character", links: 2, observations: 2 })
  })

  it("keeps the best-connected notes when there are too many to draw", () => {
    const graph = buildGraph({
      project: "main",
      notes: [note("a"), note("b"), note("c")],
      observations: [],
      relations: [{ id: "1", from: "b", to: "c", type: "knows" }, { id: "2", from: "c", to: "a", type: "knows" }],
      generatedAt: "now"
    }, 2)
    expect(graph.nodes.map((node) => node.id)).toEqual(["c", "a"])
    expect(graph.edges).toEqual([{ source: "c", target: "a", type: "knows" }])
    expect(graph.truncated).toBe(true)
  })

  it.effect("is built from Basic Memory's listing and filter-only searches", () => {
    const memory = fakeMemory({
      "people/ahab": "Captain.\n\n- [trait] Obsessed\n- captain_of [[pequod]]\n- part_of [[Missing]]",
      "places/pequod": "A ship.\n\n- [fact] Sails",
      "misc/lonely": "No links."
    })
    return Effect.gen(function*() {
      const graph = yield* (yield* KnowledgeBase).graph("")
      expect(graph).toMatchObject({
        project: "main",
        notes: 3,
        observations: 2,
        relations: 2,
        unresolvedRelations: 1,
        unlinkedNotes: 1,
        unlinked: [{ id: "misc/lonely" }],
        edges: [{ source: "people/ahab", target: "places/pequod", type: "captain_of" }]
      })
      expect(memory.calls.filter((call) => call.name === "search_notes").map((call) => call.args.entity_types).sort())
        .toEqual([["observation"], ["relation"]])
    }).pipe(Effect.provide(services(memory, scriptedModel(() => say("")).layer)))
  })
})

describe("note history", () => {
  it.live("keeps what a bot wrote and replaced in its own project, and restores an old version", () => {
    const memory = fakeMemory({ "weaver/plans": "- [fact] Launch in May" })
    const model = scriptedModel((call) =>
      call.index === 0
        ? callTool("edit_note", { identifier: "weaver/plans", operation: "append", content: "- [fact] Launch moved to June" })
        : say("Updated.")
    )
    return Effect.gen(function*() {
      yield* (yield* ProviderRegistry).update("deepseek", { apiKey: "sk-test" })
      const bot = yield* (yield* BotRepo).create({ name: "Ada", tools: ["memory"], approvalMode: "auto", memoryProject: "Work" })
      const conversation = yield* createConversation([bot.id])
      yield* sendAndWait(conversation.id, "Launch moved to June")
      expect(memory.calls.find((call) => call.name === "edit_note")?.args.project).toBe("Work")

      const knowledge = yield* KnowledgeBase
      const history = yield* eventually(knowledge.history("Work", "weaver/plans"), (h) => h.versions.length === 2)
      expect(history).toMatchObject({ project: "Work", permalink: "weaver/plans" })
      expect(history.versions.map((version) => version.source)).toEqual(["Ada", ""])
      const [edited, original] = history.versions
      expect((yield* knowledge.version(original!.id)).content).toBe("- [fact] Launch in May")

      const restored = yield* knowledge.restore(original!.id, "You")
      expect(restored).toMatchObject({ source: "You", restoredFrom: original!.id, checksum: original!.checksum })
      expect(memory.notes.get("weaver/plans")).toBe("- [fact] Launch in May")
      const after = yield* knowledge.history("Work", "weaver/plans")
      expect(after.versions.map((version) => version.id)).toEqual([restored.id, edited!.id, original!.id])
      // Restoring what's already there changes nothing.
      expect((yield* knowledge.restore(restored.id, "You")).id).toBe(restored.id)
    }).pipe(Effect.provide(services(memory, model.layer)))
  })

  it.effect("notices notes changed outside Weaver", () => {
    const memory = fakeMemory({ "weaver/a": "one", "weaver/b": "two" })
    return Effect.gen(function*() {
      const knowledge = yield* KnowledgeBase
      expect(yield* knowledge.sweep("")).toBe(2)
      expect(yield* knowledge.sweep("")).toBe(0)
      memory.editOutside("weaver/b", "two, edited in Obsidian")
      expect(yield* knowledge.sweep("")).toBe(1)
      const history = yield* knowledge.history("", "weaver/b")
      expect(history.versions.map((version) => version.source)).toEqual(["", ""])
      expect(history.versions[0]!.size).toBe("two, edited in Obsidian".length)
      expect(yield* Effect.flip(knowledge.history("", "weaver/missing"))).toMatchObject({ _tag: "MemoryNoteNotFound" })
    }).pipe(Effect.provide(services(memory, scriptedModel(() => say("")).layer)))
  })
})

describe("memory projects", () => {
  it.effect("lists which bots use each project, creates projects beside the default one and guards removal", () => {
    const memory = fakeMemory({ "weaver/a": "one" })
    return Effect.gen(function*() {
      const bots = yield* BotRepo
      const ada = yield* bots.create({ name: "Ada", tools: ["memory"] })
      yield* bots.create({ name: "Offline", tools: [] })
      const knowledge = yield* KnowledgeBase

      const created = yield* knowledge.createProject("  Moby Dick ")
      expect(created).toMatchObject({ name: "Moby Dick", path: "/home/weaver/basic-memory-projects/moby-dick", notes: 0 })
      expect(yield* Effect.flip(knowledge.createProject("moby dick"))).toMatchObject({ _tag: "Conflict" })
      expect(yield* Effect.flip(knowledge.createProject("!!!"))).toMatchObject({ _tag: "BadRequest" })

      const scott = yield* bots.create({ name: "Scott", tools: ["memory"], memoryProject: "Moby Dick" })
      const listed = yield* knowledge.projects
      expect(listed.shared).toBe("main")
      expect(listed.projects.map((project) => [project.name, project.isShared, project.botIds])).toEqual([
        ["main", true, [ada.id]],
        ["Moby Dick", false, [scott.id]]
      ])
      expect(listed.projects[0]!.notes).toBe(1)

      expect(yield* Effect.flip(knowledge.removeProject("main"))).toMatchObject({ _tag: "BadRequest" })
      expect(yield* Effect.flip(knowledge.removeProject("Moby Dick"))).toMatchObject({ _tag: "BadRequest" })
      expect(yield* Effect.flip(knowledge.removeProject("Nope"))).toMatchObject({ _tag: "MemoryProjectNotFound" })
      yield* bots.update(scott.id, { memoryProject: "" })
      yield* knowledge.removeProject("Moby Dick")
      expect(memory.projects.map((project) => project.name)).toEqual(["main"])
    }).pipe(Effect.provide(services(memory, scriptedModel(() => say("")).layer)))
  })

  it.effect("reads each project's Core Memory for the bots in it", () => {
    const memory = fakeMemory({ "weaver/core-memory": "- [fact] Shared fact" })
    return Effect.gen(function*() {
      const bots = yield* BotRepo
      const toolbox = yield* Toolbox
      const shared = yield* toolbox.forBot(yield* bots.create({ name: "Ada", tools: ["memory"] }))
      expect(shared).toMatchObject({ memoryEnabled: true, memoryProject: undefined, coreMemory: "- [fact] Shared fact" })
      const own = yield* toolbox.forBot(yield* bots.create({ name: "Scott", tools: ["memory"], memoryProject: "Moby Dick" }))
      expect(own.memoryProject).toBe("Moby Dick")
      expect(memory.calls.filter((call) => call.name === "read_note").map((call) => call.args.project)).toEqual([undefined, "Moby Dick"])
    }).pipe(Effect.provide(services(memory, scriptedModel(() => say("")).layer)))
  })
})

describe("the memory API", () => {
  let dispose: (() => Promise<void>) | undefined
  afterEach(async () => {
    await dispose?.()
    dispose = undefined
  })

  it("serves projects, the graph and history, and saves the Mac's own edits", async () => {
    const memory = fakeMemory({ "weaver/core-memory": "- [fact] One" })
    const web = HttpRouter.toWebHandler(
      AppRoutes.pipe(
        Layer.provide(services(memory, scriptedModel(() => say("")).layer)),
        Layer.provide(BunHttpServer.layerHttpServices)
      ),
      { disableLogger: true }
    )
    dispose = web.dispose
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await web.handler(new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: "Bearer test-token", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }))
      const text = await response.text()
      return { status: response.status, json: text.length > 0 ? JSON.parse(text) : undefined }
    }

    expect((await request("GET", "/v1/health")).json).toMatchObject({ memoryApi: true })
    expect((await request("GET", "/v1/memory/projects")).json).toMatchObject({ shared: "main", projects: [{ name: "main" }] })
    expect((await request("POST", "/v1/memory/projects", { name: "Research" })).status).toBe(200)
    expect((await request("DELETE", "/v1/memory/projects/Research")).status).toBe(204)
    expect((await request("GET", "/v1/memory/graph?refresh=1")).json).toMatchObject({ project: "main", notes: 1, observations: 1 })

    expect((await request("POST", "/v1/memory/capture", { identifier: "weaver/core-memory" })).status).toBe(204)
    memory.editOutside("weaver/core-memory", "- [fact] One\n- [fact] Two")
    expect((await request("POST", "/v1/memory/capture", { identifier: "weaver/core-memory", source: "You" })).status).toBe(204)
    const history = (await request("GET", "/v1/memory/history?identifier=weaver%2Fcore-memory")).json
    expect(history.versions.map((version: { source: string }) => version.source)).toEqual(["You", "You"])
    const oldest = history.versions[1].id
    expect((await request("GET", `/v1/memory/versions/${oldest}`)).json.content).toBe("- [fact] One")
    expect((await request("POST", `/v1/memory/versions/${oldest}/restore`, {})).json).toMatchObject({ restoredFrom: oldest })
    expect(memory.notes.get("weaver/core-memory")).toBe("- [fact] One")
    expect((await request("GET", "/v1/memory/versions/nope")).status).toBe(404)
    expect((await request("GET", "/v1/memory/history?identifier=missing")).status).toBe(404)
  })
})
