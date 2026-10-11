import { corePermalink, coreTitle, memoryFolder } from "../../../tools/builtin/Memory.ts"

/**
 * Prompts for the background review that runs after some replies and asks the bot whether
 * anything from the conversation is worth keeping. Ported from Hermes' background review,
 * with its memory files mapped to Basic Memory (Core Memory and notes) and its skill tools
 * mapped to this bot's skills.
 */

export type ReviewKind = "skills" | "memory"

/** Shared by the memory-only and combined prompts: each fact goes to exactly one place. */
const memoryRouting = (botName: string): string =>
  `TWO distinct places — pick the right one for each fact. Memory is shared by all of the user's bots:\n` +
  `  • ${coreTitle} (the note "${coreTitle}", identifier "${corePermalink}", which every bot reads at the start ` +
  `of each reply): who the user is — persona, preferences, communication and work style, personal details they ` +
  `revealed, their team's standing rules, and expectations about how bots should behave. Only truly durable, ` +
  `important facts. Add them with edit_note (identifier "${corePermalink}", operation "append"), one short line ` +
  `each, like "- [fact] The user prefers short answers (via ${botName})". It's condensed from time to time ` +
  `(duplicates merged, outdated facts dropped), so anything not needed on every reply goes in a note instead.\n` +
  `  • A note in the "${memoryFolder}" directory (write_note with directory "${memoryFolder}"): other durable facts — ` +
  `people, projects, decisions, and the ENVIRONMENT you operate in: tool quirks, project conventions, config ` +
  `gotchas, paths and endpoints that matter. When a note on the topic already exists, add to it with edit_note ` +
  `(operation "append") instead of writing a duplicate.\n\n` +
  `Search before you write (search_notes, then read_note) so you don't save what's already there. One fact goes ` +
  `to ONE place, never both — writing it twice bloats ${coreTitle}, which every bot reads on every reply, and ` +
  `crowds out the facts that matter; misrouting it puts it where the next session won't look. Only append: ` +
  `never replace or delete what's in a shared note. Don't save secrets such as passwords or API keys.\n\n`

export const memoryReviewPrompt = (botName: string): string =>
  `Review the conversation above and consider saving to memory if appropriate.\n\n` +
  `Memory has ${memoryRouting(botName)}` +
  `If something stands out, save it once, in the right place. If nothing is worth saving, just say ` +
  `'Nothing to save.' and stop.`

/**
 * Shared shape contract for anything written into a skill. It prevents the hoarding library: one
 * file per session, incident narration instead of rules, and restating what's already in context.
 */
const lessonLayer =
  `What a skill IS: the instructions for doing a class of task the most efficient and correct way, to THIS ` +
  `user's specifications — the procedure, the tools and commands that work, the order, the user's preferences ` +
  `for how the result should look, and the pitfalls that cost time. A future session should be able to follow ` +
  `it and produce what the user wants on the first try. Everything below is about writing that well:\n` +
  `  • Procedure first: the steps in the order they are done, with the concrete commands, tool calls, and ` +
  `decision points. Lessons and pitfalls attach to the step they affect.\n` +
  `  • A pitfall is a generalizable rule + one clause of WHY (the mechanism), imperative. 'Check the service's ` +
  `health endpoint before reporting a deploy as done — the process starts before it accepts connections.' Not a ` +
  `narrative of what happened this session.\n` +
  `  • No PR/issue numbers, dates, ticket IDs, or quoted user text as content — the rule must stand without the ` +
  `incident behind it. Keep a short quote ONLY when the quote itself is the clearest statement of the rule.\n` +
  `  • The same lesson learned twice is ONE rule. Before adding, search the skill (and its references/) for the ` +
  `rule already stated; strengthen or clarify it rather than appending a second copy.\n` +
  `  • Not a duplicate of what the environment already teaches: your system prompt, ${coreTitle}, and tool ` +
  `descriptions. A skill carries the WORKFLOW and the pitfalls; it does not restate a tool's parameter list.\n` +
  `  • Always-on rules (standing user preferences, gates that apply to every instance of the task) live in ` +
  `SKILL.md itself, whole. references/ is for depth that is only needed sometimes: a decision table, a recipe, a ` +
  `domain note — each file topical and reusable, never '<date>-<incident>.md'. Prefer extending an existing ` +
  `references/ file over creating one; a skill with dozens of one-off references is the failure shape, not the goal.\n` +
  `  • Fix the skill in place when it is wrong: edit the sentence that misled, do not append 'UPDATE: actually...' ` +
  `underneath it.\n\n`

