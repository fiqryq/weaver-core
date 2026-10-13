# Development

[← Back to the README](../README.md)

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

## Only the server

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

## One-click updates

The Weaver app can install updates too (`GET`/`POST /v1/update`). The server runs unprivileged, so it only writes the release tag to `/var/lib/weaver-update/request`. A root `weaver-update.path` unit notices and starts `weaver-update-request.service`, which runs `weaver-update --from-request` and writes progress to `/var/lib/weaver-update/status.json`. `install.sh` sets this up. On a VPS set up before one-click updates existed, run `sudo weaver-update` until the app stops asking (the first run may only bring in the new `weaver-update`).

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
    updates/              the server's own updates (/v1/update) through the root-side updater
  tools/                  AgentTool, builtin/ (shell, files, memory, MCP, browser, web, ask_bot, team tools)
                          and learning/ (skills, session search)
test/                     Vitest suites mirroring src/, with shared layers and fixtures in support/
scripts/                  VPS helpers shipped with each release
deploy/test/              systemd test harness for the setup script
.github/workflows/        release.yml: tests, Linux builds and GitHub releases
```

| Script | What it does |
| --- | --- |
| `scripts/install.sh` | Sets up a VPS for Weaver (see [Install on your VPS](../README.md#install-on-your-vps)). Published with each release |
| `scripts/weaver-bot-user` | `ensure <bot id>` / `remove <bot id>`: creates or deletes a bot's Linux user (`wb-…`) and fixes its home and workspace. Installed as root's `/usr/local/lib/weaver/weaver-bot-user`; the server runs it through `sudo` |
| `scripts/weaver-update` | Updates the installed server from a release, checked against `SHA256SUMS`, and rolls back if `/v1/health` doesn't answer within 30 seconds. Also sets up and runs one-click updates (`--install-updater`, `--from-request`, `--status-file`). Installed as `/usr/local/bin/weaver-update` |
| `scripts/weaver-backup`, `scripts/weaver-restore` | Back up everything Weaver needs into one file, and put such a backup back. Installed in `/usr/local/bin` |
| `scripts/check-bot-isolation.sh` | Run as root on a VPS to check bots' users can't reach the server's data, each other's files or the local services' ports |

## Releases

`.github/workflows/release.yml` does three things:

1. On every pull request and push: runs the type check, the tests and shellcheck.
2. On pushes to `main`: builds `weaver-server-linux-x64` and `weaver-server-linux-arm64`, and refreshes the rolling [`server-latest`](https://github.com/fiqryq/weaver-core/releases/tag/server-latest) prerelease with them, `install.sh`, `weaver-bot-user`, `weaver-update`, `weaver-backup`, `weaver-restore`, `release.json` (version, commit, tag, date and notes, which servers read to offer updates) and `SHA256SUMS`. The binaries report their version (from a `server-v1.2.3` or `v1.2.3` tag, else `package.json`), commit and build time on `/v1/health`; `bun run build` (`build.ts`) stamps them.
3. On tags named `v*` or `server-v*`: makes a versioned release with the same files.

### Testing `install.sh`

To test it on a real systemd (needs Docker and Bun):

```sh
SKIP_MEMORY=1 ./deploy/test/run.sh
```

What it does:

1. Builds the Linux binary for Docker's architecture.
2. Runs the setup script twice in a Debian container with systemd as PID 1 (in its `SKIP_TAILSCALE=1` test mode), then reboots it.
3. Each time, checks the services, the API, bot isolation, the firewall, backups and `weaver-update`, including a rollback, and one-click updates through `POST /v1/update`.

Leave out `SKIP_MEMORY=1` to install Basic Memory too. It needs about 2 GB more disk.
