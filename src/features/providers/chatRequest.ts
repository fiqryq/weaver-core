import { HttpClient, HttpClientRequest } from "effect/http"

interface ChatMessage {
  readonly role?: unknown
  readonly content?: unknown
  readonly tool_calls?: unknown
  readonly [key: string]: unknown
}

const isAssistant = (message: ChatMessage | undefined): message is ChatMessage =>
  message !== undefined && message.role === "assistant"

/**
 * The client sends a turn's text and its tool calls as two assistant messages in a row; providers
 * expect one (and some reject back-to-back assistant messages), so they're joined.
 */
export const joinToolCallTurns = (messages: ReadonlyArray<ChatMessage>): Array<ChatMessage> => {
  const joined: Array<ChatMessage> = []
  for (const message of messages) {
    const previous = joined.at(-1)
    if (
      isAssistant(previous) && previous.tool_calls === undefined && typeof previous.content === "string" &&
      isAssistant(message) && Array.isArray(message.tool_calls) && (message.content ?? null) === null
    ) {
      joined[joined.length - 1] = { ...message, content: previous.content }
    } else {
      joined.push(message)
    }
  }
  return joined
}

/**
 * Tool schemas aren't written for strict mode (OpenAI rejects them with `strict: true`), so the
 * flag is left out, which every compatible API reads as non-strict.
 */
const withoutStrict = (tools: unknown): unknown =>
  Array.isArray(tools)
    ? tools.map((tool) => {
      if (typeof tool !== "object" || tool === null || typeof tool.function !== "object" || tool.function === null) return tool
      const { strict: _, ...fn } = tool.function as Record<string, unknown>
      return { ...tool, function: fn }
    })
    : tools

export const normalizeChatRequest = (body: Record<string, unknown>): Record<string, unknown> => ({
  ...body,
  ...(Array.isArray(body.messages) ? { messages: joinToolCallTurns(body.messages as Array<ChatMessage>) } : {}),
  ...(body.tools !== undefined ? { tools: withoutStrict(body.tools) } : {})
})

const decoder = new TextDecoder()

/** Applies `normalizeChatRequest` to every Chat Completions request a client sends. */
export const normalizeChatRequests = HttpClient.mapRequest((request) => {
  if (!request.url.endsWith("/chat/completions") || request.body._tag !== "Uint8Array") return request
  let body: unknown
  try {
    body = JSON.parse(decoder.decode(request.body.body))
  } catch {
    return request
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return request
  return HttpClientRequest.bodyJsonUnsafe(request, normalizeChatRequest(body as Record<string, unknown>))
})
