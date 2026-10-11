# weaver-core

The Weaver agent server. It runs on your VPS, stores your bots, chats, provider keys and connected apps, and runs the bots: they reply, run shell commands, edit files, browse the web, call MCP apps, and learn reusable skills as they work. The Mac app in `../weaver-mac` is its client.

Built with [Bun](https://bun.sh) and [Effect 4](https://effect.website), with SQLite for storage.

## Run it

```sh
bun install
WEAVER_TOKEN=dev-token-change-me WEAVER_LISTEN=127.0.0.1:7700 WEAVER_DATA_DIR=/tmp/weaver bun src/main.ts
curl http://127.0.0.1:7700/v1/health
```

Every route except `/v1/health` needs `Authorization: Bearer <WEAVER_TOKEN>`. The OpenAPI description is at `/v1/openapi.json`.

Bots browse with [camofox-browser](https://github.com/jo-inc/camofox-browser). To give them a browser locally, start it in another terminal (it downloads Camoufox, about 700 MB, on first run):

```sh
CAMOFOX_PORT=9377 CAMOFOX_BIND_HOST=127.0.0.1 npx @askjo/camofox-browser
```

Without it, `web_search` falls back to DuckDuckGo and `web_fetch` fetches pages directly.

## Teams

A team (`/v1/teams`) is a manager bot plus members with roles, and optionally subgroups one level deep, each led by a member of its parent. Creating one makes two conversations: the team's room (`kind: "team-room"`), where the manager and members work and you can only watch, and your private chat with the manager (`kind: "team-private"`), both with the team's `teamId`. In the private chat the manager has `brief_team` and `team_status`: briefing starts a session in the room, or passes an update to the running one. Reports (`{ type: "report", kind: "brief" | "decision" | "question" | "summary" }` message parts) show up in the private chat, and the room's `brief` reports carry your instructions.

`POST /v1/teams/:id/stop` stops the team's session and any member replies in it; `POST /v1/teams/:id/resume` continues a team that's `waiting` or `interrupted` (teams that were working when the server stopped). `team-changed` events on `/v1/events` say when to refetch a team. Team conversations follow the team: posting or regenerating in a room, changing their bots or deleting them answers `409`/`400`, and a bot that manages a team can't be deleted.

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Start with reload on change |
| `bun run test` | Run the tests (Vitest) |
| `bun run check` | Type-check |
| `bun run build` | Compile a single binary to `dist/weaver-server` |
| `bun run build:linux-x64`, `build:linux-arm64` | Compile the Linux release binaries |

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEAVER_TOKEN` | (required) | Access token clients send as a bearer token |
| `WEAVER_LISTEN` | `:7700` | Address and port to listen on |
| `WEAVER_DATA_DIR` | `/var/lib/weaver` | Database, bot workspaces and skills |
| `WEAVER_MEMORY_URL` | (unset) | Basic Memory's MCP URL; unset means no memory tool |
| `WEAVER_MEMORY_TOKEN`, `WEAVER_MEMORY_PROJECT` | empty | Basic Memory token and project |
| `WEAVER_MEMORY_RECALL` | `on` | Before each reply of a bot with memory, searches memory for the user's message (up to 3 seconds) and adds short previews of related notes to the prompt; `off` turns it off |
| `WEAVER_MEMORY_HISTORY_MINUTES` | `10` | Minutes between checks for memory notes that changed, so a note's history (`/v1/memory/history`) also has edits made outside Weaver; `0` only saves versions around bot writes and when a history is opened |
| `WEAVER_MEMORY_PROJECTS_DIR` | empty | Folder, on Basic Memory's machine, that projects created from Weaver go in; empty uses `basic-memory-projects` next to the default project's folder |
| `WEAVER_BROWSER` | `camofox` | Bots' browser: `camofox`, `playwright` (an MCP server started with `WEAVER_BROWSER_COMMAND`) or `off` |
| `WEAVER_CAMOFOX_URL` | `http://127.0.0.1:9377` | camofox-browser's address |
| `WEAVER_CAMOFOX_KEY` | empty | camofox-browser's access key (its `CAMOFOX_ACCESS_KEY`) |
| `WEAVER_BROWSER_COMMAND` | `npx -y @playwright/mcp@latest` | In `playwright` mode, starts the browser's MCP server; empty turns the browser off |
| `WEAVER_REVIEW_SKILL_INTERVAL` | `10` | Tool steps between background skill reviews; `0` turns them off |
| `WEAVER_REVIEW_MEMORY_INTERVAL` | `10` | Replies between background memory reviews; `0` turns them off |
| `WEAVER_HANDOFF_TIMEOUT_MINUTES` | `15` | Longest a bot waits for a teammate it asked with `ask_bot` before giving up and stopping the teammate's reply |
| `WEAVER_TEAM_NUDGE_STEPS` | `40` | Steps a team's manager can take without reporting before it's reminded to report to you |
| `WEAVER_TEAM_PAUSE_STEPS` | `150` | Steps without a report after which a team pauses and asks you whether to go on |
| `WEAVER_CORE_MEMORY_CONDENSE_AT` | `3200` | Core Memory longer than this many characters is condensed in the background (the previous text is kept in `weaver/core-memory-history`); `0` turns it off |
| `WEAVER_BOT_USER` | empty | Runs bots' shell commands through `sudo -n`. `per-bot` (what the VPS uses) gives each bot its own user from `/usr/local/lib/weaver/weaver-bot-user`; a user name runs every bot as that user; empty runs them as the server's user |
| `WEAVER_BOT_GROUP` | `weaver-work` | Group shared by the server and bots' users; workspaces get it (mode `2770`) |
| `WEAVER_SKILL_CATALOG` | `anthropics/skills/skills` | GitHub folders listed by `GET /v1/skills/catalog`, comma-separated, each `owner/repo[/path][@ref]` (without `@ref`, the default branch). Each skill is a folder there with a `SKILL.md` |
| `WEAVER_GITHUB_TOKEN` | empty | GitHub token for installing skills and listing the catalog. Without one GitHub allows 60 API requests an hour; sent only to `api.github.com` and `raw.githubusercontent.com` |
| `DISPLAY` | `:1` | Virtual desktop the browser draws on. Commands that run as bot users don't get it, so they can't open windows there |

## Layout

```
src/
  main.ts                 server entry and layer wiring
  config/                 environment settings
  platform/
    db/                   SQLite database and migrations
    http/                 composed HttpApi, shared errors, bearer auth, handler wiring
    lib/                  small shared helpers
  features/               one folder per feature: schemas, services, api.ts (endpoint group), handlers.ts
    bots/                 bots and their repository
    conversations/        conversations and messages
    runs/                 agent runner, toolbox, prompts, approvals, run events and the SSE route
    providers/            model providers
    integrations/         MCP integrations and the MCP hub
    profile/              the user's profile and settings
    learning/             skills (store and /v1/bots/:id/skills endpoints), the shared library (/v1/skills) and self-review
    memory/               Basic Memory projects, each project's knowledge graph and note history (/v1/memory)
    teams/                teams (/v1/teams), their rooms and the sessions their managers lead
  tools/                  AgentTool, builtin/ (shell, files, memory, MCP, browser, web, ask_bot, team tools) and learning/ (skills, session search)
test/
  support/                shared test layers and fixtures
  platform/, features/, tools/  Vitest suites, mirroring src/
scripts/                  VPS helpers shipped with each release, see below
deploy/test/              systemd test harness for the setup script
.github/workflows/        release.yml: tests, Linux builds and GitHub releases
```

Inside `WEAVER_DATA_DIR`: `weaver.db` (SQLite), `bots/<id>/workspace` (the bot's own folder), `bots/<id>/home` (its user's home, in per-bot mode), `bots/<id>/skills` (its `SKILL.md` skills), `skills-library/` (the shared skills library, assigned to bots through `librarySkills`) and `backups/`. With `WEAVER_BOT_USER` set, bots' users can pass through to workspaces but can't list the data folders or open the database or skills.

| Script | What it does |
| --- | --- |
| `scripts/weaver-bot-user` | `ensure <bot id>` / `remove <bot id>`: creates or deletes a bot's Linux user (`wb-…`) and fixes its home and workspace. Installed as root's `/usr/local/lib/weaver/weaver-bot-user`; the server runs it through `sudo` |
| `scripts/weaver-update` | Updates the installed server from a release, checked against `SHA256SUMS`, and rolls back if `/v1/health` doesn't answer within 30 seconds. Installed as `/usr/local/bin/weaver-update` |
| `scripts/check-bot-isolation.sh` | Run as root on a VPS to check bots' users can't reach the server's data, each other's files or the local services' ports |

## Deploying

The setup script in `../weaver-mac/weaver/Resources/weaver-vps-setup.sh` installs the latest release as a systemd service, with `weaver-update`, nightly backups and per-bot users. See [`../docs/vps-setup.md`](../docs/vps-setup.md) for the full guide.

Releases come from `.github/workflows/release.yml` in this repository ([fiqryq/weaver-core](https://github.com/fiqryq/weaver-core)). Every pull request and push runs the type check, the tests and shellcheck. Pushes to `main` build `weaver-server-linux-x64` and `weaver-server-linux-arm64` and refresh the rolling `server-latest` prerelease with them, `weaver-bot-user`, `weaver-update` and `SHA256SUMS`. Tags named `v*` or `server-v*` get a versioned release with the same files.

To test the setup script on a real systemd (needs Docker and Bun):

```sh
SKIP_MEMORY=1 ./deploy/test/run.sh
```

It builds the Linux binary for Docker's architecture, runs the setup script twice in a Debian container with systemd as PID 1 (in its `SKIP_TAILSCALE=1` test mode), reboots it, and checks the services, the API, bot isolation, the firewall, backups and `weaver-update` (including a rollback) each time. Leave out `SKIP_MEMORY=1` to install Basic Memory too, which needs about 2 GB more disk.
