import { Schema } from "effect"

/** Who the bots work for. The Mac app sends this so prompts can address the person by name and in their timezone. */
export class Profile extends Schema.Class<Profile>("Profile")({
  displayName: Schema.String,
  email: Schema.String,
  timezone: Schema.String
}) {}

export const ProfileUpdate = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String)
})
export type ProfileUpdate = typeof ProfileUpdate.Type

export class Health extends Schema.Class<Health>("Health")({
  status: Schema.Literal("ok"),
  version: Schema.String,
  memory: Schema.Boolean,
  browser: Schema.Boolean
}) {}
