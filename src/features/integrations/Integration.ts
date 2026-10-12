import { Schema } from "effect"

export const Transport = Schema.Literals(["stdio", "http"])
export type Transport = typeof Transport.Type

/** `oauth`: the server signs in to a hosted MCP server for the person (HTTP only). */
export const IntegrationAuth = Schema.Literals(["none", "oauth"])
export type IntegrationAuth = typeof IntegrationAuth.Type

export const OAuthStatus = Schema.Literals(["signed-in", "signed-out"])
export type OAuthStatus = typeof OAuthStatus.Type

/** Env and header values are secrets: the API returns this in their place and keeps the stored value when it's sent back. */
export const maskedValue = "********"

export class Integration extends Schema.Class<Integration>("Integration")({
  id: Schema.String,
  name: Schema.String,
  /** The Mac app's preset this came from (e.g. "github"), or null for a custom server. */
  presetId: Schema.NullOr(Schema.String),
  transport: Transport,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  enabled: Schema.Boolean,
  auth: IntegrationAuth,
  /** Null unless `auth` is `oauth`; `signed-in` while tokens are stored. */
  oauthStatus: Schema.NullOr(OAuthStatus),
  oauthSignedInAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

export const IntegrationCreate = Schema.Struct({
  name: Schema.NonEmptyString,
  presetId: Schema.optional(Schema.NullOr(Schema.String)),
  transport: Transport,
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  auth: Schema.optional(IntegrationAuth)
})
export type IntegrationCreate = typeof IntegrationCreate.Type

export const IntegrationUpdate = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  transport: Schema.optional(Transport),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  auth: Schema.optional(IntegrationAuth)
})
export type IntegrationUpdate = typeof IntegrationUpdate.Type

export class IntegrationTool extends Schema.Class<IntegrationTool>("IntegrationTool")({
  name: Schema.String,
  description: Schema.String
}) {}

export class IntegrationTestResult extends Schema.Class<IntegrationTestResult>("IntegrationTestResult")({
  ok: Schema.Boolean,
  tools: Schema.Array(IntegrationTool),
  error: Schema.NullOr(Schema.String)
}) {}

export const OAuthStartRequest = Schema.Struct({ redirectUri: Schema.String })

export class OAuthStart extends Schema.Class<OAuthStart>("OAuthStart")({
  /** Null when it's already signed in with working tokens. */
  authorizationUrl: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String)
}) {}

export const OAuthFinishRequest = Schema.Struct({ code: Schema.String, state: Schema.String })

export class IntegrationNotFound extends Schema.TaggedError<IntegrationNotFound>()("IntegrationNotFound", {
  id: Schema.String
}, { httpApiStatus: 404 }) {}

export const maskSecrets = (values: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.keys(values).map((key) => [key, maskedValue]))

/** Applies an update to stored secrets: masked values keep what's stored, missing keys are removed. */
export const mergeSecrets = (
  stored: Readonly<Record<string, string>>,
  incoming: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(incoming).map(([key, value]) => [key, value === maskedValue ? stored[key] ?? "" : value])
  )
