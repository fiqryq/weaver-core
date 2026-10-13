import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { randomBytes } from "node:crypto"
import { AppConfig } from "../../../src/config/Config.ts"
import { IntegrationRepo } from "../../../src/features/integrations/IntegrationRepo.ts"
import { DatabaseLive } from "../../../src/platform/db/Database.ts"
import { isEncrypted } from "../../../src/platform/lib/crypto.ts"

describe("OAuth token encryption", () => {
  const encryptionKey = randomBytes(32).toString("hex")
  const config = AppConfig.layerTest({ encryptionKey })

  const testLayer = Layer.provide(
    IntegrationRepo.layer,
    Layer.mergeAll(DatabaseLive, config)
  )

  it("stores OAuth tokens encrypted when encryption key is configured", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const repo = yield* IntegrationRepo
        const db = yield* Effect.serviceOption(Effect.sql.SqlClient)
        
        // Create an integration with OAuth
        const integration = yield* repo.create({
          name: "Test OAuth",
          auth: "oauth",
          transport: "http",
          url: "https://api.example.com/mcp",
          enabled: true
        })

        // Store some OAuth data
        yield* repo.updateOAuth(integration.id, () => ({
          tokens: {
            access_token: "test-access-token-12345",
            refresh_token: "test-refresh-token-67890",
            expires_at: Date.now() + 3600000
          } as any
        }))

        // Check the database directly - tokens should be encrypted
        if (Effect.Option.isSome(db)) {
          const rows = yield* db.value`SELECT oauth FROM integrations WHERE id = ${integration.id}`.pipe(Effect.orDie)
          const stored = rows[0]?.oauth as string
          expect(stored).toBeDefined()
          expect(isEncrypted(stored)).toBe(true)
          // Should not contain plaintext tokens
          expect(stored).not.toContain("test-access-token")
          expect(stored).not.toContain("test-refresh-token")
        }

        // But reading through the repo should decrypt transparently
        const oauth = yield* repo.oauth(integration.id)
        expect(oauth.tokens).toBeDefined()
        expect((oauth.tokens as any)?.access_token).toBe("test-access-token-12345")
        expect((oauth.tokens as any)?.refresh_token).toBe("test-refresh-token-67890")
      }).pipe(Effect.provide(testLayer))
    )
  })

  it("migrates plaintext OAuth tokens to encrypted on read", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const repo = yield* IntegrationRepo
        const db = yield* Effect.serviceOption(Effect.sql.SqlClient)
        
        // Create an integration
        const integration = yield* repo.create({
          name: "Migration Test",
          auth: "oauth",
          transport: "http",
          url: "https://api.example.com/mcp",
          enabled: true
        })

        // Manually store plaintext OAuth data (simulating old data)
        if (Effect.Option.isSome(db)) {
          const plaintext = JSON.stringify({
            tokens: {
              access_token: "old-plaintext-token",
              refresh_token: "old-refresh-token"
            }
          })
          yield* db.value`UPDATE integrations SET oauth = ${plaintext} WHERE id = ${integration.id}`.pipe(Effect.orDie)
        }

        // Read through repo - should decrypt transparently (plaintext)
        const oauth1 = yield* repo.oauth(integration.id)
        expect((oauth1.tokens as any)?.access_token).toBe("old-plaintext-token")

        // Update the OAuth data - should now encrypt it
        yield* repo.updateOAuth(integration.id, (data) => ({
          ...data,
          signedInAt: new Date().toISOString()
        }))

        // Check database again - should now be encrypted
        if (Effect.Option.isSome(db)) {
          const rows = yield* db.value`SELECT oauth FROM integrations WHERE id = ${integration.id}`.pipe(Effect.orDie)
          const stored = rows[0]?.oauth as string
          expect(isEncrypted(stored)).toBe(true)
          expect(stored).not.toContain("old-plaintext-token")
        }

        // And reading should still work
        const oauth2 = yield* repo.oauth(integration.id)
        expect((oauth2.tokens as any)?.access_token).toBe("old-plaintext-token")
        expect(oauth2.signedInAt).toBeDefined()
      }).pipe(Effect.provide(testLayer))
    )
  })

  it("works without encryption key (backward compatibility)", async () => {
    const noEncryptionConfig = AppConfig.layerTest({ encryptionKey: "" })
    const noEncryptionLayer = Layer.provide(
      IntegrationRepo.layer,
      Layer.mergeAll(DatabaseLive, noEncryptionConfig)
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        const repo = yield* IntegrationRepo
        const db = yield* Effect.serviceOption(Effect.sql.SqlClient)
        
        const integration = yield* repo.create({
          name: "No Encryption",
          auth: "oauth",
          transport: "http",
          url: "https://api.example.com/mcp",
          enabled: true
        })

        yield* repo.updateOAuth(integration.id, () => ({
          tokens: {
            access_token: "plaintext-token"
          } as any
        }))

        // Should be stored as plaintext
        if (Effect.Option.isSome(db)) {
          const rows = yield* db.value`SELECT oauth FROM integrations WHERE id = ${integration.id}`.pipe(Effect.orDie)
          const stored = rows[0]?.oauth as string
          expect(isEncrypted(stored)).toBe(false)
          expect(stored).toContain("plaintext-token")
        }

        // And reading should work
        const oauth = yield* repo.oauth(integration.id)
        expect((oauth.tokens as any)?.access_token).toBe("plaintext-token")
      }).pipe(Effect.provide(noEncryptionLayer))
    )
  })
})
