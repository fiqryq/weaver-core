import type { NoteListing, ObservationRow, RelationRow } from "./basicMemory.ts"
import { type GraphCount, type GraphEdge, type GraphNode, MemoryGraph } from "./Memory.ts"

/** Notes drawn on the graph map; past this, the best-connected ones. */
export const maxGraphNodes = 400
const maxUnlinked = 50

const uniqueBy = <A>(items: ReadonlyArray<A>, key: (item: A) => string): Array<A> => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    return seen.has(k) ? false : (seen.add(k), true)
  })
}

const tally = (names: Iterable<string>): Array<GraphCount> => {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/**
 * Summarizes a project from its notes, observations and relations. Basic Memory's search can list a
 * row more than once, so rows are counted once per id.
 */
export const buildGraph = (input: {
  readonly project: string
  readonly notes: ReadonlyArray<NoteListing>
  readonly observations: ReadonlyArray<ObservationRow>
  readonly relations: ReadonlyArray<RelationRow>
  readonly generatedAt: string
}, maxNodes = maxGraphNodes): MemoryGraph => {
  const notes = uniqueBy(input.notes, (note) => note.permalink)
  const observations = uniqueBy(input.observations, (observation) => observation.id)
  const relations = uniqueBy(input.relations, (relation) => relation.id)

  const observationsByNote = new Map<string, number>()
  for (const observation of observations) {
    observationsByNote.set(observation.note, (observationsByNote.get(observation.note) ?? 0) + 1)
  }
  const links = new Map<string, number>()
  const bump = (permalink: string) => links.set(permalink, (links.get(permalink) ?? 0) + 1)
  for (const relation of relations) {
    bump(relation.from)
    if (relation.to !== undefined && relation.to !== relation.from) bump(relation.to)
  }

  const unlinked = notes
    .filter((note) => !links.has(note.permalink))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  const ranked = [...notes].sort((a, b) =>
    (links.get(b.permalink) ?? 0) - (links.get(a.permalink) ?? 0) ||
    (observationsByNote.get(b.permalink) ?? 0) - (observationsByNote.get(a.permalink) ?? 0) ||
    a.title.localeCompare(b.title)
  )
  const nodes: Array<GraphNode> = ranked.slice(0, maxNodes).map((note) => ({
    id: note.permalink,
    title: note.title,
    type: note.noteType,
    links: links.get(note.permalink) ?? 0,
    observations: observationsByNote.get(note.permalink) ?? 0
  }))
  const drawn = new Set(nodes.map((node) => node.id))
  const edges: Array<GraphEdge> = uniqueBy(
    relations.flatMap((relation): Array<GraphEdge> =>
      relation.to !== undefined && relation.to !== relation.from && drawn.has(relation.from) && drawn.has(relation.to)
        ? [{ source: relation.from, target: relation.to, type: relation.type }]
        : []
    ),
    (edge) => `${edge.source}\n${edge.target}\n${edge.type}`
  )

  return new MemoryGraph({
    project: input.project,
    notes: notes.length,
    observations: observations.length,
    relations: relations.length,
    unresolvedRelations: relations.filter((relation) => relation.to === undefined).length,
    unlinkedNotes: unlinked.length,
    noteTypes: tally(notes.map((note) => note.noteType)),
    observationCategories: tally(observations.map((observation) => observation.category)),
    relationTypes: tally(relations.map((relation) => relation.type)),
    unlinked: unlinked.slice(0, maxUnlinked).map((note) => ({ id: note.permalink, title: note.title })),
    nodes,
    edges,
    truncated: notes.length > nodes.length,
    generatedAt: input.generatedAt
  })
}
