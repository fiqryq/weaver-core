import { dirname } from "node:path"
import { Predicate } from "effect"

/**
 * Readers for Basic Memory's JSON tool output (0.23). They're lenient: a missing or renamed field
 * drops that row instead of failing the whole answer, since the server's format moves between releases.
 */

type Row = Record<string, unknown>

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const asRow = (value: unknown): Row | undefined =>
  Predicate.isObject(value) && !Array.isArray(value) ? value as Row : undefined

const rows = (value: unknown): ReadonlyArray<Row> =>
  Array.isArray(value)
    ? value.flatMap((item: unknown): Array<Row> => {
      const row = asRow(item)
      return row === undefined ? [] : [row]
    })
    : []

const text = (row: Row, key: string): string | undefined => {
  const value = row[key]
  return Predicate.isString(value) && value.length > 0 ? value : undefined
}

const id = (row: Row, key: string): string | undefined => {
  const value = row[key]
  return Predicate.isNumber(value) ? String(value) : text(row, key)
}

export interface ProjectListing {
  readonly name: string
  readonly path: string
  readonly isDefault: boolean
}

/** `list_memory_projects`; undefined when the answer isn't the expected JSON. */
export const projectListing = (
  output: string
): { readonly projects: ReadonlyArray<ProjectListing>; readonly defaultProject: string | undefined } | undefined => {
  const root = asRow(parse(output))
  if (root === undefined || !Array.isArray(root.projects)) return undefined
  const projects = rows(root.projects).flatMap((row): Array<ProjectListing> => {
    const name = text(row, "name")
    return name === undefined
      ? []
      : [{ name, path: text(row, "path") ?? text(row, "local_path") ?? "", isDefault: row.is_default === true }]
  })
  return { projects, defaultProject: text(root, "default_project") ?? projects.find((project) => project.isDefault)?.name }
}

/** `create_memory_project`; undefined when it didn't say it created the project. */
export const createdProject = (output: string): ProjectListing | undefined => {
  const row = asRow(parse(output))
  const name = row === undefined ? undefined : text(row, "name")
  if (row === undefined || name === undefined) return undefined
  return { name, path: text(row, "path") ?? "", isDefault: row.is_default === true }
}

export interface NoteListing {
  readonly permalink: string
  readonly title: string
  readonly filePath: string
  readonly noteType: string
  readonly updatedAt: string
}

export interface Page<A> {
  readonly items: ReadonlyArray<A>
  readonly hasMore: boolean
  readonly total: number | undefined
}

const files = (nodes: ReadonlyArray<Row>): Array<NoteListing> =>
  nodes.flatMap((node) => {
    const nested = files(rows(node.children))
    const permalink = text(node, "permalink")
    const filePath = text(node, "file_path")
    if (node.type !== "file" || permalink === undefined || filePath === undefined) return nested
    return [{
      permalink,
      title: text(node, "title") ?? filePath.replace(/^.*\//, "").replace(/\.md$/, ""),
      filePath,
      noteType: text(node, "note_type") ?? "note",
      updatedAt: text(node, "updated_at") ?? ""
    }, ...nested]
  })

/** One page of `list_directory`, its files flattened; undefined when the answer isn't the expected JSON. */
export const directoryPage = (output: string): Page<NoteListing> | undefined => {
  const root = asRow(parse(output))
  if (root === undefined || !Array.isArray(root.nodes)) return undefined
  return {
    items: files(rows(root.nodes)),
    hasMore: root.has_more === true,
    total: Predicate.isNumber(root.total) ? root.total : undefined
  }
}

export interface ObservationRow {
  readonly id: string
  readonly note: string
  readonly category: string
}

export interface RelationRow {
  readonly id: string
  readonly from: string
  /** Undefined when the link points at a note that doesn't exist. */
  readonly to: string | undefined
  readonly type: string
}

const searchPage = <A>(output: string, row: (row: Row) => A | undefined): Page<A> | undefined => {
  const root = asRow(parse(output))
  if (root === undefined || !Array.isArray(root.results)) return undefined
  return {
    items: rows(root.results).flatMap((result) => row(result) ?? []),
    hasMore: root.has_more === true,
    total: Predicate.isNumber(root.total) ? root.total : undefined
  }
}

/** One page of a filter-only `search_notes` for observations. */
export const observationPage = (output: string): Page<ObservationRow> | undefined =>
  searchPage(output, (row) => {
    const note = text(row, "entity")
    const key = id(row, "observation_id") ?? text(row, "permalink")
    if (row.type !== "observation" || note === undefined || key === undefined) return undefined
    return { id: key, note, category: text(row, "category") ?? "note" }
  })

/** One page of a filter-only `search_notes` for relations. */
export const relationPage = (output: string): Page<RelationRow> | undefined =>
  searchPage(output, (row) => {
    const from = text(row, "from_entity") ?? text(row, "entity")
    const key = id(row, "relation_id") ?? text(row, "permalink")
    if (row.type !== "relation" || from === undefined || key === undefined) return undefined
    return { id: key, from, to: text(row, "to_entity"), type: text(row, "relation_type") ?? "relates_to" }
  })

export interface NoteFile {
  readonly title: string
  readonly permalink: string
  readonly filePath: string
  /** The whole file, frontmatter included when the server sent it. */
  readonly content: string
}

/** `read_note` with JSON output; undefined when the note doesn't exist. */
export const noteFile = (output: string): NoteFile | undefined => {
  const row = asRow(parse(output))
  if (row === undefined) return undefined
  const title = text(row, "title")
  const permalink = text(row, "permalink")
  const content = row.content
  if (title === undefined || permalink === undefined || !Predicate.isString(content)) return undefined
  return { title, permalink, filePath: text(row, "file_path") ?? "", content }
}

/** Projects can't share a folder tree, so new ones go next to the default project's folder. */
export const projectsFolder = (defaultPath: string): string => `${dirname(defaultPath.replace(/\/+$/, ""))}/basic-memory-projects`

/** A folder name for a project, e.g. "Moby Dick" → "moby-dick". */
export const projectSlug = (name: string): string =>
  name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)

/** Where `write_note` puts a note so it lands on `filePath` again: its folder, or "" for the top. */
export const noteDirectory = (filePath: string): string => {
  const folder = dirname(filePath)
  return folder === "." || folder === "/" ? "" : folder
}
