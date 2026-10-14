import init from "./0001_init.ts"
import messageSearch from "./0002_message_search.ts"
import messageFinishedAt from "./0003_message_finished_at.ts"
import handoffs from "./0004_handoffs.ts"
import librarySkills from "./0005_library_skills.ts"
import memory from "./0006_memory.ts"
import teams from "./0007_teams.ts"
import integrationOAuth from "./0008_integration_oauth.ts"
import schedules from "./0009_schedules.ts"

/** Kept as a record (not loaded from disk) so the compiled single binary carries them. */
export const migrations = {
  "0001_init": init,
  "0002_message_search": messageSearch,
  "0003_message_finished_at": messageFinishedAt,
  "0004_handoffs": handoffs,
  "0005_library_skills": librarySkills,
  "0006_memory": memory,
  "0007_teams": teams,
  "0008_integration_oauth": integrationOAuth,
  "0009_schedules": schedules
}
