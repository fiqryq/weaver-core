import { Duration } from "effect"
import { AiError } from "effect/ai"

/** The provider's own error message from a response body, e.g. `{"error":{"message":"..."}}`. */
const providerMessage = (body: string | undefined): string | undefined => {
  if (body === undefined || body.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    const root = Array.isArray(parsed) ? parsed[0] : parsed
    if (typeof root !== "object" || root === null) return undefined
    const error = (root as { error?: unknown }).error
    if (typeof error === "string") return error
    if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message
    }
    const message = (root as { message?: unknown }).message
    return typeof message === "string" ? message : undefined
  } catch {
    return body.length > 200 ? `${body.slice(0, 200)}…` : body
  }
}

type HttpReason = {
  readonly http?: { readonly body?: string | undefined; readonly response?: { readonly status: number } | undefined } | undefined
}

/** e.g. ` (HTTP 401): Incorrect API key provided`, for the end of a sentence. */
const detail = (reason: HttpReason) => {
  const status = reason.http?.response?.status
  const message = providerMessage(reason.http?.body)?.trim().replace(/\.+$/, "")
  const prefix = status !== undefined ? ` (HTTP ${status})` : ""
  return message !== undefined && message.length > 0 ? `${prefix}: ${message}` : prefix
}

const droppedConnection = "Couldn't reach the model provider, or the connection dropped mid-reply."

/** A model failure in words a person can act on, without request URLs or library boilerplate. */
export const describeModelError = (error: AiError.AiError): string => {
  const reason = error.reason
  switch (reason._tag) {
    case "AuthenticationError":
      return `The model provider rejected the API key${detail(reason)}. Check it in Settings > Models.`
    case "RateLimitError": {
      const wait = reason.retryAfter !== undefined && Duration.toMillis(reason.retryAfter) > 0
        ? ` Try again in ${Duration.format(reason.retryAfter)}.`
        : " Try again in a moment."
      return `The model provider is rate limiting requests${detail(reason)}.${wait}`
    }
    case "QuotaExhaustedError":
      return `The model provider account is out of credits or quota${detail(reason)}.`
    case "InternalProviderError":
      return `The model provider had a server error${detail(reason)}. Try again in a moment.`
    case "InvalidRequestError":
      return `The model provider rejected the request${detail(reason)}.`
    case "ContentPolicyError":
      return `The model provider blocked this under its content policy${reason.description ? `: ${reason.description}` : "."}`
    case "NetworkError":
      return reason.reason === "TransportError"
        ? reason.description ? `${droppedConnection.slice(0, -1)} (${reason.description}).` : droppedConnection
        : `Couldn't send the request to the model provider: ${reason.description ?? reason.reason}.`
    case "InvalidOutputError":
      // The client's wording when the response body breaks off, e.g. a stream cut mid-reply.
      return reason.description === "Failed to decode response"
        ? droppedConnection
        : `The model provider sent a response Weaver couldn't read: ${reason.description ?? "unknown format"}.`
    case "UnknownError":
      // DeepSeek and others answer 402 Payment Required when the balance runs out.
      return reason.http?.response?.status === 402
        ? `The model provider account is out of credits or quota${detail(reason)}.`
        : `The model provider returned an error${detail(reason)}.`
    default:
      return reason.message
  }
}

/**
 * The model or provider doesn't take the tool definitions, e.g. Ollama's "llama3 does not support
 * tools" or a schema it can't handle. Context-length errors mention functions too, but aren't this.
 */
export const rejectsTools = (error: unknown): boolean => {
  if (!AiError.isAiError(error) || error.reason._tag !== "InvalidRequestError") return false
  const text = providerMessage(error.reason.http?.body) ?? error.reason.description ?? ""
  return /\btools?\b|\btool[ _]?(call|choice)|\bfunctions?\b|function[ _]?call/i.test(text) &&
    !/context|too long|maximum|tokens/i.test(text)
}

/** Worth sending again as-is: rate limits, provider outages and dropped connections. */
export const isTransient = (error: unknown): boolean =>
  AiError.isAiError(error) &&
  (error.reason._tag === "RateLimitError" || error.reason._tag === "InternalProviderError" ||
    (error.reason._tag === "NetworkError" && error.reason.reason === "TransportError"))
