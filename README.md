# weaver-core

[![Release](https://img.shields.io/github/v/release/fiqryq/weaver-core?label=release)](https://github.com/fiqryq/weaver-core/releases/latest)
[![CI](https://github.com/fiqryq/weaver-core/actions/workflows/release.yml/badge.svg)](https://github.com/fiqryq/weaver-core/actions/workflows/release.yml)
![Platform](https://img.shields.io/badge/platform-Ubuntu%20%7C%20Debian-blue)

The agent server behind **Weaver**, a Mac app for running a crew of AI bots on your own computer in the cloud.

It runs on your VPS and does the actual work. The Mac app talks to it over [Tailscale](https://tailscale.com).

## What bots can do

- **Work on a real computer.** Each bot gets its own workspace and Linux user. Bots run commands, read and edit files, and ask before risky steps.
- **Browse the web.** With [camofox-browser](https://github.com/jo-inc/camofox-browser) or Playwright, on a virtual desktop you can watch live. `web_search` and `web_fetch` work without a browser.
- **Use your models and apps.** Any OpenAI-compatible model, with presets for DeepSeek, OpenAI, Qwen, Kimi, GLM and MiniMax. MCP servers become integrations; hosted apps like Notion or Linear sign in with OAuth.
- **Remember and learn.** A shared [Basic Memory](https://github.com/basicmachines-co/basic-memory) knowledge base, a Core Memory note about you, and `SKILL.md` skills from GitHub, a catalog, or written by the bots themselves.
- **Work together.** Bots hand work to each other with `ask_bot`. Teams have a manager and members with roles: you brief the manager, the team works in a room and reports back.
- **Build their own team.** Ask for one ("I need a mini team for my brand"). The bot proposes bots, roles and skills, and creates them once you approve.

Built with [Bun](https://bun.sh), [Effect 4](https://effect.website) and SQLite, shipped as a single binary.

## Install on your VPS

**You need** a fresh Ubuntu 24.04 or Debian 12 machine with root SSH (2 vCPU and 4 GB memory recommended; 1 vCPU and 2 GB with swap works), and [Tailscale](https://tailscale.com) on your Mac. No public IP or open ports beyond SSH.

1. SSH into the VPS and run:

   ```sh
   curl -fsSL https://github.com/fiqryq/weaver-core/releases/download/server-latest/install.sh | bash
   ```

2. Open the Tailscale link it prints and sign in with the same account as your Mac.
3. Click the `weaver://connect` link it prints at the end. Weaver fills in everything else.
4. In Weaver, add a model provider key in **Settings › Models**.

You're done when a bot replies. The same command is behind **Copy Setup Command** in Weaver, and running it again is safe.

The installer sets up the `weaver-agent` service, Tailscale with a firewall, a Linux user per bot, the browser and virtual desktop, Basic Memory, machine stats, nightly backups, and updates. To skip or change parts (`SKIP_BROWSER=1`, `BROWSER_ENGINE=playwright`, …), see [Configuration](docs/configuration.md#installer-options).

<details>
<summary>On a 2 GB machine, add swap first</summary>

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

</details>

## Updating

**From the app:** **Settings › Computer** shows the server's version and offers **Update** when a newer release is out (Stable follows `server-v*` releases, Latest follows `main`).

**From the VPS:**

```sh
sudo weaver-update            # latest build from main
sudo weaver-update v0.3.0     # a tagged release
```

Every update is checked against the release's `SHA256SUMS` and rolls back if the server doesn't come back within 30 seconds. On a VPS set up before one-click updates, run `sudo weaver-update` until the app stops asking.

## Troubleshooting

| Problem | Do this |
| --- | --- |
| The app can't connect | `systemctl status weaver-agent`, then `journalctl -u weaver-agent -n 50` |
| Wrong address | Check `WEAVER_LISTEN` in `/etc/weaver/agent.env` |
| Lost the token | `sudo cat /etc/weaver/server-token` |
| Connect by hand | In **Settings › Computer**, enter `http://<tailscale-ip>:7700` and the token |

## Development

```sh
bun install
WEAVER_TOKEN=dev-token-change-me WEAVER_LISTEN=127.0.0.1:7700 WEAVER_DATA_DIR=/tmp/weaver bun src/main.ts
curl http://127.0.0.1:7700/v1/health
```

`bun run test` runs the tests, `bun run check` type-checks, and `bun run build` compiles a single binary.

## Documentation

- [Configuration](docs/configuration.md): installer options, every environment variable, and where data lives
- [API](docs/api.md): routes, authentication, and how teams run
- [Development](docs/development.md): running locally with a browser and memory, the code layout, scripts, releases, and testing `install.sh`

The Mac app lives in [weaver-client](https://github.com/fiqryq/weaver-client).

## Star History

<a href="https://www.star-history.com/#fiqryq/weaver-core&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=fiqryq/weaver-core&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=fiqryq/weaver-core&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=fiqryq/weaver-core&type=Date" />
  </picture>
</a>
