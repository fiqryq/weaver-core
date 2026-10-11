import { Schema } from "effect"

export class SkillNotFound extends Schema.TaggedError<SkillNotFound>()("SkillNotFound", {
  skill: Schema.String,
  message: Schema.String
}, { httpApiStatus: 404 }) {}

export class SkillInvalid extends Schema.TaggedError<SkillInvalid>()("SkillInvalid", {
  message: Schema.String
}) {}

export class SkillExists extends Schema.TaggedError<SkillExists>()("SkillExists", {
  skill: Schema.String,
  message: Schema.String
}) {}

/** The skills folder couldn't be read or written, or the bot was deleted. */
export class SkillStorageError extends Schema.TaggedError<SkillStorageError>()("SkillStorageError", {
  message: Schema.String
}) {}

export const notFound = (name: string) => new SkillNotFound({ skill: name, message: `There's no skill called "${name}".` })
export const invalid = (message: string) => new SkillInvalid({ message })
