import { Schema } from "effect"

export class MemoryUnavailable extends Schema.TaggedError<MemoryUnavailable>()("MemoryUnavailable", {
  message: Schema.String
}, { httpApiStatus: 503 }) {}

export class MemoryProjectNotFound extends Schema.TaggedError<MemoryProjectNotFound>()("MemoryProjectNotFound", {
  name: Schema.String
}, { httpApiStatus: 404 }) {}

export class MemoryNoteNotFound extends Schema.TaggedError<MemoryNoteNotFound>()("MemoryNoteNotFound", {
  identifier: Schema.String
}, { httpApiStatus: 404 }) {}

export class MemoryVersionNotFound extends Schema.TaggedError<MemoryVersionNotFound>()("MemoryVersionNotFound", {
  id: Schema.String
}, { httpApiStatus: 404 }) {}

/** A Basic Memory project: a separate knowledge base, in its own folder of notes. */
export class MemoryProject extends Schema.Class<MemoryProject>("MemoryProject")({
  name: Schema.String,
  path: Schema.String,
  /** Basic Memory's own default, used by tools called without a project. */
  isDefault: Schema.Boolean,
  /** The project bots use unless they're given their own (`WEAVER_MEMORY_PROJECT`, or the default). */
  isShared: Schema.Boolean,
  /** Bots whose memory is in this project. */
  botIds: Schema.Array(Schema.String),
  /** Notes in it; null when the count couldn't be read. */
  notes: Schema.NullOr(Schema.Int)
}) {}

export class MemoryProjects extends Schema.Class<MemoryProjects>("MemoryProjects")({
  projects: Schema.Array(MemoryProject),
  /** Name of the shared project. */
  shared: Schema.String
}) {}

export const GraphCount = Schema.Struct({ name: Schema.String, count: Schema.Int })
export type GraphCount = typeof GraphCount.Type

export const GraphNote = Schema.Struct({ id: Schema.String, title: Schema.String })

export const GraphNode = Schema.Struct({
  /** The note's permalink. */
  id: Schema.String,
  title: Schema.String,
  type: Schema.String,
  /** Relations in and out, counting unresolved ones. */
  links: Schema.Int,
  observations: Schema.Int
})
export type GraphNode = typeof GraphNode.Type

export const GraphEdge = Schema.Struct({ source: Schema.String, target: Schema.String, type: Schema.String })
export type GraphEdge = typeof GraphEdge.Type

/** What a project's notes hold and how they connect, for the knowledge graph page. */
export class MemoryGraph extends Schema.Class<MemoryGraph>("MemoryGraph")({
  project: Schema.String,
  notes: Schema.Int,
  observations: Schema.Int,
  relations: Schema.Int,
  /** Relations pointing at notes that don't exist (yet). */
  unresolvedRelations: Schema.Int,
  /** Notes with no relations in or out. */
  unlinkedNotes: Schema.Int,
  /** Most common first. */
  noteTypes: Schema.Array(GraphCount),
  observationCategories: Schema.Array(GraphCount),
  relationTypes: Schema.Array(GraphCount),
  /** Some of the unlinked notes, newest first. */
  unlinked: Schema.Array(GraphNote),
  /** The best-connected notes, up to a limit, and the resolved relations between them. */
  nodes: Schema.Array(GraphNode),
  edges: Schema.Array(GraphEdge),
  /** Whether `nodes` leaves notes out. */
  truncated: Schema.Boolean,
  generatedAt: Schema.String
}) {}

/** One saved state of a note. */
export class NoteVersion extends Schema.Class<NoteVersion>("NoteVersion")({
  id: Schema.String,
  project: Schema.String,
  permalink: Schema.String,
  title: Schema.String,
  filePath: Schema.String,
  /** UTF-8 bytes. */
  size: Schema.Int,
  checksum: Schema.String,
  /** Who made the change: a bot's name, "You", or empty when it was noticed later (e.g. edited on disk). */
  source: Schema.String,
  /** The version this one was restored from. */
  restoredFrom: Schema.NullOr(Schema.String),
  /** When Weaver saved it. */
  createdAt: Schema.String
}) {}

export class NoteHistory extends Schema.Class<NoteHistory>("NoteHistory")({
  project: Schema.String,
  permalink: Schema.String,
  title: Schema.String,
  filePath: Schema.String,
  /** Newest first; the first one is the note as it is now. */
  versions: Schema.Array(NoteVersion)
}) {}

export class NoteVersionContent extends Schema.Class<NoteVersionContent>("NoteVersionContent")({
  version: NoteVersion,
  /** The whole file, frontmatter included. */
  content: Schema.String
}) {}
