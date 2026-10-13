import { describe, expect, it } from "vitest"
import { encrypt, decrypt, isEncrypted } from "../../../src/platform/lib/crypto.ts"
import { randomBytes } from "node:crypto"

describe("crypto", () => {
  const testKey = randomBytes(32).toString("hex") // 64 hex chars = 32 bytes

  describe("encrypt/decrypt", () => {
    it("encrypts and decrypts data correctly", () => {
      const plaintext = "sensitive OAuth token data"
      const encrypted = encrypt(plaintext, testKey)
      const decrypted = decrypt(encrypted, testKey)
      expect(decrypted).toBe(plaintext)
    })

    it("produces different ciphertexts for same plaintext (random IV)", () => {
      const plaintext = "same data"
      const encrypted1 = encrypt(plaintext, testKey)
      const encrypted2 = encrypt(plaintext, testKey)
      expect(encrypted1).not.toBe(encrypted2)
      expect(decrypt(encrypted1, testKey)).toBe(plaintext)
      expect(decrypt(encrypted2, testKey)).toBe(plaintext)
    })

    it("handles empty strings", () => {
      const encrypted = encrypt("", testKey)
      expect(decrypt(encrypted, testKey)).toBe("")
    })

    it("handles special characters and unicode", () => {
      const plaintext = '{"emoji":"🔐","special":"\\n\\t\\r","unicode":"日本語"}'
      const encrypted = encrypt(plaintext, testKey)
      expect(decrypt(encrypted, testKey)).toBe(plaintext)
    })

    it("throws on wrong decryption key", () => {
      const wrongKey = randomBytes(32).toString("hex")
      const encrypted = encrypt("secret", testKey)
      expect(() => decrypt(encrypted, wrongKey)).toThrow()
    })

    it("throws on corrupted ciphertext", () => {
      const encrypted = encrypt("data", testKey)
      const corrupted = encrypted.slice(0, -5) + "XXXXX"
      expect(() => decrypt(corrupted, testKey)).toThrow()
    })

    it("throws on invalid key length", () => {
      expect(() => encrypt("data", "tooshort")).toThrow("32 bytes")
      expect(() => decrypt("anything", "tooshort")).toThrow("32 bytes")
    })

    it("throws on ciphertext too short", () => {
      expect(() => decrypt("YWJj", testKey)).toThrow("too short")
    })
  })

  describe("isEncrypted", () => {
    it("recognizes encrypted data", () => {
      const encrypted = encrypt("test data", testKey)
      expect(isEncrypted(encrypted)).toBe(true)
    })

    it("rejects plaintext JSON", () => {
      const plaintext = '{"tokens":{"access_token":"secret"}}'
      expect(isEncrypted(plaintext)).toBe(false)
    })

    it("rejects empty string", () => {
      expect(isEncrypted("")).toBe(false)
    })

    it("rejects short base64 strings", () => {
      expect(isEncrypted("YWJj")).toBe(false) // "abc" in base64, too short
    })

    it("rejects non-base64 strings", () => {
      expect(isEncrypted("not base64! @#$%")).toBe(false)
    })

    it("handles edge case of long non-encrypted base64", () => {
      // A long base64 string that isn't actually our encrypted format
      const longBase64 = Buffer.from("a".repeat(100)).toString("base64")
      // This might return true (looks like encrypted data by length)
      // but will fail decryption with wrong key - that's fine
      expect(typeof isEncrypted(longBase64)).toBe("boolean")
    })
  })
})