/** Shared tail of the skill and combined prompts: what NOT to persist as a skill. */
const doNotCapture =
  ` (these become persistent self-imposed constraints that bite you later when the environment changes):\n` +
  `  • Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, ` +
  `'command not found', unconfigured credentials, uninstalled packages. The user can fix these — they are not ` +
  `durable rules.\n` +
  `  • Negative claims about tools or features ('the browser doesn't work', 'X tool is broken', 'cannot use Y ` +
  `from run_command'). These harden into refusals you cite against yourself for months after the actual problem ` +
  `was fixed.\n` +
  `  • Session-specific transient errors that resolved before the conversation ended. If retrying worked, the ` +
  `lesson is the retry pattern, not the original failure.\n` +
  `  • One-off task narratives. A user asking 'summarize today's news' or 'look at this file' is not a class of ` +
  `work that warrants a skill.\n\n` +
  `  • Unresolved failures: if the session ended WITHOUT actually finding a working method — you tried several ` +
  `things, none worked, and told the user to check manually — do NOT write those attempts up as a 'reliable ` +
  `workflow' or 'recommended approach'. That presents an untested sequence of failures as validated guidance a ` +
  `future session will trust and repeat. Either say 'Nothing to save', or, only if you are independently ` +
  `confident of a real working alternative (not something you are merely guessing might work), capture ONLY that ` +
  `alternative — never the dead ends, and never dressed up as best practice.\n\n` +
  `If a tool failed because of setup state, capture the FIX (install command, config step, env var to set) under ` +
  `an existing setup or troubleshooting skill — never 'this tool does not work' as a standalone constraint.\n\n`

const readBeforeWrite =
  `Read-before-write (ENFORCED — skill_manage refuses otherwise): before you patch, edit, or write a file into ` +
  `an existing skill, call skill_view(name) for that skill during this review. Content quoted earlier in the ` +
  `conversation does NOT count — the guard requires a fresh load within this review, and your write must be based ` +
  `on what skill_view just returned (viewing a supporting file with file_path doesn't count). If SKILL.md changes ` +
  `after you view it, writes are refused until you view it again. Creating a brand-new skill needs no prior read. ` +
  `If a write is refused with a read-before-write error, call skill_view for the named skill once and retry the ` +
  `write once; do not loop. Skills the user wrote can only be patched here, never rewritten with edit.\n\n` +
  `Skills marked (library) are shared with other bots: patch one only with a lesson that holds for every bot using it, ` +
  `and create new skills in your own store (skill_manage create always does).\n\n`

