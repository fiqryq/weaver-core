import init from "./0001_init.ts"
import messageSearch from "./0002_message_search.ts"
import messageFinishedAt from "./0003_message_finished_at.ts"

/** Kept as a record (not loaded from disk) so the compiled single binary carries them. */
export const migrations = {
  "0001_init": init,
  "0002_message_search": messageSearch,
  "0003_message_finished_at": messageFinishedAt
}
