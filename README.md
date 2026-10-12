# weaver-core

The agent server behind Weaver, a Mac app for running a crew of AI bots on your own computer in the cloud.

It runs on your VPS and does the actual work. The Mac app is a client that talks to it over [Tailscale](https://tailscale.com).

**Start here:**

- Setting up a VPS? → [Install on your VPS](#install-on-your-vps). One command.
- Working on the server? → [Run it locally](#run-it-locally).
- Calling the API yourself? → [API](#api).

## What bots can do

- **Work on a real computer.** Each bot gets its own workspace and, on a VPS, its own Linux user. Bots run commands, read and edit files, and ask for your approval before risky steps.
- **Browse the web.** With [camofox-browser](https://github.com/jo-inc/camofox-browser) (an anti-detection Firefox) or Playwright, on a virtual desktop you can watch live. Without a browser, `web_search` and `web_fetch` still work.
- **Use your models and apps.** Any OpenAI-compatible model, with presets for DeepSeek, OpenAI, Qwen, Kimi, GLM and MiniMax. MCP servers become integrations. Hosted apps like Notion, Linear or Sentry sign in with OAuth: you approve in the browser on your Mac, and the server keeps and refreshes the tokens.
- **Remember and learn.** With [Basic Memory](https://github.com/basicmachines-co/basic-memory), bots share a knowledge base of Markdown notes, keep a Core Memory note about you, recall related notes before replying, and condense their memory when it grows. Bots also write `SKILL.md` skills as they work. A shared skills library installs skills from GitHub or a catalog, and you choose which bots get each one.
- **Work together.** A bot can hand work to a teammate with `ask_bot`; the result is saved to the knowledge base. A team has a manager bot and members with roles. You brief the manager in a private chat, watch the team work in a room, and get decisions, questions and a final summary back.

Built with [Bun](https://bun.sh), [Effect 4](https://effect.website) and SQLite. It ships as a single binary.

## Install on your VPS

### Step 1: Pick a machine

| | Recommended | Minimum |
| --- | --- | --- |
| System | Ubuntu 24.04 (or Debian 12), fresh install | Ubuntu or Debian with systemd |
| CPU | 2 vCPU, x64 | 1 vCPU, x64 or arm64 |
| Memory | 4 GB | 2 GB with swap (see below) |
| Disk | 40 GB SSD | 25 GB |

- Any provider with root SSH works. Pick the region closest to you.
- You don't need a public IP or open ports other than SSH.
- Models run on your provider's servers, so the VPS needs memory more than CPU. Roughly: server 180 MB, browser 350 MB plus 30 to 120 MB per tab (capped at 1.5 GB with the server), Basic Memory 0.5 GB, desktop and system a few hundred MB.

On a 2 GB machine, add swap first:

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Step 2: Run the installer

1. On your Mac, install Tailscale and sign in.
2. SSH into your VPS and run:

   ```sh
   curl -fsSL https://github.com/fiqryq/weaver-core/releases/download/server-latest/install.sh | bash
   ```

3. Open the Tailscale link it prints. Sign in with the same account as your Mac.
4. Click the `weaver://connect` link it prints at the end. It fills in the server address, token, desktop, stats and memory settings in Weaver.
5. In Weaver, add a model provider key in **Settings › Models**. The key is stored on the VPS.

You're done when a bot replies in Weaver. If it doesn't, see [Troubleshooting](#troubleshooting).

Good to know:

- The same command is behind **Copy Setup Command** in Weaver (on the first-run screen, or in **Settings › Computer**).
- Not root? It asks for your password and reruns itself with sudo.
- No curl yet? Run `apt-get install -y curl` first.
- Running it again is safe. It keeps your token and data and updates everything.

### What the installer sets up

- This server, as the `weaver-agent` systemd service, checked against the release's `SHA256SUMS`
- Tailscale, plus a firewall (ufw) that only allows SSH and Tailscale
- A separate Linux user for each bot
- Camoufox, a virtual desktop (Xvfb and noVNC), Glances for machine stats, and Basic Memory
- `weaver-update`, nightly backups and `weaver-firewall`

### Installer options

Put options before `bash`:

```sh
curl -fsSL https://github.com/fiqryq/weaver-core/releases/download/server-latest/install.sh | SKIP_BROWSER=1 bash
```

Skip a part:

| Option | What it does |
| --- | --- |
| `SKIP_BROWSER=1` | No browser (saves about 1.4 GB of disk) |
| `SKIP_MEMORY=1` | No Basic Memory (saves about 0.5 GB of memory) |
| `SKIP_FIREWALL=1` | Leaves ufw alone |

Change how it's set up:

| Option | What it does |
| --- | --- |
| `TS_AUTHKEY=tskey-…` | Joins Tailscale with an auth key, without the login link |
| `BROWSER_ENGINE=playwright` | Chromium through Playwright MCP instead of Camoufox |
| `MEMORY_TOKEN=generate` | Puts Basic Memory behind a bearer token |
| `SCREEN_SIZE=1440x900` | Virtual desktop size (default `1280x800`) |
| `WEAVER_SERVER_BINARY=/path` | Installs a server binary you built instead of downloading one |

The full list is at the top of [`scripts/install.sh`](scripts/install.sh).

### Updating

```sh
sudo weaver-update            # latest server-latest build
sudo weaver-update v0.2.0     # a tagged release
sudo weaver-update --force    # reinstall even if the binary hasn't changed
```

It checks the download against `SHA256SUMS` and rolls back if `/v1/health` doesn't answer within 30 seconds.

### Troubleshooting

| Problem | Do this |
| --- | --- |
| The app can't connect | Run `systemctl status weaver-agent`, then `journalctl -u weaver-agent -n 50` |
| Wrong address | Check `WEAVER_LISTEN` in `/etc/weaver/agent.env` |
| Lost the token | Run `sudo cat /etc/weaver/server-token` |
| Connect by hand | In **Settings › Computer**, enter `http://<tailscale-ip>:7700` and the token |

### Only the server

Runs the server on its own, for using the API directly. You don't get the browser, memory, bot users or firewall that `install.sh` adds.

```sh
ARCH=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
BASE=https://github.com/fiqryq/weaver-core/releases/download/server-latest
curl -fL -O "$BASE/weaver-server-linux-$ARCH" -O "$BASE/SHA256SUMS"
sha256sum -c --ignore-missing SHA256SUMS
chmod +x "weaver-server-linux-$ARCH"

WEAVER_TOKEN=$(openssl rand -hex 32) WEAVER_LISTEN=127.0.0.1:7700 WEAVER_DATA_DIR=$HOME/weaver-data \
  ./weaver-server-linux-$ARCH
```

> **Keep it on `127.0.0.1` or a private network such as Tailscale.** Anyone with the token can run commands as the server's user.

## Run it locally

1. Install dependencies:

   ```sh
   bun install
   ```

2. Start the server:

   ```sh
   WEAVER_TOKEN=dev-token-change-me WEAVER_LISTEN=127.0.0.1:7700 WEAVER_DATA_DIR=/tmp/weaver bun src/main.ts
   ```

3. Check it answers:

   ```sh
   curl http://127.0.0.1:7700/v1/health
   ```

Optional extras:

- **Browser:** start camofox-browser in another terminal. The first run downloads Camoufox, about 700 MB.

  ```sh
  CAMOFOX_PORT=9377 CAMOFOX_BIND_HOST=127.0.0.1 npx @askjo/camofox-browser
  ```

- **Memory:** run [Basic Memory](https://github.com/basicmachines-co/basic-memory) as an MCP server and set `WEAVER_MEMORY_URL`, for example `http://127.0.0.1:8765/mcp`.

| Command | What it does |
| --- | --- |
| `bun run dev` | Start with reload on change |
| `bun run test` | Run the tests (Vitest) |
| `bun run check` | Type-check |
| `bun run build` | Compile a single binary to `dist/weaver-server` |
| `bun run build:linux-x64`, `build:linux-arm64` | Compile the Linux release binaries |

## API

Every route except `/v1/health` needs `Authorization: Bearer <WEAVER_TOKEN>`. The full OpenAPI description is at `/v1/openapi.json`.

| Route | What it's for |
| --- | --- |
| `GET /v1/health` | Status, version, uptime, free disk, and which features are on (`memory`, `browser`, `handoffs`, `skillsLibrary`, `teams`, `oauthIntegrations`) |
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

### Teams

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

## Settings

Set these as environment variables. On a VPS they live in `/etc/weaver/agent.env`.

### Basics

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEAVER_TOKEN` | (required) | Access token clients send as a bearer token |
| `WEAVER_LISTEN` | `:7700` | Address and port to listen on |
| `WEAVER_DATA_DIR` | `/var/lib/weaver` | Database, bot workspaces and skills |

### Memory

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEAVER_MEMORY_URL` | (unset) | Basic Memory's MCP URL. Unset means no memory tool |
| `WEAVER_MEMORY_TOKEN`, `WEAVER_MEMORY_PROJECT` | empty | Basic Memory token and project |
| `WEAVER_MEMORY_RECALL` | `on` | Before each reply of a bot with memory, searches memory for the user's message (up to 3 seconds) and adds short previews of related notes to the prompt. `off` turns it off |
| `WEAVER_MEMORY_HISTORY_MINUTES` | `10` | Minutes between checks for changed notes, so a note's history (`/v1/memory/history`) also has edits made outside Weaver. `0` only saves versions around bot writes and when a history is opened |
| `WEAVER_MEMORY_PROJECTS_DIR` | empty | Folder, on Basic Memory's machine, for projects created from Weaver. Empty uses `basic-memory-projects` next to the default project's folder |
| `WEAVER_CORE_MEMORY_CONDENSE_AT` | `3200` | Core Memory longer than this many characters is condensed in the background. The previous text is kept in `weaver/core-memory-history`. `0` turns it off |

### Browser

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEAVER_BROWSER` | `camofox` | Bots' browser: `camofox`, `playwright` (an MCP server started with `WEAVER_BROWSER_COMMAND`) or `off` |
| `WEAVER_CAMOFOX_URL` | `http://127.0.0.1:9377` | camofox-browser's address |
| `WEAVER_CAMOFOX_KEY` | empty | camofox-browser's access key (its `CAMOFOX_ACCESS_KEY`) |
| `WEAVER_BROWSER_COMMAND` | `npx -y @playwright/mcp@latest` | In `playwright` mode, starts the browser's MCP server. Empty turns the browser off |
| `DISPLAY` | `:1` | Virtual desktop the browser draws on. Commands that run as bot users don't get it, so they can't open windows there |

### Learning

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEAVER_REVIEW_SKILL_INTERVAL` | `10` | Tool steps between background skill reviews. `0` turns them off |
| `WEAVER_REVIEW_MEMORY_INTERVAL` | `10` | Replies between background memory reviews. `0` turns them off |
| `WEAVER_SKILL_CATALOG` | `anthropics/skills/skills` | GitHub folders listed by `GET /v1/skills/catalog`, comma-separated, each `owner/repo[/path][@ref]` (without `@ref`, the default branch). Each skill is a folder there with a `SKILL.md` |
| `WEAVER_GITHUB_TOKEN` | empty | GitHub token for installing skills and listing the catalog. Without one, GitHub allows 60 API requests an hour. Sent only to `api.github.com` and `raw.githubusercontent.com` |

### Handoffs and teams

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEAVER_HANDOFF_TIMEOUT_MINUTES` | `15` | Longest a bot waits for a teammate it asked with `ask_bot`, before giving up and stopping the teammate's reply |
| `WEAVER_TEAM_NUDGE_STEPS` | `40` | Steps a team's manager can take without reporting before it's reminded to report to you |
| `WEAVER_TEAM_PAUSE_STEPS` | `150` | Steps without a report after which a team pauses and asks you whether to go on |

### Bot users

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEAVER_BOT_USER` | empty | Runs bots' shell commands through `sudo -n`. `per-bot` (what the VPS uses) gives each bot its own user from `/usr/local/lib/weaver/weaver-bot-user`. A user name runs every bot as that user. Empty runs them as the server's user |
| `WEAVER_BOT_GROUP` | `weaver-work` | Group shared by the server and bots' users. Workspaces get it (mode `2770`) |

## Data

Everything lives inside `WEAVER_DATA_DIR`:

| Path | What's there |
| --- | --- |
| `weaver.db` | SQLite database: bots, conversations, providers, integrations, teams |
| `bots/<id>/workspace` | The bot's own folder |
| `bots/<id>/home` | Its Linux user's home, in per-bot mode |
| `bots/<id>/skills` | Skills the bot wrote |
| `skills-library/` | The shared skills library, assigned to bots through `librarySkills` |
| `backups/` | Nightly backups of the database and skills (on a VPS) |

With `WEAVER_BOT_USER` set, bots' users can reach their workspaces, but can't list the data folders or open the database or skills.

## Layout

```
src/
  main.ts                 server entry and layer wiring
  config/                 environment settings
  platform/
    db/                   SQLite database and migrations
    http/                 composed HttpApi, shared errors, bearer auth, handler wiring
    lib/                  small shared helpers
    os/                   running commands as bot users
  features/               one folder per feature: schemas, services, api.ts (endpoint group), handlers.ts
    bots/                 bots and their repository
    conversations/        conversations and messages
    runs/                 agent runner, toolbox, prompts, approvals, run events and the SSE route
    providers/            model providers
    integrations/         MCP integrations and the MCP hub
    profile/              the user's profile and settings
    learning/             bot skills, the shared library (/v1/skills), Core Memory and self-review
    memory/               Basic Memory projects, the knowledge graph and note history (/v1/memory)
    teams/                teams (/v1/teams), their rooms and the sessions their managers lead
  tools/                  AgentTool, builtin/ (shell, files, memory, MCP, browser, web, ask_bot, team tools)
                          and learning/ (skills, session search)
test/                     Vitest suites mirroring src/, with shared layers and fixtures in support/
scripts/                  VPS helpers shipped with each release
deploy/test/              systemd test harness for the setup script
.github/workflows/        release.yml: tests, Linux builds and GitHub releases
```

| Script | What it does |
| --- | --- |
| `scripts/install.sh` | Sets up a VPS for Weaver (see [Install on your VPS](#install-on-your-vps)). Published with each release |
| `scripts/weaver-bot-user` | `ensure <bot id>` / `remove <bot id>`: creates or deletes a bot's Linux user (`wb-…`) and fixes its home and workspace. Installed as root's `/usr/local/lib/weaver/weaver-bot-user`; the server runs it through `sudo` |
| `scripts/weaver-update` | Updates the installed server from a release, checked against `SHA256SUMS`, and rolls back if `/v1/health` doesn't answer within 30 seconds. Installed as `/usr/local/bin/weaver-update` |
| `scripts/check-bot-isolation.sh` | Run as root on a VPS to check bots' users can't reach the server's data, each other's files or the local services' ports |

## Releases

`.github/workflows/release.yml` does three things:

1. On every pull request and push: runs the type check, the tests and shellcheck.
2. On pushes to `main`: builds `weaver-server-linux-x64` and `weaver-server-linux-arm64`, and refreshes the rolling [`server-latest`](https://github.com/fiqryq/weaver-core/releases/tag/server-latest) prerelease with them, `install.sh`, `weaver-bot-user`, `weaver-update` and `SHA256SUMS`.
3. On tags named `v*` or `server-v*`: makes a versioned release with the same files.

### Testing `install.sh`

To test it on a real systemd (needs Docker and Bun):

```sh
SKIP_MEMORY=1 ./deploy/test/run.sh
```

What it does:

1. Builds the Linux binary for Docker's architecture.
2. Runs the setup script twice in a Debian container with systemd as PID 1 (in its `SKIP_TAILSCALE=1` test mode), then reboots it.
3. Each time, checks the services, the API, bot isolation, the firewall, backups and `weaver-update`, including a rollback.

Leave out `SKIP_MEMORY=1` to install Basic Memory too. It needs about 2 GB more disk.
