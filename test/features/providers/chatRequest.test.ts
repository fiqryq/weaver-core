import { describe, expect, it } from "@effect/vitest"
import { AiError } from "effect/ai"
import { joinToolCallTurns, normalizeChatRequest } from "../../../src/features/providers/chatRequest.ts"
import { describeModelError, isTransient, rejectsTools } from "../../../src/features/providers/modelErrors.ts"

const call = (id: string) => ({ id, type: "function", function: { name: "list_files", arguments: "{}" } })

const httpError = (status: number, body: string) => {
  const http = {
    request: { method: "POST" as const, url: "http://x/v1/chat/completions", urlParams: [], headers: {} },
    response: { status, headers: {} },
    body
  }
  const description = `${JSON.parse(body).error.message} (POST http://x/v1/chat/completions)`
  const reason = status === 400
    ? new AiError.InvalidRequestError({ description, http })
    : status === 401
    ? new AiError.AuthenticationError({ kind: "InvalidKey", description, http })
    : new AiError.InternalProviderError({ description, http })
  return AiError.make({ module: "OpenAiClient", method: "createResponseStream", reason })
}

const body = (message: string) => JSON.stringify({ error: { message, type: "invalid_request_error" } })

describe("Chat Completions requests", () => {
  it("joins a turn's text and tool calls into one assistant message", () => {
    expect(joinToolCallTurns([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Let me look." },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "x" },
      { role: "tool", tool_call_id: "b", content: "y" },
      { role: "assistant", content: null, tool_calls: [call("c")] },
      { role: "tool", tool_call_id: "c", content: "z" },
      { role: "assistant", content: "Done." },
      { role: "user", content: "thanks" }
    ])).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Let me look.", tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "x" },
      { role: "tool", tool_call_id: "b", content: "y" },
      { role: "assistant", content: null, tool_calls: [call("c")] },
      { role: "tool", tool_call_id: "c", content: "z" },
      { role: "assistant", content: "Done." },
      { role: "user", content: "thanks" }
    ])
  })

  it("leaves out strict mode and keeps everything else", () => {
    const request = normalizeChatRequest({
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" }, strict: true } }]
    })
    expect(request).toEqual({
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }]
    })
  })
})

describe("model errors", () => {
  it("only treats tool complaints as a model without tool support", () => {
    expect(rejectsTools(httpError(400, body("registry.ollama.ai/library/llama3:latest does not support tools")))).toBe(true)
    expect(rejectsTools(httpError(400, body("deepseek-reasoner does not support Function Calling")))).toBe(true)
    expect(rejectsTools(httpError(400, body("\"auto\" tool choice requires --enable-auto-tool-choice")))).toBe(true)
    expect(rejectsTools(httpError(400, body("Model not found: gpt-9")))).toBe(false)
    expect(rejectsTools(httpError(400, body("maximum context length is 8192 tokens (messages and functions)")))).toBe(false)
    expect(rejectsTools(httpError(500, body("tools broke")))).toBe(false)
  })

  it("describes failures without URLs and knows which are worth retrying", () => {
    expect(describeModelError(httpError(401, body("Invalid key.")))).toBe(
      "The model provider rejected the API key (HTTP 401): Invalid key. Check it in Settings > Models."
    )
    expect(describeModelError(httpError(500, body("Upstream timeout")))).toBe(
      "The model provider had a server error (HTTP 500): Upstream timeout. Try again in a moment."
    )
    expect(isTransient(httpError(500, body("x")))).toBe(true)
    expect(isTransient(httpError(400, body("x")))).toBe(false)
    expect(isTransient(httpError(401, body("x")))).toBe(false)
  })
})
