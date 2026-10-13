import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * Encryption for sensitive data at rest using AES-256-GCM.
 * The encryption key should be loaded from a secure file (e.g. /etc/weaver/encryption-key)
 * and generated during installation if missing.
 */

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12 // 96 bits for GCM
const AUTH_TAG_LENGTH = 16 // 128 bits

/**
 * Encrypts data with AES-256-GCM.
 * Returns base64-encoded string: iv + authTag + ciphertext
 * 
 * @param plaintext The data to encrypt
 * @param key 32-byte encryption key (hex-encoded 64 chars)
 * @returns Base64-encoded encrypted data
 */
export const encrypt = (plaintext: string, key: string): string => {
  const keyBuffer = Buffer.from(key, "hex")
  if (keyBuffer.length !== 32) {
    throw new Error("Encryption key must be 32 bytes (64 hex characters)")
  }

  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, keyBuffer, iv)

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ])

  const authTag = cipher.getAuthTag()

  // Pack: iv (12 bytes) + authTag (16 bytes) + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted])
  return packed.toString("base64")
}

/**
 * Decrypts data encrypted with encrypt().
 * 
 * @param ciphertext Base64-encoded encrypted data
 * @param key 32-byte encryption key (hex-encoded 64 chars)
 * @returns Decrypted plaintext
 * @throws Error if decryption fails (wrong key, corrupted data)
 */
export const decrypt = (ciphertext: string, key: string): string => {
  const keyBuffer = Buffer.from(key, "hex")
  if (keyBuffer.length !== 32) {
    throw new Error("Encryption key must be 32 bytes (64 hex characters)")
  }

  const packed = Buffer.from(ciphertext, "base64")
  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Ciphertext too short")
  }

  const iv = packed.subarray(0, IV_LENGTH)
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ])

  return decrypted.toString("utf8")
}

/**
 * Checks if a string looks like encrypted data (base64 format from encrypt()).
 * Used to detect plaintext vs encrypted data during migration.
 */
export const isEncrypted = (data: string): boolean => {
  // Encrypted data is base64 and has minimum length (IV + auth tag + at least 1 byte ciphertext)
  if (!/^[A-Za-z0-9+/]+=*$/.test(data)) return false
  try {
    const packed = Buffer.from(data, "base64")
    return packed.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1
  } catch {
    return false
  }
}
