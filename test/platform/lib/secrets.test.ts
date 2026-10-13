import { describe, expect, it } from "vitest"
import { redactSecrets, redactSecretsFromData } from "../../../src/platform/lib/secrets.ts"

describe("redactSecrets", () => {
  it("redacts OpenAI API keys", () => {
    const input = "Using API key sk-proj-1234567890abcdefghijklmnopqrstuvwxyz to call OpenAI"
    const output = redactSecrets(input)
    expect(output).not.toContain("sk-proj-1234567890")
    expect(output).toContain("[REDACTED:sk-***]")
  })

  it("redacts GitHub personal access tokens", () => {
    const input = "Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz"
    const output = redactSecrets(input)
    expect(output).not.toContain("ghp_1234567890")
    expect(output).toContain("[REDACTED:ghp_***]")
  })

  it("redacts Slack tokens", () => {
    const input = "Slack bot token: xoxb-FAKE1234567-NOTAREALTOKENJUSTTEST"
    const output = redactSecrets(input)
    expect(output).not.toContain("xoxb-FAKE1234567")
    expect(output).toContain("[REDACTED:xoxb-***]")
  })

  it("redacts AWS access keys", () => {
    const input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"
    const output = redactSecrets(input)
    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(output).toContain("[REDACTED:AKIA***]")
  })

  it("redacts RSA private keys", () => {
    const input = `Some text
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz
ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890
-----END RSA PRIVATE KEY-----
More text`
    const output = redactSecrets(input)
    expect(output).not.toContain("MIIEpAIBAAKCAQEA")
    expect(output).toContain("[REDACTED:PRIVATE_KEY]")
    expect(output).toContain("Some text")
    expect(output).toContain("More text")
  })

  it("redacts EC private keys", () => {
    const input = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIAbcdefghijklmnopqrstuvwxyz1234567890ABCDEF
-----END EC PRIVATE KEY-----`
    const output = redactSecrets(input)
    expect(output).not.toContain("MHcCAQEEIA")
    expect(output).toContain("[REDACTED:PRIVATE_KEY]")
  })

  it("redacts bearer tokens from Authorization headers", () => {
    const input = "Authorization: Bearer abc123def456ghi789jkl012mno345pqr678stu901"
    const output = redactSecrets(input)
    expect(output).not.toContain("abc123def456")
    expect(output).toContain("Authorization: Bearer [REDACTED]")
  })

  it("preserves non-sensitive content", () => {
    const input = "The quick brown fox jumps over the lazy dog. Port 8080 is open."
    const output = redactSecrets(input)
    expect(output).toBe(input)
  })

  it("handles multiple secrets in one string", () => {
    const input = "Key1: sk-abc123xyz456def789ghi, Key2: ghp_1234567890abcdefghijklmnopqrstuvwxyz"
    const output = redactSecrets(input)
    expect(output).not.toContain("sk-abc123xyz456")
    expect(output).not.toContain("ghp_1234567890")
    expect(output).toContain("[REDACTED:sk-***]")
    expect(output).toContain("[REDACTED:ghp_***]")
  })
})

describe("redactSecretsFromData", () => {
  it("redacts secrets in string values", () => {
    const input = { apiKey: "sk-1234567890abcdefghijklmnopqrstuvwxyz" }
    const output = redactSecretsFromData(input) as typeof input
    expect(output.apiKey).not.toContain("sk-1234567890")
    expect(output.apiKey).toContain("[REDACTED:sk-***]")
  })

  it("redacts secrets in nested objects", () => {
    const input = {
      service: "openai",
      config: {
        key: "sk-1234567890abcdefghijklmnopqrstuvwxyz",
        endpoint: "https://api.openai.com"
      }
    }
    const output = redactSecretsFromData(input) as typeof input
    expect(output.config.key).not.toContain("sk-1234567890")
    expect(output.config.endpoint).toBe("https://api.openai.com")
  })

  it("redacts secrets in arrays", () => {
    const input = [
      "normal text",
      "token: ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      { key: "sk-abc123xyz456def789ghi" }
    ]
    const output = redactSecretsFromData(input) as typeof input
    expect(output[0]).toBe("normal text")
    expect(output[1]).toContain("[REDACTED:ghp_***]")
    expect((output[2] as { key: string }).key).toContain("[REDACTED:sk-***]")
  })

  it("handles null and undefined", () => {
    expect(redactSecretsFromData(null)).toBe(null)
    expect(redactSecretsFromData(undefined)).toBe(undefined)
  })

  it("handles numbers and booleans", () => {
    expect(redactSecretsFromData(42)).toBe(42)
    expect(redactSecretsFromData(true)).toBe(true)
  })
})
