import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber } from "effect"
import { messageText } from "../../../src/features/conversations/Conversation.ts"
import { ConversationRepo } from "../../../src/features/conversations/ConversationRepo.ts"
import { SelfReview } from "../../../src/features/learning/review/SelfReview.ts"
import { SkillStore } from "../../../src/features/learning/skills/SkillStore.ts"
import { Approvals } from "../../../src/features/runs/Approvals.ts"
import type { RunEvent } from "../../../src/features/runs/Events.ts"
import { type ChatMessage, type MockReply, type RecordedRequest, startOpenAiMock } from "../../support/fixtures/openAiMock.ts"
import { collectUntil, createBot, createConversation, send, sendAndWait } from "../../support/layers.ts"
import { realModelLayer, useEndpoint } from "../../support/realModel.ts"

const mock = startOpenAiMock()
afterAll(() => mock.close())
beforeEach(() => {
  mock.requests.length = 0
})

const script = (...turns: ReadonlyArray<MockReply | ((request: RecordedRequest) => MockReply)>) =>
  mock.setScript((request) => {
    const turn = turns[Math.min(request.index, turns.length - 1)]!
    return typeof turn === "function" ? turn(request) : turn
  })

const setup = (tools: ReadonlyArray<"files" | "shell" | "skills"> = ["files"], approvalMode: "auto" | "ask" = "auto") =>
  Effect.gen(function*() {
    yield* useEndpoint(mock.url, "mock-model")
    const bot = yield* createBot({ name: "Ada", tools: [...tools], approvalMode })
    const conversation = yield* createConversation([bot.id])
    return { bot, conversation }
  })

const lastMessage = (conversationId: string) =>
  Effect.gen(function*() {
    const messages = yield* (yield* ConversationRepo).messages(conversationId)
    return messages.at(-1)!
  })

const turnMessages = (request: RecordedRequest): ReadonlyArray<ChatMessage> => request.body.messages.slice(1)

