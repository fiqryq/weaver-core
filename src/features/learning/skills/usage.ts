import { Schema } from "effect"
import { SkillAuthor } from "./Skill.ts"

export const usageFile = ".usage.json"

const UsageRecord = Schema.Struct({
  createdBy: SkillAuthor,
  useCount: Schema.Int,
  viewCount: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String)
})
type UsageRecord = typeof UsageRecord.Type
export type Usage = Record<string, UsageRecord>
const isUsageRecord = Schema.is(UsageRecord)

export const parseUsage = (text: string | undefined): Usage => {
  if (text === undefined) return {}
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== "object" || raw === null) return {}
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, UsageRecord] => isUsageRecord(entry[1])))
  } catch {
    return {}
  }
}