export const skillReviewPrompt =
  `Review the conversation above and update your skill library. Be ACTIVE — most sessions produce at least one ` +
  `skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.\n\n` +
  `Target shape of the library: CLASS-LEVEL skills, each with a SKILL.md of always-on rules and a small ` +
  `\`references/\` set of topical depth. Not a flat list of narrow one-session skills, and not an umbrella hoarding ` +
  `a references/ file per session. This shapes HOW you update, not WHETHER you update.\n\n` +
  lessonLayer +
  `Signals to look for (any one of these warrants action):\n` +
  `  • User corrected your style, tone, format, legibility, or verbosity. Frustration signals like 'stop doing X', ` +
  `'this is too verbose', 'don't format like this', 'why are you explaining', 'just give me the answer', 'you ` +
  `always do Y and I hate it', or an explicit 'remember this' are FIRST-CLASS skill signals, not just memory ` +
  `signals. Update the relevant skill(s) to embed the preference so the next session starts already knowing.\n` +
  `  • User corrected your workflow, approach, or sequence of steps. Encode the correction as a pitfall or explicit ` +
  `step in the skill that governs that class of task.\n` +
  `  • Non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged that a future session ` +
  `would benefit from. Capture it.\n` +
  `  • A skill that got loaded or consulted this session turned out to be wrong, missing a step, or outdated. ` +
  `Patch it NOW.\n\n` +
  `Preference order — prefer the earliest action that fits, but do pick one when a signal above fired:\n` +
  `  1. UPDATE A SKILL USED IN THIS CONVERSATION. Look back through the conversation for skills you read via ` +
  `skill_view. If any of them covers the territory of the new learning, PATCH that one first (re-load it with ` +
  `skill_view during this review — see Read-before-write below). It is the skill that was in play, so it's the ` +
  `right one to extend, whoever wrote it.\n` +
  `  2. UPDATE AN EXISTING UMBRELLA (via skills_list + skill_view). If no skill used here fits but an existing ` +
  `class-level skill does, patch it. Add a subsection, a pitfall, or broaden a trigger.\n` +
  `  3. ADD A SUPPORT FILE under an existing umbrella. Skills can be packaged with three kinds of support files — ` +
  `use the right directory per kind:\n` +
  `     • \`references/<topic>.md\` — topical depth needed only sometimes: a decision table, a reproduction recipe, ` +
  `provider quirks, condensed domain notes or API excerpts. Name it by TOPIC and extend an existing file when one ` +
  `covers the topic; do not create a per-session or per-incident file, and do not paste error transcripts — ` +
  `distill them to the rule.\n` +
  `     • \`templates/<name>.<ext>\` — starter files meant to be copied and modified (boilerplate configs, ` +
  `scaffolding, a known-good example to reproduce with modifications).\n` +
  `     • \`scripts/<name>.<ext>\` — statically re-runnable actions the skill can invoke directly (verification ` +
  `scripts, fixture generators, deterministic probes, anything that should be run rather than hand-typed each ` +
  `time).\n` +
  `     Add support files via skill_manage action=write_file with file_path starting 'references/', 'templates/', ` +
  `or 'scripts/'. The umbrella's SKILL.md should gain a one-line pointer to any new support file so future ` +
  `sessions know it exists.\n` +
  `  4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL when no existing skill covers the class. The name MUST be at the ` +
  `class level. The name MUST NOT be a specific PR number, error string, feature codename, library-alone name, or ` +
  `'fix-X / debug-Y / audit-Z-today' session artifact. If the proposed name only makes sense for today's task, ` +
  `it's wrong — fall back to (1), (2), or (3).\n\n` +
  readBeforeWrite +
  `User-preference embedding (important): when the user expressed a style/format/workflow preference, the update ` +
  `belongs in the SKILL.md body, not just in memory. Memory captures 'who the user is and what the current ` +
  `situation and state of your operations are'; skills capture 'how to do this class of task for this user'. ` +
  `When they complain about how you handled a task, the skill that governs that task needs to carry the lesson.\n\n` +
  `If you notice two existing skills that overlap, note it in your reply — the user can merge them. Never delete ` +
  `a skill or a skill file here.\n\n` +
  `Do NOT capture${doNotCapture}` +
  `'Nothing to save.' is a real option but should NOT be the default. If the session ran smoothly with no ` +
  `corrections and produced no new technique, just say 'Nothing to save.' and stop. Otherwise, act.`

