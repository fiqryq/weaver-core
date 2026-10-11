import { Effect, Layer } from "effect"
import { IntegrationTestResult } from "../../src/features/integrations/Integration.ts"
import { type McpCallResult, type McpError, McpHub } from "../../src/features/integrations/McpHub.ts"

export interface MemoryCall {
  readonly name: string
  readonly args: Record<string, unknown>
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

const words = (text: string): Array<string> => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3)

/** `- [category] text` lines. */
const observationLines = (content: string) =>
  [...content.matchAll(/^- \[([^\]]+)\] (.+)$/gm)].map((match) => ({ category: match[1]!, text: match[2]! }))

/** `- relation_type [[Target]]` lines. */
const relationLines = (content: string) =>
  [...content.matchAll(/^- ([a-z_]+) \[\[([^\]]+)\]\]/gm)].map((match) => ({ type: match[1]!, target: match[2]! }))

/**
 * Basic Memory behind a fake McpHub: notes by permalink, answering read_note, write_note,
 * edit_note (append, find_replace), search_notes (by words, or filter-only for observations and
 * relations), list_directory and the project tools with JSON output the way Basic Memory 0.23 does.
 * Searches match notes sharing a word with the query and, like the real server, return permalinks
 * qualified with the project. Every note is in one project whatever the call asks for.
 */
