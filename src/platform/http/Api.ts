import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { BotsApi } from "../../features/bots/api.ts"
import { ConversationsApi } from "../../features/conversations/api.ts"
import { IntegrationsApi } from "../../features/integrations/api.ts"
import { LibraryApi, SkillsApi } from "../../features/learning/api.ts"
import { MemoryApi } from "../../features/memory/api.ts"
import { ProfileApi } from "../../features/profile/api.ts"
import { Health } from "../../features/profile/Profile.ts"
import { ProvidersApi } from "../../features/providers/api.ts"
import { RunsApi } from "../../features/runs/api.ts"
import { TeamsApi } from "../../features/teams/api.ts"
import { UpdatesApi } from "../../features/updates/api.ts"

export class SystemApi extends HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("health", "/health", { success: Health }))
  .prefix("/v1")
{}

export class Api extends HttpApi.make("weaver")
  .add(SystemApi)
  .add(ProfileApi)
  .add(BotsApi)
  .add(SkillsApi)
  .add(LibraryApi)
  .add(ConversationsApi)
  .add(RunsApi)
  .add(ProvidersApi)
  .add(IntegrationsApi)
  .add(MemoryApi)
  .add(TeamsApi)
  .add(UpdatesApi)
  .annotateMerge(OpenApi.annotations({ title: "Weaver agent server" }))
{}