export const combinedReviewPrompt = (botName: string): string =>
  `Review the conversation above and update two things:\n\n` +
  `**Memory**: ${memoryRouting(botName)}` +
  `**Skills**: how to do this class of task. Your skills are yours alone; memory is shared with the user's other ` +
  `bots. Be ACTIVE — most sessions produce at least one skill update. A pass that does nothing is a missed ` +
  `learning opportunity, not a neutral outcome.\n\n` +
  `Target shape of the skill library: CLASS-LEVEL skills with a SKILL.md of always-on rules and a small ` +
  `\`references/\` set of topical depth — not narrow one-session skills, and not an umbrella hoarding a ` +
  `references/ file per session.\n\n` +
  lessonLayer +
  `Signals that warrant a skill update (any one is enough):\n` +
  `  • User corrected your style, tone, format, legibility, verbosity, or approach. Frustration is a FIRST-CLASS ` +
  `skill signal, not just a memory signal. 'stop doing X', 'don't format like this', 'I hate when you Y' — embed ` +
  `the lesson in the skill that governs that task so the next session starts fixed.\n` +
  `  • Non-trivial technique, fix, workaround, or debugging path emerged.\n` +
  `  • A skill that was loaded or consulted turned out wrong, missing, or outdated — patch it now.\n\n` +
  `Preference order for skills — pick the earliest that fits:\n` +
  `  1. UPDATE A SKILL USED IN THIS CONVERSATION. Check which skills you read via skill_view in the conversation. ` +
  `If one of them covers the learning, PATCH it first (re-load it with skill_view during this review — see ` +
  `Read-before-write below). It was in play; it's the right place, whoever wrote it.\n` +
  `  2. UPDATE AN EXISTING UMBRELLA (skills_list + skill_view to find the right one). Patch it.\n` +
  `  3. ADD A SUPPORT FILE under an existing umbrella via skill_manage action=write_file. Three kinds: ` +
  `\`references/<topic>.md\` for topical depth (decision tables, recipes, quirks, condensed domain notes) — extend ` +
  `an existing topical file before creating one, never a per-session file; \`templates/<name>.<ext>\` for starter ` +
  `files meant to be copied and modified; \`scripts/<name>.<ext>\` for statically re-runnable actions ` +
  `(verification, fixture generators, probes). Add a one-line pointer in SKILL.md so future sessions find them.\n` +
  `  4. CREATE A NEW CLASS-LEVEL UMBRELLA when nothing exists. Name at the class level — NOT a PR number, error ` +
  `string, codename, library-alone name, or 'fix-X / debug-Y' session artifact. If the name only fits today's ` +
  `task, fall back to (1), (2), or (3).\n\n` +
  readBeforeWrite +
  `User-preference embedding: when the user complains about how you handled a task, update the skill that ` +
  `governs that task rather than memory. Memory says 'who the user is and what the current situation and state ` +
  `of your operations are'; skills say 'how to do this class of task for this user'. A user-preference lesson ` +
  `lives in exactly ONE place: the skill that governs the task when one exists, ${coreTitle} only for ` +
  `cross-cutting preferences no skill owns — never both. Duplicating it is how ${coreTitle} ends up restating ` +
  `SKILL.md.\n\n` +
  `If you notice overlapping existing skills, mention it — the user can merge them. Never delete a skill here.\n\n` +
  `Do NOT capture as skills${doNotCapture}` +
  `Act on whichever of the two dimensions has real signal. If genuinely nothing stands out on either, say ` +
  `'Nothing to save.' and stop — but don't reach for that conclusion as a default.`

/** The final user turn of a review: the prompt for what fired, plus the tool restriction. */
export const reviewPrompt = (kinds: ReadonlySet<ReviewKind>, botName: string): string => {
  const memory = kinds.has("memory")
  const skills = kinds.has("skills")
  const prompt = memory && skills
    ? combinedReviewPrompt(botName)
    : memory
    ? memoryReviewPrompt(botName)
    : skillReviewPrompt
  const allowed = memory && skills ? "memory and skill" : memory ? "memory" : "skill"
  return `${prompt}\n\nYou can only call ${allowed} management tools. ` +
    `Other tools will be denied at runtime — do not attempt them.`
}
