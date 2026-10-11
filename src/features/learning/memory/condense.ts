import type { Prompt } from "effect/ai"
import { coreTitle } from "../../../tools/builtin/Memory.ts"
import { scanThreats } from "../skills/threats.ts"

/** The condensed note should fit in this share of the threshold, so it has room to grow again. */
export const condenseTarget = 0.6
/** A rewrite shorter than this share of the original dropped facts instead of condensing them. */
export const condenseFloor = 0.25

const attribution = /\(via\s[^)]*\)/

const lines = (text: string): Array<string> =>
  text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)

const isFact = (line: string): boolean => line.startsWith("- [")

export const condensePrompt = (text: string, threshold: number): Array<Prompt.MessageEncoded> => [
  {
    role: "system",
    content: `You condense "${coreTitle}", a shared Markdown note of durable facts about the user that every one of ` +
      `their bots reads at the start of each reply. Rewrite it as a compact list:\n` +
      `- Merge duplicates and near-duplicates into one line.\n` +
      `- When facts conflict, keep the newest and drop the one it supersedes. Later lines are newer.\n` +
      `- Keep every other distinct durable fact. Never add facts, and add no commentary.\n` +
      `- Keep the line shape "- [category] text (via Bot)" and its attribution; when you merge lines from ` +
      `different bots, merge the attributions, like "(via Ada, Bo)".\n` +
      `- Keep every heading and section. Keep every line without "(via …)" exactly as it is, character for ` +
      `character: the user wrote those by hand. Only drop one when it's an exact duplicate of another.\n` +
      `- Keep each fact to one short line. Aim for under ${Math.round(threshold * condenseTarget)} characters in total.\n` +
      `Answer with only the new note body: no code fence, no preface, no explanation.`
  },
  { role: "user", content: `${coreTitle} now, oldest lines first:\n\n${text}` }
]

/** The model's answer as a note body, without a code fence around it. */
export const condensedBody = (answer: string): string => {
  const trimmed = answer.trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(trimmed)
  return (fenced?.[1] ?? trimmed).trim()
}

/** Why a condensed note can't replace the original, or undefined when it can. */
export const condenseRejection = (original: string, condensed: string): string | undefined => {
  const before = original.trim()
  if (condensed.length === 0) return "the model returned nothing"
  if (condensed.length >= before.length) return `it isn't shorter (${condensed.length} of ${before.length} characters)`
  if (condensed.length < before.length * condenseFloor) {
    return `it dropped too much (${condensed.length} of ${before.length} characters left)`
  }
  const kept = new Set(lines(condensed))
  const handwritten = lines(before).find((line) => !attribution.test(line) && !kept.has(line))
  if (handwritten !== undefined) return `it changed or dropped a line written by hand: "${handwritten.slice(0, 80)}"`
  if (lines(before).some(isFact) && !lines(condensed).some(isFact)) return `it has no "- [category] fact" lines left`
  const existing = new Set(scanThreats(before))
  const threat = scanThreats(condensed).find((id) => !existing.has(id))
  if (threat !== undefined) return `it added text matching the threat pattern "${threat}"`
  return undefined
}

const pad = (value: number): string => String(value).padStart(2, "0")

/** Title of the note that keeps Core Memory's previous text, in the server's local time. */
export const backupTitle = (date: Date): string =>
  `${coreTitle} before condensing ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}`
