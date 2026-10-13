import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { BotRepo } from "../../../src/features/bots/BotRepo.ts"
import type { Bot } from "../../../src/features/bots/Bot.ts"
import type { ConversationKind } from "../../../src/features/conversations/Conversation.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { LibraryStore } from "../../../src/features/learning/library/LibraryStore.ts"
import { SkillHttp } from "../../../src/features/learning/library/SkillSources.ts"
import { Approvals } from "../../../src/features/runs/Approvals.ts"
import { Toolbox } from "../../../src/features/runs/Toolbox.ts"
import { TeamRepo } from "../../../src/features/teams/TeamRepo.ts"
import { runTool } from "../../../src/tools/AgentTool.ts"
import { avatarFor, findSkillsToolName, proposeTeamToolName } from "../../../src/tools/builtin/TeamBuilder.ts"
import {
  callTool,
  collectUntil,
  createBot,
  createConversation,
  type Script,
  say,
  scriptedModel,
  send,
  tempDir,
  testLayer,
  withProviderKey
} from "../../support/layers.ts"
import { fakeHttp, publicLookup } from "../../support/skillFixtures.ts"

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo it well.\n`

const catalogRepos = {
  "acme/skills": {
    HEAD: {
      "skills/brand-guidelines/SKILL.md": skillMd("brand-guidelines", "Use when applying a brand's colors, type and voice."),
      "skills/pdf/SKILL.md": skillMd("pdf", "Use when filling PDF forms.")
    }
  }
}

const layerWith = (script: Script) => {
  const model = scriptedModel(script)
  const http = fakeHttp({ repos: catalogRepos })
  const layer = testLayer(model.layer, tempDir(), { skillCatalog: ["acme/skills/skills"] }).pipe(
    Layer.provide(Layer.succeed(SkillHttp, { fetch: http.fetch, lookup: publicLookup, githubApi: "https://api.github.com" }))
  )
  return { model, layer }
}

/** A library skill for copywriting, alongside the catalog's brand-guidelines and pdf. */
const withLibrarySkill = Effect.gen(function*() {
  const library = yield* LibraryStore
  yield* library.create({ name: "copywriting", content: skillMd("copywriting", "Use when writing marketing copy for a brand.") })
})

const toolsFor = (bot: Bot, conversationKind?: ConversationKind) =>
  Effect.gen(function*() {
    return (yield* (yield* Toolbox).forBot(bot, { conversationKind })).tools
  })

const toolFor = (bot: Bot, name: string) =>
  Effect.gen(function*() {
    const tool = (yield* toolsFor(bot, "chat")).find((candidate) => candidate.name === name)
    if (tool === undefined) throw new Error(`${name} isn't offered`)
    return tool
  })

const proposal = {
  name: "Brand Studio",
  purpose: "Build and grow the person's brand",
  manager: "Iris",
  bots: [
    {
      name: "Iris",
      role: "Brand designer",
      label: "Logos, palettes, visual identity",
      instructions: "You are Iris, a brand designer.",
      tools: ["web", "files", "browser"],
      skills: ["brand-guidelines", "unknown-skill"]
    },
    { name: "Kai", role: "Copywriter", instructions: "You are Kai, a copywriter.", skills: ["copywriting"], label: null }
  ]
}

describe("find_skills", () => {
  it.live("searches the library first, then the catalog", () => {
    const { layer } = layerWith(() => say("Hi"))
    return Effect.gen(function*() {
      yield* withLibrarySkill
      const atlas = yield* createBot({ name: "Atlas" })
      const findSkills = yield* toolFor(atlas, findSkillsToolName)
      expect(findSkills.needsApproval).toBe(false)

      const brand = yield* runTool(findSkills, { query: "brand copy" })
      const lines = brand.split("\n").filter((line) => line.startsWith("- "))
      expect(lines).toEqual([
        "- copywriting — Use when writing marketing copy for a brand. (in your library)",
        "- brand-guidelines — Use when applying a brand's colors, type and voice. (from the catalog: acme/skills)"
      ])

      const all = yield* runTool(findSkills, { query: "" })
      expect(all).toContain("- pdf — Use when filling PDF forms. (from the catalog: acme/skills)")
      expect(yield* runTool(findSkills, { query: "quantum" })).toContain("No skills match \"quantum\".")
    }).pipe(Effect.provide(layer))
  })

  it.live("comes with replies in conversations; propose_team only in chats and team private chats", () => {
    const { layer } = layerWith(() => say("Hi"))
    return Effect.gen(function*() {
      const atlas = yield* createBot({ name: "Atlas" })
      const names = (kind?: ConversationKind) => Effect.map(toolsFor(atlas, kind), (tools) => tools.map((tool) => tool.name))
      expect(yield* names()).toEqual([])
      expect(yield* names("chat")).toEqual([findSkillsToolName, proposeTeamToolName])
      expect(yield* names("team-private")).toEqual([findSkillsToolName, proposeTeamToolName])
      expect(yield* names("team-room")).toEqual([findSkillsToolName])
      expect(yield* names("handoff")).toEqual([findSkillsToolName])
    }).pipe(Effect.provide(layer))
  })
})

