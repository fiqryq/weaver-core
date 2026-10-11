import { Schema } from "effect"

export const SkillAuthor = Schema.Literals(["agent", "user"])
export type SkillAuthor = typeof SkillAuthor.Type

export class SkillSummary extends Schema.Class<SkillSummary>("SkillSummary")({
  name: Schema.String,
  description: Schema.String,
  /** Empty when the skill isn't in a category. */
  category: Schema.String,
  createdBy: SkillAuthor,
  useCount: Schema.Int,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String)
}) {}

export class SkillDetail extends Schema.Class<SkillDetail>("SkillDetail")({
  ...SkillSummary.fields,
  content: Schema.String,
  /** Supporting files, relative to the skill, e.g. `references/api.md`. */
  files: Schema.Array(Schema.String)
}) {}
