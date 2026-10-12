import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../platform/http/Api.ts"
import { BadRequest } from "../../platform/http/errors.ts"
import { BotRepo } from "../bots/BotRepo.ts"
import { Integration, IntegrationTestResult, maskSecrets } from "./Integration.ts"
import { draftToMcpConfig, toMcpConfig, validateIntegration } from "./integrationConfig.ts"
import { IntegrationOAuth, signInFirstMessage } from "./IntegrationOAuth.ts"
import { IntegrationRepo } from "./IntegrationRepo.ts"
import { McpHub } from "./McpHub.ts"

const masked = (integration: Integration): Integration =>
  new Integration({ ...integration, env: maskSecrets(integration.env), headers: maskSecrets(integration.headers) })

const notSignedIn = (name: string) => new IntegrationTestResult({ ok: false, tools: [], error: signInFirstMessage(name) })

export const IntegrationsHandlers = HttpApiBuilder.group(
  Api,
  "integrations",
  Effect.fn(function*(handlers) {
    const integrations = yield* IntegrationRepo
    const bots = yield* BotRepo
    const hub = yield* McpHub
    const oauth = yield* IntegrationOAuth

    const validate = (input: Parameters<typeof validateIntegration>[0]) => {
      const problem = validateIntegration(input)
      return problem === undefined ? Effect.void : Effect.fail(new BadRequest({ message: problem }))
    }

    const test = (integration: Integration) =>
      integration.auth === "oauth" && integration.oauthStatus !== "signed-in"
        ? Effect.succeed(notSignedIn(integration.name))
        : hub.test(oauth.config(integration))

    return handlers
      .handle("list", () => Effect.map(integrations.list, (all) => all.map(masked)))
      .handle("create", ({ payload }) =>
        Effect.andThen(validate(payload), Effect.map(integrations.create(payload), masked)))
      .handle("update", ({ params, payload }) =>
        Effect.gen(function*() {
          const current = yield* integrations.get(params.id)
          yield* validate({
            transport: payload.transport ?? current.transport,
            command: payload.command ?? current.command,
            url: payload.url ?? current.url,
            auth: payload.auth ?? current.auth
          })
          const updated = yield* integrations.update(params.id, payload)
          yield* hub.invalidate(toMcpConfig(current).key)
          return masked(updated)
        }))
      .handle("remove", ({ params }) =>
        Effect.gen(function*() {
          const current = yield* integrations.get(params.id)
          yield* integrations.remove(params.id)
          yield* hub.invalidate(toMcpConfig(current).key)
          for (const bot of yield* bots.list) {
            if (!bot.integrationIds.includes(params.id)) continue
            yield* Effect.orDie(bots.update(bot.id, { integrationIds: bot.integrationIds.filter((id) => id !== params.id) }))
          }
        }))
      .handle("test", ({ params }) => Effect.flatMap(integrations.get(params.id), test))
      .handle("testConfig", ({ payload }) =>
        payload.auth === "oauth" ? Effect.succeed(notSignedIn(payload.name)) : hub.test(draftToMcpConfig(payload)))
      .handle("oauthStart", ({ params, payload }) => oauth.start(params.id, payload.redirectUri))
      .handle("oauthFinish", ({ params, payload }) =>
        Effect.gen(function*() {
          const integration = yield* oauth.finish(params.id, payload.code, payload.state)
          yield* hub.invalidate(toMcpConfig(integration).key)
          return yield* test(integration)
        }))
      .handle("oauthSignOut", ({ params }) =>
        Effect.gen(function*() {
          yield* oauth.signOut(params.id)
          yield* hub.invalidate(toMcpConfig(yield* integrations.get(params.id)).key)
        }))
  })
)