describe("propose_team", () => {
  it.live("always asks for approval, even for a bot that runs things without asking", () => {
    const { layer } = layerWith(() => say("Hi"))
    return Effect.gen(function*() {
      const atlas = yield* createBot({ name: "Atlas", approvalMode: "auto" })
      const tool = yield* toolFor(atlas, proposeTeamToolName)
      expect(tool.needsApproval).toBe(true)
      expect(tool.title(proposal)).toBe("Create team \"Brand Studio\" with 2 bots")
    }).pipe(Effect.provide(layer))
  })

  it.live("lists everything wrong with a proposal, before asking", () => {
    const { layer } = layerWith(() => say("Hi"))
    return Effect.gen(function*() {
      const atlas = yield* createBot({ name: "Atlas" })
      yield* createBot({ name: "Nova" })
      const teams = yield* TeamRepo
      const conversations = yield* ConversationRepo
      const room = yield* conversations.create({ title: "", botIds: [atlas.id] })
      yield* teams.create("taken", {
        name: "Taken",
        purpose: "",
        managerBotId: atlas.id,
        members: [],
        parentTeamId: null,
        roomConversationId: room.id,
        privateConversationId: null
      })
      const tool = yield* toolFor(atlas, proposeTeamToolName)
      const failure = (params: unknown) => Effect.flip(tool.validate!(params)).pipe(Effect.map((error) => error.message))

      const bad = yield* failure({
        name: "taken",
        purpose: "",
        manager: "Zed",
        bots: [
          { name: "nova", role: "Writer", instructions: "Write." },
          { name: "Iris", role: "", instructions: "  ", tools: ["web", "teleport"] },
          { name: "iris", role: "Designer", instructions: "Design.", skills: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }
        ]
      })
      expect(bad).toContain("There's already a team called Taken")
      expect(bad).toContain("Give the team a purpose of 1 to 300 characters.")
      expect(bad).toContain("There's already a bot called Nova")
      expect(bad).toContain("Give Iris a role of 1 to 60 characters.")
      expect(bad).toContain("Give Iris instructions")
      expect(bad).toContain("Unknown tool for Iris: teleport.")
      expect(bad).toContain("iris is listed twice")
      expect(bad).toContain("iris has 9 skills")
      expect(bad).toContain("The manager has to be \"me\" or one of the new bots (nova, Iris, iris), not Zed.")
      expect(bad).toContain("Fix them and call propose_team again.")

      const crowded = yield* failure({
        ...proposal,
        bots: Array.from({ length: 7 }, (_, index) => ({ name: `Bot${index}`, role: "Helper", instructions: "Help." }))
      })
      expect(crowded).toContain("at most 6 new bots, not 7")
      expect(yield* failure({ ...proposal, bots: [] })).toContain("Propose at least one new bot.")
      expect(yield* failure({ name: "X" })).toContain("Invalid arguments")
    }).pipe(Effect.provide(layer))
  })

  it.live("on approval installs catalog skills, creates the bots and the team they're on", () => {
    const { layer, model } = layerWith((call) =>
      call.index === 0 ? callTool(proposeTeamToolName, proposal) : say("Your team is ready.")
    )
    return Effect.gen(function*() {
      yield* withProviderKey
      yield* withLibrarySkill
      const atlas = yield* createBot({ name: "Atlas", approvalMode: "auto" })
      const conversation = yield* createConversation([atlas.id])
      const finished = yield* collectUntil(conversation.id, (event) => event.type === "run-finished")
      const requested = yield* collectUntil(conversation.id, (event) => event.type === "approval-requested")
      yield* send(conversation.id, "I need a mini team for my own brand")

      const request = (yield* Fiber.join(requested)).at(-1)!
      if (request.type !== "approval-requested") throw new Error("expected an approval request")
      expect(request.part).toMatchObject({ name: proposeTeamToolName, title: "Create team \"Brand Studio\" with 2 bots", params: proposal })
      // Nothing exists before the person approves.
      expect((yield* (yield* BotRepo).list).map((bot) => bot.name)).toEqual(["Atlas"])
      yield* (yield* Approvals).resolve(request.approvalId, true)
      const events = yield* Fiber.join(finished)

      const result = events.find((event) => event.type === "tool-result")
      if (result?.type !== "tool-result") throw new Error("expected a tool result")
      expect(result.part.isFailure).toBe(false)
      expect(result.part.output).toBe(
        "Created team \"Brand Studio\" (manager: Iris) with Kai (Copywriter). Installed skills: brand-guidelines. " +
          "Skipped: unknown-skill (not found)."
      )
      expect(model.calls[0]!.tools).toEqual(expect.arrayContaining([findSkillsToolName, proposeTeamToolName]))
      expect(model.calls[0]!.prompt).toContain("look up suitable skills with find_skills")

      const bots = yield* (yield* BotRepo).list
      const iris = bots.find((bot) => bot.name === "Iris")!
      const kai = bots.find((bot) => bot.name === "Kai")!
      expect(iris).toMatchObject({
        label: "Logos, palettes, visual identity",
        systemPrompt: "You are Iris, a brand designer.",
        providerId: "",
        model: "",
        approvalMode: "ask",
        tools: ["web", "files", "browser"],
        librarySkills: ["brand-guidelines"],
        ...avatarFor(0)
      })
      expect(iris.symbol).toBe("blob.circle")
      expect(kai).toMatchObject({ label: "", tools: ["files", "web", "skills"], librarySkills: ["copywriting"], ...avatarFor(1) })
      expect(kai.colorHex).toBe("#8B5CF6")

      const library = yield* LibraryStore
      expect((yield* library.summary("brand-guidelines")).source).toMatchObject({ kind: "catalog" })

      const [team] = yield* (yield* TeamRepo).list
      expect(team).toMatchObject({
        name: "Brand Studio",
        purpose: "Build and grow the person's brand",
        managerBotId: iris.id,
        members: [{ botId: kai.id, role: "Copywriter" }]
      })
      const conversations = yield* ConversationRepo
      expect((yield* conversations.get(team!.roomConversationId)).botIds).toEqual(expect.arrayContaining([iris.id, kai.id]))
      expect((yield* conversations.get(team!.privateConversationId!)).botIds).toEqual([iris.id])
      expect(events.some((event) => event.type === "approval-resolved" && event.approved)).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.live("with manager \"me\", the proposing bot leads every new bot", () => {
    const { layer } = layerWith(() => say("Hi"))
    return Effect.gen(function*() {
      const atlas = yield* createBot({ name: "Atlas", tools: ["shell"] })
      const tool = yield* toolFor(atlas, proposeTeamToolName)
      const output = yield* runTool(tool, { ...proposal, manager: "me", bots: proposal.bots.map((bot) => ({ ...bot, skills: [] })) })
      expect(output).toBe("Created team \"Brand Studio\" (manager: Atlas) with Iris (Brand designer), Kai (Copywriter).")

      const bots = yield* (yield* BotRepo).list
      const [team] = yield* (yield* TeamRepo).list
      expect(team!.managerBotId).toBe(atlas.id)
      expect(team!.members.map((member) => bots.find((bot) => bot.id === member.botId)?.name)).toEqual(["Iris", "Kai"])
      // The proposer keeps its own settings.
      expect(bots.find((bot) => bot.id === atlas.id)).toMatchObject({ tools: ["shell"], approvalMode: "auto" })
    }).pipe(Effect.provide(layer))
  })

  it.live("an invalid proposal fails without asking the person", () => {
    const { layer } = layerWith((call) =>
      call.index === 0 ? callTool(proposeTeamToolName, { ...proposal, manager: "Zed" }) : say("Let me fix that.")
    )
    return Effect.gen(function*() {
      yield* withProviderKey
      const atlas = yield* createBot({ name: "Atlas" })
      const conversation = yield* createConversation([atlas.id])
      const finished = yield* collectUntil(conversation.id, (event) => event.type === "run-finished")
      yield* send(conversation.id, "Make me a team")
      const events = yield* Fiber.join(finished)

      expect(events.some((event) => event.type === "approval-requested")).toBe(false)
      const result = events.find((event) => event.type === "tool-result")
      if (result?.type !== "tool-result") throw new Error("expected a tool result")
      expect(result.part.isFailure).toBe(true)
      expect(result.part.output).toContain("The manager has to be \"me\"")
      expect(yield* (yield* TeamRepo).list).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})
