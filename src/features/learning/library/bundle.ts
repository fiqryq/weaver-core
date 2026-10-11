import { maxFileBytes, skillFile, validateFilePath } from "../skills/files.ts"
import { fieldText, parseFrontmatter, validateName, validateSkillMd, withName } from "../skills/frontmatter.ts"
import { scanThreats, threatLabel } from "../skills/threats.ts"
import type { SkillBundle, SkillWarning } from "./LibrarySkill.ts"
import { isJunkPath } from "./zip.ts"

export const maxSkillFiles = 300
export const maxSkillBytes = 10 * 1024 * 1024
export const limits = { maxFiles: maxSkillFiles, maxFileBytes, maxTotalBytes: maxSkillBytes }

/** Names the API's own routes take under `/v1/skills/`. */
export const reservedNames: ReadonlySet<string> = new Set(["catalog", "install", "import", "promote"])

export interface PreparedSkill {
  readonly name: string
  readonly content: string
  /** Supporting files, SKILL.md left out. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>
  readonly warnings: ReadonlyArray<SkillWarning>
}

const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, 8192).includes(0)

/** What the threat scan finds in each text file of a skill. */
export const scanFiles = (files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>): Array<SkillWarning> =>
  files.flatMap(({ bytes, path }) =>
    isBinary(bytes) ? [] : scanThreats(new TextDecoder().decode(bytes)).map((id) => ({ file: path, finding: threatLabel(id) }))
  )

/**
 * Checks a skill folder from an install or import and names it: SKILL.md at the top or in one folder at
 * the top, supporting files at any safe relative path, within the size limits. The name is `name`, else
 * SKILL.md's, else the folder's; SKILL.md's frontmatter is set to match.
 */
export const prepareBundle = (bundle: SkillBundle, name?: string): PreparedSkill | string => {
  let folderName = bundle.folderName
  let files = bundle.files
    .map((file) => ({ path: file.path.replace(/\\/g, "/").replace(/^(\.\/)+/, ""), bytes: file.bytes }))
    .filter((file) => file.path.length > 0 && !file.path.endsWith("/") && !isJunkPath(file.path))
  if (!files.some((file) => file.path === skillFile)) {
    const top = files[0]?.path.split("/")[0]
    if (top === undefined || !files.every((file) => file.path.startsWith(`${top}/`)) || !files.some((file) => file.path === `${top}/${skillFile}`)) {
      return `There's no ${skillFile} at the top of the skill (or in a single folder at the top).`
    }
    files = files.map((file) => ({ path: file.path.slice(top.length + 1), bytes: file.bytes }))
    folderName = top
  }
  if (files.length > maxSkillFiles) return `The skill has ${files.length} files; the limit is ${maxSkillFiles}.`
  let total = 0
  const paths = new Set<string>()
  for (const file of files) {
    if (file.path !== skillFile) {
      const problem = validateFilePath(file.path, true)
      if (problem !== undefined) return problem.replace(/^file_path/, `"${file.path}"`)
    }
    if (file.bytes.length > maxFileBytes) return `"${file.path}" is larger than 1 MiB.`
    total += file.bytes.length
    if (paths.has(file.path)) return `"${file.path}" is in the skill twice.`
    paths.add(file.path)
  }
  if (total > maxSkillBytes) return "The skill is larger than 10 MiB."
  for (const path of paths) {
    const segments = path.split("/")
    for (let index = 1; index < segments.length; index++) {
      const folder = segments.slice(0, index).join("/")
      if (paths.has(folder)) return `"${folder}" is both a file and a folder.`
    }
  }

  const original = new TextDecoder().decode(files.find((file) => file.path === skillFile)!.bytes)
  const parsed = parseFrontmatter(original)
  if (typeof parsed === "string") return parsed
  const declared = fieldText(parsed.fields.name)
  const chosen = name?.trim() ||
    [declared, folderName ?? ""].find((candidate) => validateName(candidate) === undefined) ||
    declared
  const problem = validateName(chosen)
  if (problem !== undefined) return name?.trim() ? problem : `${problem} Give the skill a name to install it under.`
  if (reservedNames.has(chosen)) return `"${chosen}" can't be used as a library skill name. Pick another name.`
  const content = declared === chosen ? original : withName(original, chosen)
  const invalidSkill = validateSkillMd(chosen, content, false)
  if (invalidSkill !== undefined) return invalidSkill

  const supporting = files.filter((file) => file.path !== skillFile).sort((a, b) => a.path.localeCompare(b.path))
  return {
    name: chosen,
    content,
    files: supporting,
    warnings: scanFiles([{ path: skillFile, bytes: new TextEncoder().encode(content) }, ...supporting])
  }
}
