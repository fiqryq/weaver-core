/**
 * Redacts sensitive values from strings before they're logged or sent to clients.
 * Matches common secret patterns and PEM-encoded private keys.
 */

const secretPatterns = [
  // API keys with common prefixes
  /\b(sk-[a-zA-Z0-9]{20,})/gi,
  /\b(ghp_[a-zA-Z0-9]{36,})/gi,
  /\b(ghs_[a-zA-Z0-9]{36,})/gi,
  /\b(xox[pbar]-[a-zA-Z0-9-]{10,})/gi,
  /\b(AKIA[0-9A-Z]{16})/g,
  // Generic tokens (long alphanumeric strings that look like secrets)
  /\b([a-f0-9]{32,})\b/gi,
  /\b([A-Za-z0-9_-]{40,})\b/g
]

/**
 * PEM-encoded private key block (RSA, EC, etc).
 * Matches from BEGIN to END including the content.
 */
const pemKeyPattern = /(-----BEGIN[A-Z ]+PRIVATE KEY-----[\s\S]*?-----END[A-Z ]+PRIVATE KEY-----)/gi

/**
 * Redacts secrets from a string, replacing them with [REDACTED].
 * - Private key blocks: replaced entirely with [REDACTED:PRIVATE_KEY]
 * - API keys/tokens: replaced with [REDACTED] or [REDACTED:<prefix>] for recognizable prefixes
 */
export const redactSecrets = (text: string): string => {
  let result = text

  // Redact PEM-encoded private keys
  result = result.replace(pemKeyPattern, "[REDACTED:PRIVATE_KEY]")

  // Redact common API key patterns
  result = result.replace(/\b(sk-)[a-zA-Z0-9]{20,}/gi, "[REDACTED:$1***]")
  result = result.replace(/\b(ghp_)[a-zA-Z0-9]{36,}/gi, "[REDACTED:$1***]")
  result = result.replace(/\b(ghs_)[a-zA-Z0-9]{36,}/gi, "[REDACTED:$1***]")
  result = result.replace(/\b(xox[pbar]-)[a-zA-Z0-9-]{10,}/gi, "[REDACTED:$1***]")
  result = result.replace(/\b(AKIA)[0-9A-Z]{16}/g, "[REDACTED:$1***]")

  // Redact bearer tokens in Authorization headers
  result = result.replace(/\bAuthorization:\s*Bearer\s+[^\s\]]+/gi, "Authorization: Bearer [REDACTED]")

  return result
}

/**
 * Redacts secrets from structured data (objects, arrays).
 * Recursively processes nested structures.
 */
export const redactSecretsFromData = (data: unknown): unknown => {
  if (typeof data === "string") {
    return redactSecrets(data)
  }
  if (Array.isArray(data)) {
    return data.map(redactSecretsFromData)
  }
  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
      result[key] = redactSecretsFromData(value)
    }
    return result
  }
  return data
}
