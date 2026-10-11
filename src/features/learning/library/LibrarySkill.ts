import { Schema } from "effect"

export const LibraryAuthor = Schema.Literals(["user", "agent", "import"])
export type LibraryAuthor = typeof LibraryAuthor.Type

export const SkillSource = Schema.Struct({
  kind: Schema.Literals(["github", "url", "file", "bot", "catalog"]),
  url: Schema.optional(Schema.String),
  botId: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String)
})
export type SkillSource = typeof SkillSource.Type

export class LibrarySkillSummary extends Schema.Class<LibrarySkillSummary>("LibrarySkillSummary")({
  name: Schema.String,
  description: Schema.String,
  category: Schema.NullOr(Schema.String),
  createdBy: LibraryAuthor,
  source: Schema.NullOr(SkillSource),
  assignedBotIds: Schema.Array(Schema.String),
  useCount: Schema.Int,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String)
}) {}

export class LibrarySkillDetail extends Schema.Class<LibrarySkillDetail>("LibrarySkillDetail")({
  ...LibrarySkillSummary.fields,
  content: Schema.String,
  /** Every file besides SKILL.md, relative to the skill, e.g. `scripts/fill.py`. */
  files: Schema.Array(Schema.String)
}) {}

export const SkillWarning = Schema.Struct({
  file: Schema.String,
  finding: Schema.String
})
export type SkillWarning = typeof SkillWarning.Type

export class InstallResult extends Schema.Class<InstallResult>("InstallResult")({
  skill: Schema.NullOr(LibrarySkillDetail),
  warnings: Schema.Array(SkillWarning),
  installed: Schema.Boolean
}) {}

export const CatalogSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** The repository it's from, e.g. `anthropics/skills`. */
  source: Schema.String,
  /** Its folder on GitHub; install it by posting this to `/v1/skills/install`. */
  url: Schema.String,
  installed: Schema.Boolean
})
export type CatalogSkill = typeof CatalogSkill.Type

export class Catalog extends Schema.Class<Catalog>("Catalog")({
  skills: Schema.Array(CatalogSkill),
  sources: Schema.Array(Schema.String),
  error: Schema.optional(Schema.String)
}) {}

/** A skill folder's files, from a download, an upload or a zip, before it's checked. */
export interface SkillBundle {
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>
  /** The folder it came from, used for the name when SKILL.md doesn't give a usable one. */
  readonly folderName?: string | undefined
}
