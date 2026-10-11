/**
 * An OpenAI-compatible Chat Completions server for tests: streams real SSE chunks (or JSON when the
 * request doesn't stream), records every request, and replies from a script.
 */

export interface MockToolCall {
  readonly id?: string
  readonly name: string
  /** Sent as-is when a string, so tests can send malformed JSON; objects are stringified. */
  readonly arguments: string | Record<string, unknown>
}

export interface MockTurn {
  readonly reasoning?: string
  /** Text deltas, in order. A string is split into a few deltas. */
  readonly text?: string | ReadonlyArray<string>
  readonly toolCalls?: ReadonlyArray<MockToolCall>
  /** `split` (default) sends id and name first, then arguments in pieces; `whole` sends each call in one chunk, like Ollama. */
  readonly toolCallStyle?: "split" | "whole"
  readonly usage?: { readonly prompt: number; readonly completion: number }
  readonly finishReason?: string
  /** Pause between chunks. */
  readonly delayMs?: number
  /** Cut the connection after this many chunks, without `[DONE]`. */
  readonly disconnectAfter?: number
}

export interface MockError {
  readonly status: number
  readonly message: string
  readonly type?: string
  readonly code?: string
  readonly headers?: Record<string, string>
}

export type MockReply = MockTurn | MockError

export interface RecordedRequest {
  readonly index: number
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: ChatRequest
}

export interface ChatMessage {
  readonly role: string
  readonly content?: unknown
  readonly tool_calls?: ReadonlyArray<{ id: string; type: string; function: { name: string; arguments: string } }>
  readonly tool_call_id?: string
}

export interface ChatRequest {
  readonly model: string
  readonly stream?: boolean
  readonly stream_options?: { include_usage?: boolean }
  readonly messages: ReadonlyArray<ChatMessage>
  readonly tools?: ReadonlyArray<{ type: string; function: { name: string; description?: string; parameters?: unknown; strict?: boolean } }>
  readonly [key: string]: unknown
}

export type MockScript = (request: RecordedRequest) => MockReply | Promise<MockReply>

export const isError = (reply: MockReply): reply is MockError => "status" in reply

const splitText = (text: string): Array<string> => {
  if (text.length < 6) return [text]
  const third = Math.ceil(text.length / 3)
  return [text.slice(0, third), text.slice(third, third * 2), text.slice(third * 2)]
}

const argumentsOf = (call: MockToolCall): string =>
  typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments)

/** The SSE `data:` payloads for a turn, without `[DONE]`. */
export const streamChunks = (turn: MockTurn, model: string, id: string, includeUsage: boolean): Array<unknown> => {
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }]
  })
  const chunks: Array<unknown> = [chunk({ role: "assistant", content: "" })]
  if (turn.reasoning !== undefined) {
    for (const piece of splitText(turn.reasoning)) chunks.push(chunk({ content: null, reasoning_content: piece }))
  }
  const text = typeof turn.text === "string" ? splitText(turn.text) : turn.text ?? []
  for (const piece of text) chunks.push(chunk({ content: piece }))
  const calls = turn.toolCalls ?? []
  calls.forEach((call, index) => {
    const callId = call.id ?? `call_${index}_${id}`
    const args = argumentsOf(call)
    if (turn.toolCallStyle === "whole") {
      chunks.push(chunk({ tool_calls: [{ index, id: callId, type: "function", function: { name: call.name, arguments: args } }] }))
      return
    }
    chunks.push(chunk({ tool_calls: [{ index, id: callId, type: "function", function: { name: call.name, arguments: "" } }] }))
    for (const piece of splitText(args)) {
      chunks.push(chunk({ tool_calls: [{ index, id: null, function: { name: null, arguments: piece } }] }))
    }
  })
  chunks.push(chunk({}, turn.finishReason ?? (calls.length > 0 ? "tool_calls" : "stop")))
  if (includeUsage) {
    const usage = turn.usage ?? { prompt: 11, completion: 7 }
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion }
    })
  }
  return chunks
}

const completion = (turn: MockTurn, model: string, id: string) => {
  const calls = turn.toolCalls ?? []
  const usage = turn.usage ?? { prompt: 11, completion: 7 }
  const text = typeof turn.text === "string" ? turn.text : (turn.text ?? []).join("")
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(turn.reasoning !== undefined ? { reasoning_content: turn.reasoning } : {}),
        ...(calls.length > 0
          ? {
            tool_calls: calls.map((call, index) => ({
              id: call.id ?? `call_${index}_${id}`,
              type: "function",
              function: { name: call.name, arguments: argumentsOf(call) }
            }))
          }
          : {})
      },
      finish_reason: turn.finishReason ?? (calls.length > 0 ? "tool_calls" : "stop")
    }],
    usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface OpenAiMock {
  /** Base URL to configure as the provider's API URL, e.g. `http://127.0.0.1:1234/v1`. */
  readonly url: string
  readonly requests: Array<RecordedRequest>
  /** Requests to `/chat/completions` that streamed (replies) or didn't (background reviews). */
  readonly streamed: () => Array<RecordedRequest>
  readonly unstreamed: () => Array<RecordedRequest>
  setScript(script: MockScript): void
  close(): Promise<void>
}

export const startOpenAiMock = (script: MockScript = () => ({ text: "Hello!" })): OpenAiMock => {
  const requests: Array<RecordedRequest> = []
  let current = script
  let counter = 0

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "mock-model", object: "model" }] })
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `No route for ${request.method} ${url.pathname}` } }, { status: 404 })
      }
      const body = await request.json() as ChatRequest
      const recorded: RecordedRequest = {
        index: requests.length,
        path: url.pathname,
        headers: Object.fromEntries(request.headers.entries()),
        body
      }
      requests.push(recorded)
      const reply = await current(recorded)
      if (isError(reply)) {
        return Response.json(
          { error: { message: reply.message, type: reply.type ?? "invalid_request_error", code: reply.code ?? null } },
          { status: reply.status, headers: reply.headers ?? {} }
        )
      }
      const id = `chatcmpl-${++counter}`
      if (body.stream !== true) return Response.json(completion(reply, body.model, id))

      const chunks = streamChunks(reply, body.model, id, body.stream_options?.include_usage === true)
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const [index, chunk] of chunks.entries()) {
            if (reply.disconnectAfter !== undefined && index >= reply.disconnectAfter) {
              controller.error(new Error("mock disconnect"))
              return
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            if (reply.delayMs !== undefined) await sleep(reply.delayMs)
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        }
      })
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
      })
    }
  })

  const chat = () => requests.filter((request) => request.path.endsWith("/chat/completions"))
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    streamed: () => chat().filter((request) => request.body.stream === true),
    unstreamed: () => chat().filter((request) => request.body.stream !== true),
    setScript: (script) => {
      current = script
    },
    close: () => server.stop(true)
  }
}