export const fakeMemory = (initial: Record<string, string> = {}) => {
  const notes = new Map(Object.entries(initial))
  const titles = new Map<string, string>()
  /** Each note's `updated_at`, bumped on every change. */
  const updated = new Map<string, string>()
  const projects: Array<{ name: string; path: string; is_default: boolean }> = [
    { name: "main", path: "/home/weaver/basic-memory", is_default: true }
  ]
  let clock = Date.UTC(2026, 0, 1)
  const touch = (permalink: string) => updated.set(permalink, new Date(clock += 1000).toISOString())
  for (const permalink of notes.keys()) touch(permalink)
  const calls: Array<MemoryCall> = []
  const hooks: {
    before: (call: MemoryCall, index: number) => Effect.Effect<void, McpError>
    /** Answers instead of the fake when it returns a result. */
    answer: (call: MemoryCall) => McpCallResult | undefined
  } = {
    before: () => Effect.void,
    answer: () => undefined
  }
  const json = (value: unknown): McpCallResult => ({ text: JSON.stringify(value), isError: false })
  const titleOf = (permalink: string) => titles.get(permalink) ?? permalink.split("/").at(-1)!
  /** Finds a note by permalink, or by `folder/Title` the way `read_note` does. */
  const resolve = (identifier: string): string => {
    if (notes.has(identifier)) return identifier
    const parts = identifier.split("/")
    return [...parts.slice(0, -1), slug(parts.at(-1) ?? "")].join("/")
  }
  const permalinkOf = (title: string) =>
    [...notes.keys()].find((permalink) => titleOf(permalink).toLowerCase() === title.toLowerCase())

  const handle = ({ name, args }: MemoryCall): McpCallResult => {
    const identifier = resolve(String(args.identifier ?? ""))
    switch (name) {
      case "read_note": {
        const content = notes.get(identifier)
        return json(
          content === undefined
            ? { title: null, permalink: null, content: null }
            : { title: titleOf(identifier), permalink: identifier, file_path: `${identifier}.md`, content }
        )
      }
      case "write_note": {
        const directory = String(args.directory ?? "")
        const permalink = `${directory.length > 0 ? `${directory}/` : ""}${slug(String(args.title))}`
        if (notes.has(permalink) && args.overwrite !== true) {
          return json({ permalink, action: "conflict", error: "NOTE_ALREADY_EXISTS" })
        }
        notes.set(permalink, String(args.content))
        titles.set(permalink, String(args.title))
        touch(permalink)
        return json({ title: args.title, permalink, action: "created" })
      }
      case "edit_note": {
        const content = notes.get(identifier)
        const update = String(args.content)
        if (args.operation === "append") {
          notes.set(identifier, content === undefined ? update : `${content}\n${update}`)
          touch(identifier)
          return json({ permalink: identifier, operation: "append" })
        }
        if (args.operation === "find_replace") {
          if (content === undefined) return json({ operation: "find_replace", error: `Entity not found: '${identifier}'` })
          const parts = content.split(String(args.find_text))
          const expected = args.expected_replacements ?? 1
          if (parts.length - 1 !== expected) {
            return json({
              operation: "find_replace",
              error: `Expected ${String(expected)} occurrences, but found ${parts.length - 1}`
            })
          }
          notes.set(identifier, parts.join(update))
          touch(identifier)
          return json({ permalink: identifier, operation: "find_replace" })
        }
        return { text: `Unsupported operation ${String(args.operation)}`, isError: true }
      }
      case "search_notes": {
        const types = Array.isArray(args.entity_types) ? args.entity_types : []
        if (args.query === undefined && types.length === 1 && (types[0] === "observation" || types[0] === "relation")) {
          const results = [...notes].flatMap(([permalink, content]): Array<Record<string, unknown>> =>
            types[0] === "observation"
              ? observationLines(content).map((line, index) => ({
                type: "observation",
                entity: permalink,
                permalink: `${permalink}/observations/${index}`,
                observation_id: `${permalink}#${index}`,
                category: line.category,
                content: line.text
              }))
              : relationLines(content).map((line, index) => {
                const target = permalinkOf(line.target)
                return {
                  type: "relation",
                  entity: permalink,
                  permalink: `${permalink}/${line.type}/${index}`,
                  relation_id: `${permalink}#${index}`,
                  from_entity: permalink,
                  relation_type: line.type,
                  ...(target === undefined ? {} : { to_entity: target })
                }
              })
          )
          return json({ results, current_page: 1, page_size: results.length, total: results.length, has_more: false })
        }
        const query = new Set(words(String(args.query ?? "")))
        const project = typeof args.project === "string" && args.project.length > 0 ? `${args.project}/` : ""
        const pageSize = typeof args.page_size === "number" ? args.page_size : 10
        const found = [...notes].filter(([permalink, content]) =>
          words(`${titles.get(permalink) ?? permalink} ${content}`).some((word) => query.has(word))
        )
        const results = found.slice(0, pageSize).map(([permalink, content], index) => ({
          title: titles.get(permalink) ?? permalink.split("/").at(-1),
          type: "entity",
          score: -1 - index,
          entity: `${project}${permalink}`,
          permalink: `${project}${permalink}`,
          content,
          file_path: `${permalink}.md`,
          metadata: { note_type: "note" }
        }))
        if (args.output_format !== "json") {
          return { text: `# Search Results\n\n${results.map((r) => `## ${r.title}\n${r.content}`).join("\n\n")}`, isError: false }
        }
        return json({
          results,
          current_page: 1,
          page_size: pageSize,
          total: found.length,
          total_is_exact: true,
          has_more: found.length > pageSize
        })
      }
      case "list_directory": {
        const pageSize = typeof args.page_size === "number" ? args.page_size : 10
        const page = typeof args.page === "number" ? args.page : 1
        const all = [...notes.keys()].map((permalink) => ({
          name: `${titleOf(permalink)}.md`,
          type: "file",
          children: [],
          title: titleOf(permalink),
          permalink,
          file_path: `${permalink}.md`,
          note_type: "note",
          updated_at: updated.get(permalink)
        }))
        return json({
          nodes: all.slice((page - 1) * pageSize, page * pageSize),
          page,
          page_size: pageSize,
          total: all.length,
          has_more: page * pageSize < all.length
        })
      }
      case "list_memory_projects":
        return json({ projects, default_project: projects.find((project) => project.is_default)?.name })
      case "create_memory_project": {
        const projectName = String(args.project_name)
        if (projects.some((project) => project.name === projectName)) {
          return { text: `Project '${projectName}' already exists`, isError: true }
        }
        projects.push({ name: projectName, path: String(args.project_path), is_default: false })
        return json({ name: projectName, path: args.project_path, is_default: false, created: true })
      }
      case "delete_project": {
        const index = projects.findIndex((project) => project.name === args.project_name)
        if (index === -1) return { text: `Project '${String(args.project_name)}' not found`, isError: true }
        projects.splice(index, 1)
        return { text: `Project '${String(args.project_name)}' removed`, isError: false }
      }
      default:
        return { text: `Unknown tool ${name}`, isError: true }
    }
  }

  const layer = Layer.succeed(
    McpHub,
    McpHub.of({
      tools: () =>
        Effect.succeed(
          ["search_notes", "read_note", "write_note", "edit_note"].map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} }
          }))
        ),
      call: (_server, name, args) =>
        Effect.suspend(() => {
          const call = { name, args }
          calls.push(call)
          return Effect.andThen(hooks.before(call, calls.length - 1), Effect.sync(() => hooks.answer(call) ?? handle(call)))
        }),
      test: () => Effect.succeed(new IntegrationTestResult({ ok: true, tools: [], error: null })),
      invalidate: () => Effect.void
    })
  )
  /** Changes a note the way an edit outside Weaver would. */
  const editOutside = (permalink: string, content: string) => {
    notes.set(permalink, content)
    touch(permalink)
  }
  return { notes, titles, projects, calls, hooks, layer, editOutside }
}

export type FakeMemory = ReturnType<typeof fakeMemory>