describe("OpenAI-compatible provider", () => {
  it.live("streams a plain reply and records usage, model and key", () =>
    Effect.gen(function*() {
      script({ text: "Hello there, how can I help?", usage: { prompt: 42, completion: 9 } })
      const { conversation } = yield* setup([])
      const events = yield* sendAndWait(conversation.id, "Hi")

      const message = yield* lastMessage(conversation.id)
      expect(message).toMatchObject({ status: "done", providerId: "custom", model: "mock-model", promptTokens: 42, completionTokens: 9 })
      expect(messageText(message.parts)).toBe("Hello there, how can I help?")
      expect(events.filter((event) => event.type === "text-delta").length).toBeGreaterThan(1)

      const [request] = mock.requests
      expect(request!.headers.authorization).toBe("Bearer sk-mock")
      expect(request!.body).toMatchObject({ model: "mock-model", stream: true, stream_options: { include_usage: true } })
      // A bot without tools still gets the team-building and scheduling ones.
      expect(request!.body.tools?.map((tool) => tool.function.name)).toEqual(["find_skills", "propose_team", "schedule_task", "scheduled_tasks"])
      expect(request!.body.messages[0]!.role).toBe("system")
      expect(turnMessages(request!)).toEqual([{ role: "user", content: "Hi" }])
    }).pipe(Effect.provide(realModelLayer())))

  it.live("runs a multi-step tool loop and replays each step faithfully", () =>
    Effect.gen(function*() {
      script(
        { text: "I'll save that first.", toolCalls: [{ id: "call_write", name: "write_file", arguments: { path: "notes.txt", content: "hello" } }] },
        { toolCalls: [{ id: "call_read", name: "read_file", arguments: { path: "notes.txt" } }] },
        { text: "Saved and checked: it says hello." }
      )
      const { conversation } = yield* setup()
      yield* sendAndWait(conversation.id, "Write hello to notes.txt and check it")

      expect(mock.requests).toHaveLength(3)
      const tools = mock.requests[0]!.body.tools!
      expect(tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["read_file", "write_file", "list_files"]))
      expect(tools.every((tool) => tool.type === "function" && tool.function.strict === undefined)).toBe(true)
      expect(tools.find((tool) => tool.function.name === "write_file")!.function.parameters).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["path", "content"])
      })

      const second = turnMessages(mock.requests[1]!)
      expect(second).toHaveLength(3)
      expect(second[1]).toEqual({
        role: "assistant",
        content: "I'll save that first.",
        tool_calls: [{
          id: "call_write",
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: "notes.txt", content: "hello" }) }
        }]
      })
      expect(second[2]).toMatchObject({ role: "tool", tool_call_id: "call_write" })

      const third = turnMessages(mock.requests[2]!)
      expect(third.slice(1).map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "tool"])
      expect(third[3]).toMatchObject({ role: "assistant", content: null, tool_calls: [{ id: "call_read" }] })
      expect(third[4]).toMatchObject({ role: "tool", tool_call_id: "call_read", content: expect.stringContaining("hello") })

      const message = yield* lastMessage(conversation.id)
      expect(message.status).toBe("done")
      expect(message.parts.map((part) => part.type)).toEqual(["text", "tool-call", "tool-result", "tool-call", "tool-result", "text"])
      expect(message.parts.filter((part) => part.type === "tool-result").every((part) => !part.isFailure)).toBe(true)
      expect(message.promptTokens).toBe(33)
      expect(message.completionTokens).toBe(21)

      // The next reply sees the earlier one's text, including what came before its tool calls.
      script({ text: "Anything else?" })
      mock.requests.length = 0
      yield* sendAndWait(conversation.id, "Thanks")
      const history = turnMessages(mock.requests[0]!)
      expect(history[1]).toEqual({ role: "assistant", content: "I'll save that first.\n\nSaved and checked: it says hello." })
    }).pipe(Effect.provide(realModelLayer())))

  it.live("answers parallel tool calls in one assistant turn, in order", () =>
    Effect.gen(function*() {
      script(
        {
          toolCalls: [
            { id: "call_a", name: "list_files", arguments: {} },
            { id: "call_b", name: "write_file", arguments: { path: "b.txt", content: "bee" } },
            { id: "call_c", name: "read_file", arguments: { path: "missing.txt" } }
          ]
        },
        { text: "Done." }
      )
      const { conversation } = yield* setup()
      yield* sendAndWait(conversation.id, "Do three things")

      const second = turnMessages(mock.requests[1]!)
      expect(second[1]!.tool_calls!.map((call) => call.id)).toEqual(["call_a", "call_b", "call_c"])
      expect(second.slice(2).map((m) => [m.role, m.tool_call_id])).toEqual([["tool", "call_a"], ["tool", "call_b"], ["tool", "call_c"]])
      const message = yield* lastMessage(conversation.id)
      const results = message.parts.flatMap((part) => (part.type === "tool-result" ? [[part.id, part.isFailure]] : []))
      expect(results).toEqual([["call_a", false], ["call_b", false], ["call_c", true]])
    }).pipe(Effect.provide(realModelLayer())))

  it.live("pauses for approval and resumes with the result", () =>
    Effect.gen(function*() {
      script(
        { text: "Writing it now.", toolCalls: [{ id: "call_w", name: "write_file", arguments: { path: "a.txt", content: "x" } }] },
        { text: "Written." }
      )
      const { conversation } = yield* setup(["files"], "ask")
      const finished = yield* collectUntil(conversation.id, (event) => event.type === "run-finished")
      const requested = yield* collectUntil(conversation.id, (event) => event.type === "approval-requested")
      yield* send(conversation.id, "Write a.txt")

      const request = (yield* Fiber.join(requested)).at(-1)!
      if (request.type !== "approval-requested") throw new Error("expected an approval request")
      expect(mock.requests).toHaveLength(1)
      expect(yield* (yield* Approvals).resolve(request.approvalId, true)).toBe(true)
      yield* Fiber.join(finished)

      expect(mock.requests).toHaveLength(2)
      expect(turnMessages(mock.requests[1]!)[2]).toMatchObject({ role: "tool", tool_call_id: "call_w" })
      const message = yield* lastMessage(conversation.id)
      expect(message.parts[1]).toMatchObject({ type: "tool-call", approval: "approved" })
      expect(messageText(message.parts)).toBe("Writing it now.\n\nWritten.")
    }).pipe(Effect.provide(realModelLayer())))

  it.live("retries without tools when the model doesn't support them", () =>
    Effect.gen(function*() {
      script(
        (request) =>
          request.body.tools !== undefined
            ? { status: 400, message: "registry.ollama.ai/library/llama3:latest does not support tools", type: "api_error" }
            : { text: "I can't use tools, but hi!" }
      )
      const { conversation } = yield* setup()
      yield* sendAndWait(conversation.id, "List your files")
      expect(mock.requests.map((request) => request.body.tools === undefined)).toEqual([false, true])
      const message = yield* lastMessage(conversation.id)
      expect(message.status).toBe("done")
      expect(messageText(message.parts)).toBe("I can't use tools, but hi!")
    }).pipe(Effect.provide(realModelLayer())))

  it.live("doesn't drop the tools for other bad requests", () =>
    Effect.gen(function*() {
      script({ status: 400, message: "This model's maximum context length is 8192 tokens, in the messages and functions." })
      const { conversation } = yield* setup()
      yield* sendAndWait(conversation.id, "Hi")
      expect(mock.requests).toHaveLength(1)
      const message = yield* lastMessage(conversation.id)
      expect(message.status).toBe("error")
      expect(message.error).toBe(
        "The model provider rejected the request (HTTP 400): This model's maximum context length is 8192 tokens, in the messages and functions."
      )
    }).pipe(Effect.provide(realModelLayer())))

  it.live("reports provider errors as readable messages", () =>
    Effect.gen(function*() {
      const { conversation } = yield* setup([])
      const errorFor = (reply: MockReply) =>
        Effect.gen(function*() {
          script(reply)
          mock.requests.length = 0
          const events = yield* sendAndWait(conversation.id, "Hi")
          const error = events.find((event): event is Extract<RunEvent, { type: "error" }> => event.type === "error")
          const message = yield* lastMessage(conversation.id)
          expect(message.status).toBe("error")
          expect(error?.message).toBe(message.error)
          return message.error
        })

      expect(yield* errorFor({ status: 401, message: "Incorrect API key provided: sk-mock." })).toBe(
        "The model provider rejected the API key (HTTP 401): Incorrect API key provided: sk-mock. Check it in Settings > Models."
      )
      expect(mock.requests).toHaveLength(1)
      expect(yield* errorFor({ status: 402, message: "Insufficient Balance", type: "insufficient_quota" })).toBe(
        "The model provider account is out of credits or quota (HTTP 402): Insufficient Balance."
      )
      const limited = yield* errorFor({ status: 429, message: "Slow down", headers: { "retry-after": "0" } })
      expect(limited).toBe("The model provider is rate limiting requests (HTTP 429): Slow down. Try again in a moment.")
      expect(mock.requests).toHaveLength(3)
      expect(yield* errorFor({ status: 429, message: "Slow down", headers: { "retry-after": "3600" } })).toBe(
        "The model provider is rate limiting requests (HTTP 429): Slow down. Try again in 1h."
      )
      expect(mock.requests).toHaveLength(1)
    }).pipe(Effect.provide(realModelLayer())))

  it.live("retries a server error that happens before anything streamed", () =>
    Effect.gen(function*() {
      script({ status: 503, message: "Overloaded", type: "server_error" }, { text: "Back now." })
      const { conversation } = yield* setup([])
      const events = yield* sendAndWait(conversation.id, "Hi")
      expect(mock.requests).toHaveLength(2)
      expect(events.some((event) => event.type === "activity" && event.text === "The model is busy, trying again")).toBe(true)
      const message = yield* lastMessage(conversation.id)
      expect(message.status).toBe("done")
      expect(messageText(message.parts)).toBe("Back now.")
    }).pipe(Effect.provide(realModelLayer())), { timeout: 10_000 })

  it.live("keeps the partial text when the stream drops mid-reply, without retrying", () =>
    Effect.gen(function*() {
      script({ text: ["The answer ", "is ", "forty", "-two"], disconnectAfter: 3, delayMs: 30 })
      const { conversation } = yield* setup([])
      yield* sendAndWait(conversation.id, "What is it?")
      expect(mock.requests).toHaveLength(1)
      const message = yield* lastMessage(conversation.id)
      expect(message.status).toBe("error")
      expect(messageText(message.parts)).toBe("The answer is")
      expect(message.error).toBe("Couldn't reach the model provider, or the connection dropped mid-reply.")
    }).pipe(Effect.provide(realModelLayer())))

  it.live("doesn't leak reasoning into the reply", () =>
    Effect.gen(function*() {
      script({ reasoning: "SECRET chain of thought about the user.", text: "Short answer." })
      const { conversation } = yield* setup([])
      const events = yield* sendAndWait(conversation.id, "Think hard")
      const message = yield* lastMessage(conversation.id)
      expect(message.parts).toEqual([{ type: "text", text: "Short answer." }])
      expect(JSON.stringify(events)).not.toContain("SECRET")
    }).pipe(Effect.provide(realModelLayer())))

  it.live("turns malformed or unknown calls into failures the model can fix", () =>
    Effect.gen(function*() {
      script(
        {
          toolCalls: [
            { id: "call_bad", name: "write_file", arguments: "{\"path\": \"a.txt\", \"content\": " },
            { id: "call_list", name: "list_files", arguments: "" },
            { id: "call_ghost", name: "delete_everything", arguments: {} },
            { id: "call_array", name: "read_file", arguments: "[\"a.txt\"]" }
          ]
        },
        { toolCalls: [{ id: "call_good", name: "write_file", arguments: { path: "a.txt", content: "fixed" } }] },
        { text: "Fixed it." }
      )
      const { conversation } = yield* setup()
      yield* sendAndWait(conversation.id, "Write a.txt")

      expect(mock.requests).toHaveLength(3)
      const results = turnMessages(mock.requests[1]!).filter((m) => m.role === "tool")
      expect(results.map((m) => m.tool_call_id)).toEqual(["call_bad", "call_list", "call_ghost", "call_array"])
      expect(results[0]!.content).toContain("weren't valid JSON")
      expect(results[2]!.content).toBe("There is no tool called delete_everything.")
      expect(results[3]!.content).toContain("must be a JSON object")
      const replayed = turnMessages(mock.requests[1]!)[1]!.tool_calls!
      expect(replayed.map((call) => call.function.arguments)).toEqual(["{}", "{}", "{}", "{}"])

      const message = yield* lastMessage(conversation.id)
      expect(message.status).toBe("done")
      const failures = message.parts.flatMap((part) => (part.type === "tool-result" ? [part.isFailure] : []))
      expect(failures).toEqual([true, false, true, true, false])
      expect(messageText(message.parts)).toBe("Fixed it.")
    }).pipe(Effect.provide(realModelLayer())))

  it.live("finishes with the text when the model still calls tools after the step limit", () =>
    Effect.gen(function*() {
      script((request) => ({
        text: request.body.tools === undefined ? "Here's what I found so far." : "",
        toolCalls: [{ name: "list_files", arguments: {} }]
      }))
      yield* useEndpoint(mock.url, "mock-model")
      const bot = yield* createBot({ name: "Ada", tools: ["files"], maxSteps: 1 })
      const conversation = yield* createConversation([bot.id])
      yield* sendAndWait(conversation.id, "Keep looking")
      expect(mock.requests.map((request) => request.body.tools !== undefined)).toEqual([true, false])
      const message = yield* lastMessage(conversation.id)
      expect(message.status).toBe("done")
      expect(message.parts.filter((part) => part.type === "tool-call")).toHaveLength(1)
      expect(messageText(message.parts)).toBe("Here's what I found so far.")
    }).pipe(Effect.provide(realModelLayer())))

  it.live("handles Ollama-style whole tool calls next to text", () =>
    Effect.gen(function*() {
      script(
        { text: "Checking.", toolCallStyle: "whole", toolCalls: [{ name: "list_files", arguments: { path: "." } }] },
        { text: "It's empty." }
      )
      const { conversation } = yield* setup()
      yield* sendAndWait(conversation.id, "What's in your workspace?")
      const message = yield* lastMessage(conversation.id)
      expect(message.parts.map((part) => part.type)).toEqual(["text", "tool-call", "tool-result", "text"])
      expect(turnMessages(mock.requests[1]!)[1]).toMatchObject({ role: "assistant", content: "Checking.", tool_calls: [{ function: { name: "list_files" } }] })
    }).pipe(Effect.provide(realModelLayer())))

  it.live("runs a background self-review that saves a skill through the client", () =>
    Effect.gen(function*() {
      const skill = "---\nname: workspace-tour\ndescription: Use when asked what's in the workspace.\n---\n\n1. Call list_files.\n"
      script((request) => {
        if (request.body.stream === true) {
          return request.index === 0 ? { toolCalls: [{ id: "call_ls", name: "list_files", arguments: {} }] } : { text: "Your workspace is empty." }
        }
        const reviewed = request.body.messages.some((m) => m.role === "tool")
        return reviewed
          ? { text: "Saved a skill." }
          : { toolCalls: [{ id: "call_skill", name: "skill_manage", arguments: { action: "create", name: "workspace-tour", content: skill } }] }
      })
      const { bot, conversation } = yield* setup(["files", "skills"])
      yield* sendAndWait(conversation.id, "What's in your workspace?")

      const selfReview = yield* SelfReview
      yield* Effect.sleep(Duration.millis(20))
      while (yield* selfReview.isReviewing(bot.id)) yield* Effect.sleep(Duration.millis(10))

      const reviews = mock.unstreamed()
      expect(reviews).toHaveLength(2)
      expect(reviews[0]!.body.tools!.map((tool) => tool.function.name)).toContain("skill_manage")
      expect(JSON.stringify(reviews[0]!.body.messages)).toContain("list_files")
      expect(turnMessages(reviews[1]!).at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_skill" }] })

      expect((yield* (yield* SkillStore).get(bot.id, "workspace-tour")).content).toContain("Call list_files.")
      const message = yield* lastMessage(conversation.id)
      expect(message.parts.at(-1)).toEqual({ type: "learned", text: "Created skill \"workspace-tour\"" })
    }).pipe(Effect.provide(realModelLayer({ reviewSkillInterval: 1 }))))

  it.live("asks a review to retry a malformed call and keeps text next to its calls", () =>
    Effect.gen(function*() {
      const skill = "---\nname: workspace-tour\ndescription: Use when asked what's in the workspace.\n---\n\n1. Call list_files.\n"
      let reviewCalls = 0
      script((request) => {
        if (request.body.stream === true) {
          return request.index === 0 ? { toolCalls: [{ id: "call_ls", name: "list_files", arguments: {} }] } : { text: "Your workspace is empty." }
        }
        reviewCalls++
        if (reviewCalls === 1) return { toolCalls: [{ id: "call_bad", name: "skill_manage", arguments: "{\"action\": \"create\"" }] }
        if (reviewCalls === 2) {
          return {
            text: "Saving a tour skill.",
            toolCalls: [{ id: "call_skill", name: "skill_manage", arguments: { action: "create", name: "workspace-tour", content: skill } }]
          }
        }
        return { text: "Saved a skill." }
      })
      const { bot, conversation } = yield* setup(["files", "skills"])
      yield* sendAndWait(conversation.id, "What's in your workspace?")

      const selfReview = yield* SelfReview
      yield* Effect.sleep(Duration.millis(20))
      while (yield* selfReview.isReviewing(bot.id)) yield* Effect.sleep(Duration.millis(10))

      const reviews = mock.unstreamed()
      expect(reviews).toHaveLength(3)
      expect(turnMessages(reviews[1]!).at(-1)).toMatchObject({ role: "user" })
      expect(JSON.stringify(turnMessages(reviews[1]!).at(-1))).toContain("couldn't be used")
      expect(turnMessages(reviews[2]!).at(-2)).toMatchObject({
        role: "assistant",
        content: "Saving a tour skill.",
        tool_calls: [{ id: "call_skill" }]
      })
      expect((yield* (yield* SkillStore).get(bot.id, "workspace-tour")).content).toContain("Call list_files.")
    }).pipe(Effect.provide(realModelLayer({ reviewSkillInterval: 1 }))))
})
