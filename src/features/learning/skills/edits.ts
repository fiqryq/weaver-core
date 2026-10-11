export interface SkillPatch {
  readonly old_string: string
  readonly new_string: string
  readonly replace_all?: boolean | undefined
  readonly file_path?: string | undefined
}

const countOf = (text: string, search: string): number => {
  let count = 0
  for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) count++
  return count
}

/** Applies `patch` to `content` (the file called `label`), or says why it can't be applied. */
export const applyPatch = (
  content: string,
  patch: SkillPatch,
  label: string
): { readonly updated: string; readonly count: number } | string => {
  const count = countOf(content, patch.old_string)
  if (count === 0) return `old_string wasn't found in ${label}. Load it with skill_view and copy the text exactly.`
  if (count > 1 && patch.replace_all !== true) {
    return `old_string appears ${count} times in ${label}; include more surrounding text, or set replace_all.`
  }
  const updated = patch.replace_all === true
    ? content.split(patch.old_string).join(patch.new_string)
    : content.replace(patch.old_string, () => patch.new_string)
  return { updated, count: patch.replace_all === true ? count : 1 }
}
