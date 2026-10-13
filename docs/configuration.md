# Configuration

[← Back to the README](../README.md)

Machine sizing, how to change what `install.sh` sets up, every environment variable the server reads, and where its data lives.

## Machine sizing

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

## What the installer sets up

- This server, as the `weaver-agent` systemd service, checked against the release's `SHA256SUMS`
- Tailscale, plus a firewall (ufw) that only allows SSH and Tailscale
- A separate Linux user for each bot
- Camoufox, a virtual desktop (Xvfb and noVNC), Glances for machine stats, and Basic Memory
- `weaver-update` (and one-click updates from the app), `weaver-backup`, `weaver-restore`, nightly backups and `weaver-firewall`

Good to know:

- The same command is behind **Copy Setup Command** in Weaver (on the first-run screen, or in **Settings › Computer**).
- Not root? It asks for your password and reruns itself with sudo.
- No curl yet? Run `apt-get install -y curl` first.
- Running it again is safe. It keeps your token and data and updates everything.

## Installer options

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

The full list is at the top of [`scripts/install.sh`](../scripts/install.sh).

## Updating

```sh
sudo weaver-update            # latest server-latest build
sudo weaver-update v0.2.0     # a tagged release
sudo weaver-update --force    # reinstall even if the binary hasn't changed
```

It checks the download against `SHA256SUMS` and rolls back if `/v1/health` doesn't answer within 30 seconds. It also refreshes `weaver-bot-user`, `weaver-backup`, `weaver-restore` and itself.

One-click updates from the app are explained in [Development](development.md#one-click-updates).

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

### Updates

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEAVER_UPDATE_URL` | `https://github.com/fiqryq/weaver-core/releases/download` | Where releases are read from, as `<url>/<tag>/<file>`. `weaver-update` reads it from `/etc/weaver/agent.env` too |
| `WEAVER_UPDATE_REPO` | `fiqryq/weaver-core` | GitHub repository whose newest release is the `stable` channel (`latest` is the `server-latest` build) |
| `WEAVER_UPDATE_DIR` | `/var/lib/weaver-update` | Folder shared with the root-side updater: the server writes `request` and reads `status.json` |

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
