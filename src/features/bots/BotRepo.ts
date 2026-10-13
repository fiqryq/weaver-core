import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { decodeStringArray, newId, nowIso } from "../../platform/lib/util.ts"
import {
  ApprovalMode,
  Bot,
  type BotCreate,
  BotNotFound,
  BuiltinTool,
  type BotUpdate,
  defaultMaxSteps,
  defaultSystemPrompt,
  defaultTools
} from "./Bot.ts"

interface BotRow {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly system_prompt: string
  readonly provider_id: string
  readonly model: string
  readonly mascot_id: string
  readonly color_hex: string
  readonly symbol: string
  readonly tools: string
  readonly approval_mode: string
  readonly max_steps: number
  readonly integration_ids: string
  readonly teammate_ids: string
  readonly library_skills: string
  readonly memory_project: string
  readonly created_at: string
  readonly updated_at: string
}

const isTool = Schema.is(BuiltinTool)
const isApprovalMode = Schema.is(ApprovalMode)

const fromRow = (row: BotRow): Bot =>
  new Bot({
    id: row.id,
    name: row.name,
    label: row.label,
    systemPrompt: row.system_prompt,
    providerId: row.provider_id,
    model: row.model,
    mascotId: row.mascot_id,
    colorHex: row.color_hex,
    symbol: row.symbol,
    tools: decodeStringArray(row.tools).filter(isTool),
    approvalMode: isApprovalMode(row.approval_mode) ? row.approval_mode : "ask",
    maxSteps: row.max_steps,
    integrationIds: decodeStringArray(row.integration_ids),
    teammateIds: decodeStringArray(row.teammate_ids),
    librarySkills: decodeStringArray(row.library_skills),
    memoryProject: row.memory_project,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })

const clampSteps = (steps: number) => Math.min(Math.max(Math.trunc(steps), 1), 100)

