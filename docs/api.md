# API

[← Back to the README](../README.md)

Every route except `/v1/health` needs `Authorization: Bearer <WEAVER_TOKEN>`. The full OpenAPI description is at `/v1/openapi.json`.

| Route | What it's for |
| --- | --- |
| `GET /v1/health` | Status, version, build `commit` and `builtAt`, uptime, free disk, and which features are on (`memory`, `browser`, `handoffs`, `skillsLibrary`, `teams`, `oauthIntegrations`, `updates`) |
| `GET /v1/update?channel=stable\|latest&refresh=1` | The channel's newest release against this build (cached for an hour; `refresh=1` checks again), whether one-click updates are `supported`, and the updater's `status` |
| `POST /v1/update` | `{ "channel", "tag"? }`: asks the root-side updater to install the channel's newest release (or `tag`). `202`, or `409` while an update runs, `503` when the updater isn't installed, `404` when there's nothing newer |
| `/v1/bots` | Bots, their tools, integrations, teammates and skills (`/v1/bots/:id/skills`) |
| `/v1/conversations` | Chats and messages. Posting a message starts a run. Also `cancel`, `regenerate` and `resume` |
| `GET /v1/events`, `GET /v1/conversations/:id/events` | Server-sent events: run progress, approvals, and changes to skills, teams and integration sign-ins |
| `POST /v1/approvals/:id`, `POST /v1/runs/:id/cancel` | Answer an approval request, stop a run |
| `/v1/providers` | Model providers and their keys |
| `/v1/integrations` | MCP integrations. For `auth: "oauth"` ones: `POST :id/oauth/start` (answers the URL to open), `POST :id/oauth/finish` (relays `code` and `state`), and `DELETE :id/oauth` to sign out |
| `/v1/memory` | Basic Memory projects, the knowledge graph, and note history and versions |
| `/v1/skills` | The shared skills library: `catalog`, `install`, `import`, `promote` and `:name/bots` |
| `/v1/teams` | Teams, plus `stop` and `resume` |
| `/v1/profile` | Your profile and settings |

## Teams

Creating a team makes two conversations, both with the team's `teamId`:

- **The team room** (`kind: "team-room"`). The manager and members work here. You can only watch.
- **Your private chat with the manager** (`kind: "team-private"`). The manager has `brief_team` and `team_status`. A brief starts a session in the room, or passes an update to the running one.

How a session runs:

- Reports are message parts: `{ type: "report", kind: "brief" | "decision" | "question" | "summary" }`. They show up in the private chat. The room's `brief` reports carry your instructions.
- A session runs until the manager finishes the goal. There's no time limit.
- After `WEAVER_TEAM_PAUSE_STEPS` steps without a report, it pauses and asks whether to go on.

Controlling it:

- `POST /v1/teams/:id/stop` stops a session.
- `POST /v1/teams/:id/resume` continues a team that's `waiting`, or `interrupted` (it was working when the server stopped).
- Posting or regenerating in a room, or changing its bots, answers `409` or `400`.
- A bot that manages a team can't be deleted.

Bots can propose a team themselves with `propose_team`, in chats and private team chats. It always asks for approval, whatever the bot's approval mode, and the proposal is checked before you're asked. On approval the server does four things in order. It installs any requested skills from the catalog, skipping names it can't find. It creates the new bots with approval mode `ask`, the default model and a `blob.<kind>` avatar. It creates the team, led by the proposing bot (`"manager": "me"`) or one of the new bots. Then it returns a summary such as `Created team "Brand Studio" (manager: Iris) with Kai (Copywriter). Installed skills: brand-guidelines. Skipped: unknown-skill (not found).` Clients get the usual `team-changed` and `skill-library-changed` events; new bots appear on the next pull of `/v1/bots`.
