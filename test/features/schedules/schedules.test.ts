import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { messageText } from "../../../src/features/conversations/Conversation.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { AgentRunner } from "../../../src/features/runs/AgentRunner.ts"
import { describeEvery } from "../../../src/features/schedules/Schedule.ts"
import { Scheduler } from "../../../src/features/schedules/Scheduler.ts"
import { ScheduleRepo } from "../../../src/features/schedules/ScheduleRepo.ts"
import {
  callTool,
  collectUntil,
  createBot,
  createConversation,
  say,
  scriptedModel,
  send,
  sendAndWait,
  testLayer,
  withProviderKey
} from "../../support/layers.ts"
import { bot, type Client, makeClient, waitFor } from "../teams/support.ts"

const scrape = { title: "Remote jobs", prompt: "Find new remote iOS jobs and list them.", every_minutes: 300 }

describe("scheduled tasks", () => {
  it.live("a bot schedules a task, and the scheduler runs it in the chat when it's due", () => {
    const model = scriptedModel((call) => {
      if (call.index === 0) return callTool("schedule_task", scrape)
      if (call.index === 1) return say("Done, every 5 hours.")
      if (call.index === 2) return callTool("schedule_task", { ...scrape, every_minutes: 5 })
      return say("Here are 3 jobs.")
    })
    return Effect.gen(function*() {
      yield* withProviderKey
      const ada = yield* createBot({ name: "Ada" })
      const conversation = yield* createConversation([ada.id])
      const schedules = yield* ScheduleRepo
      const conversations = yield* ConversationRepo

      const before = Date.now()
      yield* sendAndWait(conversation.id, "scrape me remote jobs every 5 hours")
      expect(model.calls[0]!.tools).toEqual(expect.arrayContaining(["schedule_task", "scheduled_tasks"]))
      const [created] = yield* schedules.list(conversation.id)
      expect(created).toMatchObject({ botId: ada.id, title: "Remote jobs", everyMinutes: 300, lastRunAt: null })
      const firstRun = Date.parse(created!.nextRunAt) - before
      expect(firstRun).toBeGreaterThanOrEqual(300 * 60_000)
      expect(firstRun).toBeLessThan(301 * 60_000)

      // Nothing is due yet.
      const scheduler = yield* Scheduler
      expect(yield* scheduler.tick).toBe(0)

      yield* schedules.reschedule(created!.id, new Date(Date.now() - 1000).toISOString())
      const run = yield* collectUntil(conversation.id, (event) => event.type === "run-finished")
      expect(yield* scheduler.tick).toBe(1)
      const events = yield* Fiber.join(run)
      expect(events.map((event) => event.type)).toContain("schedules-changed")

      const messages = yield* conversations.messages(conversation.id)
      const posted = messages.at(-2)!
      expect(posted.role).toBe("user")
      expect(messageText(posted.parts)).toContain(scrape.prompt)
      // The scheduled run tried to schedule again with too short an interval and was refused.
      const reply = messages.at(-1)!
      expect(JSON.stringify(reply.parts)).toContain("every_minutes must be between 15")
      expect(messageText(reply.parts)).toBe("Here are 3 jobs.")

      const [ran] = yield* schedules.list(conversation.id)
      expect(ran!.lastRunAt).not.toBeNull()
      expect(Date.parse(ran!.nextRunAt) - Date.parse(ran!.lastRunAt!)).toBe(300 * 60_000)
      expect(yield* scheduler.tick).toBe(0)
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it.live("waits while the conversation is busy instead of interrupting it", () => {
    const model = scriptedModel(() => callTool("write_file", { path: "a.txt", content: "a" }))
    return Effect.gen(function*() {
      yield* withProviderKey
      // Asks before writing, so the run stays busy waiting for approval.
      const ada = yield* createBot({ name: "Ada", tools: ["files"], approvalMode: "ask" })
      const conversation = yield* createConversation([ada.id])
      const schedules = yield* ScheduleRepo
      const runner = yield* AgentRunner
      const scheduler = yield* Scheduler
      const conversations = yield* ConversationRepo
      const schedule = yield* schedules.create({
        conversationId: conversation.id,
        botId: ada.id,
        title: "Check",
        prompt: "Check things.",
        everyMinutes: 60,
        nextRunAt: new Date(Date.now() - 1000).toISOString()
      })

      const asked = yield* collectUntil(conversation.id, (event) => event.type === "approval-requested")
      yield* send(conversation.id, "write a file")
      yield* Fiber.join(asked)
      const count = (yield* conversations.messages(conversation.id)).length

      const now = Date.now()
      expect(yield* scheduler.tick).toBe(0)
      const [waiting] = yield* schedules.list(conversation.id)
      expect(waiting!.lastRunAt).toBeNull()
      expect(Date.parse(waiting!.nextRunAt) - now).toBeGreaterThanOrEqual(59_000)
      expect((yield* conversations.messages(conversation.id)).length).toBe(count)
      expect(yield* runner.isRunning(conversation.id)).toBe(true)
      yield* runner.cancelConversation(conversation.id)
      expect(schedule.id).toBe(waiting!.id)
    }).pipe(Effect.provide(testLayer(model.layer)))
  })

  it("describes intervals", () => {
    expect(describeEvery(300)).toBe("every 5 hours")
    expect(describeEvery(60)).toBe("every hour")
    expect(describeEvery(1440)).toBe("every day")
    expect(describeEvery(90)).toBe("every 90 minutes")
  })
})

describe("the schedules API", () => {
  let client: Client | undefined
  afterEach(async () => {
    await client?.dispose()
    client = undefined
  })

  it("lists a conversation's schedules, cancels them, and drops them with the bot", async () => {
    client = await makeClient((call) => (call.index % 2 === 0 ? callTool("schedule_task", scrape) : say("Scheduled.")))
    const { request } = client
    expect((await request("GET", "/v1/health")).json).toMatchObject({ schedules: true })
    await request("PUT", "/v1/providers/deepseek", { apiKey: "sk-test" })
    const ada = await bot(client, "Ada")
    const chat = (await request("POST", "/v1/conversations", { botIds: [ada.id] })).json
    const list = async () => (await request("GET", `/v1/schedules?conversationId=${chat.id}`)).json as Array<{ id: string }>

    await request("POST", `/v1/conversations/${chat.id}/messages`, { text: "scrape remote jobs every 5 hours" })
    const [first] = await waitFor(async () => {
      const found = await list()
      return found.length === 1 ? found : undefined
    })
    expect(first).toMatchObject({ conversationId: chat.id, title: "Remote jobs", everyMinutes: 300 })
    await waitFor(() => client!.events.some((event) => event.type === "schedules-changed"))

    expect((await request("DELETE", `/v1/schedules/${first!.id}`)).status).toBe(204)
    expect(await list()).toEqual([])
    expect((await request("DELETE", `/v1/schedules/${first!.id}`)).status).toBe(404)

    await waitFor(async () =>
      (await request("GET", `/v1/conversations/${chat.id}/messages`)).json.at(-1)?.status === "done" || undefined
    )
    await request("POST", `/v1/conversations/${chat.id}/messages`, { text: "again" })
    await waitFor(async () => ((await list()).length === 1 ? true : undefined))
    expect((await request("DELETE", `/v1/bots/${ada.id}`)).status).toBe(204)
    expect((await request("GET", "/v1/schedules")).json).toEqual([])
  })
})
