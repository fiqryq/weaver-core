export const maxNameLength = 64
export const maxDescriptionLength = 1024
/** New skills' descriptions must fit the prompt index without being cut. */
export const indexDescriptionLength = 60
export const maxSkillChars = 100_000

export const validName = /^[a-z0-9][a-z0-9._-]*$/
const nameRule = "Use lowercase letters, numbers, hyphens, dots, and underscores, starting with a letter or digit."

export const validateName = (name: string): string | undefined => {
  if (name.length === 0) return "A skill name is required."
  if (name.length > maxNameLength) return `The skill name is longer than ${maxNameLength} characters.`
  return validName.test(name) ? undefined : `"${name}" isn't a valid skill name. ${nameRule}`
}

export const validateCategory = (category: string): string | undefined => {
  if (category.length === 0) return undefined
  if (category.length > maxNameLength) return `The category is longer than ${maxNameLength} characters.`
  return validName.test(category)
    ? undefined
    : `"${category}" isn't a valid category. ${nameRule} A category is a single folder name.`
}

type Frontmatter = { readonly fields: Record<string, unknown>; readonly body: string }

export const parseFrontmatter = (content: string): Frontmatter | string => {
  const text = content.replace(/^\uFEFF/, "")
  if (!text.startsWith("---")) return "SKILL.md must start with YAML frontmatter (a line with ---, then name: and description:, then ---)."
  const end = /\n---\s*\n/.exec(text.slice(3))
  if (end === null) return "SKILL.md frontmatter isn't closed. Add a line with --- after it."
  let fields: unknown
  try {
    fields = Bun.YAML.parse(text.slice(3, end.index + 3))
  } catch (cause) {
    return `The YAML frontmatter couldn't be parsed: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return "The frontmatter must be YAML key: value pairs."
  }
  return { fields: fields as Record<string, unknown>, body: text.slice(end.index + 3 + end[0].length) }
}

export const fieldText = (value: unknown): string =>
  value === undefined || value === null ? "" : String(value).trim().replace(/^["']|["']$/g, "")

/** Checks a whole SKILL.md for `name`; `fitIndex` also holds the description to the prompt-index budget, for skills the bot creates. */
export const validateSkillMd = (name: string, content: string, fitIndex: boolean): string | undefined => {
  if (content.trim().length === 0) return "SKILL.md can't be empty."
  if (content.length > maxSkillChars) {
    return `SKILL.md is ${content.length.toLocaleString("en-US")} characters (limit ${maxSkillChars.toLocaleString("en-US")}). ` +
      `Keep SKILL.md short and move detail into supporting files under references/ or templates/.`
  }
  const parsed = parseFrontmatter(content)
  if (typeof parsed === "string") return parsed
  for (const field of ["name", "description"]) {
    if (!(field in parsed.fields)) return `The frontmatter must include "${field}:".`
  }
  const declared = fieldText(parsed.fields.name)
  if (declared !== name) return `The frontmatter name is "${declared}" but the skill is called "${name}"; they must match.`
  const description = fieldText(parsed.fields.description)
  if (description.length > maxDescriptionLength) return `The description is longer than ${maxDescriptionLength} characters.`
  if (fitIndex && description.length > indexDescriptionLength) {
    return `The description is ${description.length} characters; a new skill's description must fit in ${indexDescriptionLength} ` +
      `so it shows in full in your skill list. Write one sentence that says when to use it ` +
      `("Use when <trigger>. <what it does>.") and move the detail into the body.`
  }
  if (parsed.body.trim().length === 0) return "SKILL.md needs instructions after the frontmatter."
  return undefined
}

/** SKILL.md with its frontmatter `name:` set to `name` (added if missing); unchanged without frontmatter. */
export const withName = (content: string, name: string): string => {
  const text = content.replace(/^\uFEFF/, "")
  const end = text.startsWith("---") ? /\n---\s*\n/.exec(text.slice(3)) : null
  if (end === null) return content
  const head = text.slice(0, end.index + 3)
  const renamed = /^name:.*$/m.test(head)
    ? head.replace(/^name:.*$/m, () => `name: ${name}`)
    : head.replace(/^---[^\n]*/, (line) => `${line}\nname: ${name}`)
  return renamed + text.slice(end.index + 3)
}

export const truncateDescription = (description: string): string => {
  const single = description.replace(/\s+/g, " ").trim()
  return single.length <= indexDescriptionLength ? single : `${single.slice(0, indexDescriptionLength - 1)}…`
}
