# weaver-core

The Weaver agent server. It runs on your VPS, stores your bots, chats, provider keys and connected apps, and runs the bots: they reply, run shell commands, edit files, browse the web, call MCP apps, and learn reusable skills as they work. The Mac app in `../weaver-mac` is its client.

Built with [Bun](https://bun.sh) and [Effect 4](https://effect.website), with SQLite for storage.

## Run it

```sh
bun install
WEAVER_TOKEN=dev WEAVER_LISTEN=127.0.0.1:7700 WEAVER_DATA_DIR=/tmp/weaver bun src/main.ts
curl http://127.0.0.1:7700/v1/health
```

Every route except `/v1/health` needs `Authorization: Bearer <WEAVER_TOKEN>`. The OpenAPI description is at `/v1/openapi.json`.

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
| `WEAVER_BROWSER_COMMAND` | `npx -y @playwright/mcp@latest` | Starts the browser's MCP server; empty turns the browser off |
| `WEAVER_REVIEW_SKILL_INTERVAL` | `10` | Tool steps between background skill reviews; `0` turns them off |
| `WEAVER_REVIEW_MEMORY_INTERVAL` | `10` | Replies between background memory reviews; `0` turns them off |
| `WEAVER_BOT_USER` | empty | Runs bots' shell commands as this user through `sudo -n` (the VPS uses `weaver-bot`); empty runs them as the server's user |
| `WEAVER_BOT_GROUP` | `weaver-work` | Group shared by the server and the bot user; workspaces get it (mode `2770`) |
| `DISPLAY` | `:1` | Virtual desktop for the browser and GUI programs |

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
    learning/             skills (store and /v1/bots/:id/skills endpoints) and self-review
  tools/                  AgentTool, builtin/ (shell, files, memory, MCP) and learning/ (skills, session search)
test/
  support/                shared test layers and fixtures
  platform/, features/, tools/  Vitest suites, mirroring src/
scripts/                  check-bot-isolation.sh, run as root on a VPS to check the bot user can't reach the server's data
```

Inside `WEAVER_DATA_DIR`: `weaver.db` (SQLite), `bots/<id>/workspace` (the bot's own folder) and `bots/<id>/skills` (its `SKILL.md` skills). With `WEAVER_BOT_USER` set, the bot user can pass through to workspaces but can't list the data folders or open the database or skills.

## Deploying

The setup script in `../weaver-mac/weaver/Resources/weaver-vps-setup.sh` installs the latest release as a systemd service. Pushes to `main` rebuild that release (`.github/workflows/server-release.yml`). See [`../docs/vps-setup.md`](../docs/vps-setup.md) for the full guide.