export class BotRepo extends Context.Service<BotRepo, {
  readonly list: Effect.Effect<ReadonlyArray<Bot>>
  get(id: string): Effect.Effect<Bot, BotNotFound>
  create(input: BotCreate): Effect.Effect<Bot>
  update(id: string, input: BotUpdate): Effect.Effect<Bot, BotNotFound>
  /**
   * Deletes the bot with its one-on-one chats and its handoffs, and takes it off other bots' teammates.
   * Group chats keep its past messages and the other bots.
   */
  remove(id: string): Effect.Effect<void, BotNotFound>
  /**
   * Gives library skill `name` to exactly `botIds` (unknown ids are skipped), or with `only: false`
   * adds it to them and leaves other bots as they are. Returns whether any bot changed.
   */
  assignLibrarySkill(name: string, botIds: ReadonlyArray<string>, options?: { readonly only?: boolean }): Effect.Effect<boolean>
}>()("weaver/BotRepo") {
  static readonly layer = Layer.effect(
    BotRepo,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const list = sql<BotRow>`SELECT * FROM bots ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.orDie
      )

      const get = Effect.fn("BotRepo.get")(function*(id: string) {
        const rows = yield* sql<BotRow>`SELECT * FROM bots WHERE id = ${id}`.pipe(Effect.orDie)
        const row = rows[0]
        if (row === undefined) return yield* new BotNotFound({ id })
        return fromRow(row)
      })

      const create = Effect.fn("BotRepo.create")(function*(input: BotCreate) {
        const id = newId()
        const now = yield* nowIso
        yield* sql`INSERT INTO bots ${
          sql.insert({
            id,
            name: input.name.trim(),
            label: input.label ?? "",
            system_prompt: input.systemPrompt ?? defaultSystemPrompt,
            provider_id: input.providerId ?? "",
            model: input.model ?? "",
            mascot_id: input.mascotId ?? "",
            color_hex: input.colorHex ?? "#EC5BA8",
            symbol: input.symbol ?? "sparkle",
            tools: JSON.stringify(input.tools ?? defaultTools),
            approval_mode: input.approvalMode ?? "ask",
            max_steps: clampSteps(input.maxSteps ?? defaultMaxSteps),
            integration_ids: JSON.stringify(input.integrationIds ?? []),
            teammate_ids: JSON.stringify([...new Set(input.teammateIds ?? [])]),
            library_skills: JSON.stringify([...new Set(input.librarySkills ?? [])]),
            memory_project: input.memoryProject?.trim() ?? "",
            created_at: now,
            updated_at: now
          })
        }`.pipe(Effect.orDie)
        return yield* Effect.orDie(get(id))
      })

      const update = Effect.fn("BotRepo.update")(function*(id: string, input: BotUpdate) {
        yield* get(id)
        const changes: Record<string, string | number> = { updated_at: yield* nowIso }
        if (input.name !== undefined) changes.name = input.name.trim()
        if (input.label !== undefined) changes.label = input.label
        if (input.systemPrompt !== undefined) changes.system_prompt = input.systemPrompt
        if (input.providerId !== undefined) changes.provider_id = input.providerId
        if (input.model !== undefined) changes.model = input.model
        if (input.mascotId !== undefined) changes.mascot_id = input.mascotId
        if (input.colorHex !== undefined) changes.color_hex = input.colorHex
        if (input.symbol !== undefined) changes.symbol = input.symbol
        if (input.tools !== undefined) changes.tools = JSON.stringify(input.tools)
        if (input.approvalMode !== undefined) changes.approval_mode = input.approvalMode
        if (input.maxSteps !== undefined) changes.max_steps = clampSteps(input.maxSteps)
        if (input.integrationIds !== undefined) changes.integration_ids = JSON.stringify(input.integrationIds)
        if (input.teammateIds !== undefined) changes.teammate_ids = JSON.stringify([...new Set(input.teammateIds)])
        if (input.librarySkills !== undefined) changes.library_skills = JSON.stringify([...new Set(input.librarySkills)])
        if (input.memoryProject !== undefined) changes.memory_project = input.memoryProject.trim()
        yield* sql`UPDATE bots SET ${sql.update(changes)} WHERE id = ${id}`.pipe(Effect.orDie)
        if (input.name !== undefined) {
          yield* sql`UPDATE messages SET sender_name = ${input.name.trim()} WHERE bot_id = ${id}`.pipe(Effect.orDie)
        }
        return yield* get(id)
      })

      const remove = Effect.fn("BotRepo.remove")(function*(id: string) {
        yield* get(id)
        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`
            DELETE FROM conversations WHERE kind = 'handoff' AND (requester_bot_id = ${id} OR id IN (
              SELECT conversation_id FROM conversation_bots WHERE bot_id = ${id}
            ))`
          yield* sql`
            UPDATE bots SET teammate_ids = (
              SELECT json_group_array(value) FROM json_each(bots.teammate_ids) WHERE value != ${id}
            )
            WHERE json_valid(teammate_ids) AND EXISTS (SELECT 1 FROM json_each(bots.teammate_ids) WHERE value = ${id})`
          yield* sql`
            DELETE FROM conversations WHERE id IN (
              SELECT conversation_id FROM conversation_bots
              GROUP BY conversation_id
              HAVING COUNT(*) = 1 AND MAX(bot_id = ${id}) = 1
            )`
          yield* sql`DELETE FROM conversation_bots WHERE bot_id = ${id}`
          yield* sql`DELETE FROM bots WHERE id = ${id}`
        })).pipe(Effect.orDie)
      })

      const assignLibrarySkill = Effect.fn("BotRepo.assignLibrarySkill")(function*(
        name: string,
        botIds: ReadonlyArray<string>,
        options?: { readonly only?: boolean }
      ) {
        const wanted = new Set(botIds)
        const now = yield* nowIso
        return yield* sql.withTransaction(Effect.gen(function*() {
          let changed = false
          for (const bot of yield* list) {
            const has = bot.librarySkills.includes(name)
            const should = wanted.has(bot.id) || (options?.only === false && has)
            if (has === should) continue
            const skills = should ? [...bot.librarySkills, name] : bot.librarySkills.filter((skill) => skill !== name)
            yield* sql`UPDATE bots SET ${sql.update({ library_skills: JSON.stringify(skills), updated_at: now })} WHERE id = ${bot.id}`
            changed = true
          }
          return changed
        })).pipe(Effect.orDie)
      })

      return BotRepo.of({ list, get, create, update, remove, assignLibrarySkill })
    })
  )
}
