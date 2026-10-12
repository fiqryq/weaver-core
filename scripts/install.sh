#!/usr/bin/env bash
# Sets up an Ubuntu or Debian VPS as the bots' computer for Weaver:
# Tailscale, a virtual desktop served through noVNC, Glances stats, Basic Memory, the bots' browser
# (Camoufox, shown on the desktop) and the Weaver agent server that runs the bots. Each bot's commands run as its own unprivileged
# user (wb-...) that can't read the server's data, other bots' files or the local services' ports.
# Also installs weaver-update (updates the agent server) and a nightly backup of its database.
# Safe to run again; it updates what is already installed and keeps existing tokens.
#
#   curl -fsSL https://github.com/fiqryq/weaver-core/releases/download/server-latest/install.sh | bash
#
# Options go before bash, for example `curl -fsSL … | SKIP_BROWSER=1 bash`. Run as a user other
# than root, it reruns itself through sudo with the same options.
#
# Optional environment variables:
#   TS_AUTHKEY=tskey-...   log in to Tailscale without opening a browser
#   SKIP_FIREWALL=1        leave ufw alone
#   SCREEN_SIZE=1280x800   virtual desktop resolution
#   MEMORY_TOKEN=...       also require this bearer token for Basic Memory (16+ letters, digits, . _ ~ -),
#                          through a small Caddy proxy. "generate" makes one, "off" removes it.
#                          Left unset, a rerun keeps whatever was set up before.
#   WEAVER_SERVER_BINARY=/path/to/weaver-server   install this agent server binary instead of downloading one
#   WEAVER_SERVER_URL=https://...                 download the agent server from here instead; SHA256SUMS
#                                                 and the helper scripts are read from the same folder
#   WEAVER_SERVER_SHA256=...                      expected SHA-256 of the download, instead of SHA256SUMS
#   WEAVER_HELPERS_DIR=/path                      install weaver-bot-user and weaver-update from this folder
#                                                 instead of downloading them from the release
#   BROWSER_ENGINE=camofox the bots' browser: camofox (the default) runs Camoufox, a Firefox build, as its own
#                          service (weaver-camofox) on the virtual desktop; playwright installs Chromium for
#                          Playwright MCP instead (the older setup)
#   SKIP_BROWSER=1         don't install a browser; bots have no browser tool. Removes Camoufox if an
#                          earlier run installed it (its saved logins in /var/lib/weaver-browser stay).
#   SKIP_MEMORY=1          don't install Basic Memory (about 0.8 GB of disk and 0.5 GB of RAM); bots keep
#                          their own skills but have no shared memory. Removes it if an earlier run installed it.
#   SKIP_TAILSCALE=1       for tests: don't install or log in to Tailscale, and serve everything on
#                          LISTEN_IP (default 127.0.0.1) instead of the Tailscale address
#   WEAVER_INSTALL_URL=https://...                where a non-root run downloads this script again for sudo
set -euo pipefail

# The whole script is one block, so bash reads all of it before running any: a `curl | bash` download
# that's cut short runs nothing, and commands inside can't read the rest of the script as their input.
{

INSTALL_URL="${WEAVER_INSTALL_URL:-https://github.com/fiqryq/weaver-core/releases/download/server-latest/install.sh}"
if [ "$(id -u)" -ne 0 ]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Run this as root (sudo isn't installed)." >&2
    exit 1
  fi
  # sudo starts with a clean environment, so the options are passed on by name.
  OPTIONS=()
  for var in TS_AUTHKEY SKIP_FIREWALL SCREEN_SIZE MEMORY_TOKEN WEAVER_SERVER_BINARY WEAVER_SERVER_URL \
    WEAVER_SERVER_SHA256 WEAVER_HELPERS_DIR BROWSER_ENGINE SKIP_BROWSER SKIP_MEMORY SKIP_TAILSCALE LISTEN_IP \
    WEAVER_INSTALL_URL; do
    if [ -n "${!var+set}" ]; then OPTIONS+=("$var=${!var}"); fi
  done
  if [ -f "${BASH_SOURCE[0]:-}" ]; then
    exec sudo env "${OPTIONS[@]}" bash "${BASH_SOURCE[0]}" "$@"
  fi
  # Piped from curl, there's no file to run again, so root downloads the script again.
  curl -fsSL "$INSTALL_URL" | sudo env "${OPTIONS[@]}" bash
  exit
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script supports Ubuntu and Debian (apt-get not found)." >&2
  exit 1
fi

SCREEN_SIZE="${SCREEN_SIZE:-1280x800}"
MEMORY_TOKEN="${MEMORY_TOKEN:-}"
if [ -n "$MEMORY_TOKEN" ] && [ "$MEMORY_TOKEN" != generate ] && [ "$MEMORY_TOKEN" != off ] \
  && ! [[ "$MEMORY_TOKEN" =~ ^[A-Za-z0-9._~-]{16,}$ ]]; then
  echo "MEMORY_TOKEN needs at least 16 characters: letters, digits, '.', '_', '~' or '-'." >&2
  exit 1
fi
BROWSER_ENGINE="${BROWSER_ENGINE:-camofox}"
[ -z "${SKIP_BROWSER:-}" ] || BROWSER_ENGINE=off
case "$BROWSER_ENGINE" in
  camofox | playwright | off) ;;
  *) echo "BROWSER_ENGINE needs to be camofox or playwright." >&2; exit 1 ;;
esac
SERVICE_USER=weaver
SERVICE_HOME=/home/$SERVICE_USER
# Each bot's commands run as its own user (wb-...), made by BOT_USER_HELPER and kept in BOTS_GROUP.
# Those users and the server share only BOT_GROUP, which owns the workspaces.
BOTS_GROUP=weaver-bots
BOT_GROUP=weaver-work
# The older shared user for all bots' commands; kept so WEAVER_BOT_USER=weaver-bot still works.
BOT_USER=weaver-bot
BOT_HOME=/home/$BOT_USER
DATA_DIR=/var/lib/weaver
HELPER_DIR=/usr/local/lib/weaver
BOT_USER_HELPER=$HELPER_DIR/weaver-bot-user
# Camoufox runs as its own user, which keeps its logins and cookies in its home; bots can't get in there.
BROWSER_USER=weaver-browser
BROWSER_HOME=/var/lib/$BROWSER_USER
CAMOFOX_PORT=9377
CAMOFOX_KEY_FILE=/etc/weaver/camofox-key
CAMOFOX_ROOT=/opt/weaver/camofox
# camofox-browser and the Camoufox release it was tested with (BUNDLED_CAMOUFOX_RELEASE in its
# lib/camoufox-download.js); change them together. The checksums are the release assets' SHA-256.
CAMOFOX_VERSION=1.18.1
CAMOUFOX_RELEASE=152.0.4-beta.30
CAMOUFOX_SHA256_X86_64=5720d45b894ce1770543de024c6f10d514b38be560fa2dc3226b3d8586caf672
CAMOUFOX_SHA256_ARM64=60447260af8bebdb0ec3f2aa72f687b879e5598367303de2e3fdbc7a5be8c124
RELEASE_URL="https://github.com/fiqryq/weaver-core/releases/download/server-latest"
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

step "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates openssl sudo ufw iptables procps sqlite3 acl \
  xvfb xauth x11-xserver-utils fluxbox x11vnc novnc websockify python3-venv >/dev/null

# Bots' workspaces are shared between the server and each bot's user through POSIX ACLs.
mkdir -p "$DATA_DIR"
ACL_PROBE="$(mktemp -p "$DATA_DIR" .acl-check.XXXXXX)"
if ! setfacl -m u:nobody:rw "$ACL_PROBE" 2>/dev/null; then
  rm -f "$ACL_PROBE"
  echo "The filesystem holding $DATA_DIR doesn't support POSIX ACLs (setfacl failed)." >&2
  echo "Mount it with ACL support (ext4, xfs and btrfs have it by default) and run this script again." >&2
  exit 1
fi
rm -f "$ACL_PROBE"

if [ -n "${SKIP_TAILSCALE:-}" ]; then
  step "Skipping Tailscale (SKIP_TAILSCALE is set)"
  TS_IP="${LISTEN_IP:-127.0.0.1}"
  if ! [[ "$TS_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    echo "LISTEN_IP needs to be an IPv4 address, like 127.0.0.1." >&2
    exit 1
  fi
else
  step "Joining your Tailscale network"
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  if ! tailscale ip -4 >/dev/null 2>&1; then
    if [ -n "${TS_AUTHKEY:-}" ]; then
      tailscale up --authkey "$TS_AUTHKEY"
    else
      echo "Open the link below and sign in with the same account as your Mac."
      tailscale up
    fi
  fi
  TS_IP="$(tailscale ip -4 | head -n1)"
fi

step "Creating the $SERVICE_USER user"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$SERVICE_USER"
fi
# Basic Memory's notes, the VNC password and Playwright's browser profile live here; bot commands stay out.
chmod 750 "$SERVICE_HOME"

step "Creating the users for bot commands"
getent group "$BOT_GROUP" >/dev/null || groupadd --system "$BOT_GROUP"
getent group "$BOTS_GROUP" >/dev/null || groupadd --system "$BOTS_GROUP"
if ! id "$BOT_USER" >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir "$BOT_HOME" --shell /bin/bash "$BOT_USER"
fi
install -d -o "$BOT_USER" -g "$BOT_USER" -m 750 "$BOT_HOME"
usermod -aG "$BOT_GROUP" "$SERVICE_USER"
usermod -aG "$BOT_GROUP" "$BOT_USER"
# Files the server keeps to itself are group $SERVICE_USER, so the bot user must never be in it.
if id -nG "$BOT_USER" | tr ' ' '\n' | grep -qx "$SERVICE_USER"; then
  gpasswd -d "$BOT_USER" "$SERVICE_USER" >/dev/null
fi

SUDOERS_FILE=/etc/sudoers.d/weaver-bot
SUDOERS_NEW="$(mktemp)"
cat > "$SUDOERS_NEW" <<EOF
# The Weaver agent server runs each bot's commands as that bot's user (members of $BOTS_GROUP),
# creates and deletes those users with $BOT_USER_HELPER, and can still use the older shared $BOT_USER.
$SERVICE_USER ALL=($BOT_USER) NOPASSWD: ALL
$SERVICE_USER ALL=(%$BOTS_GROUP) NOPASSWD: ALL
$SERVICE_USER ALL=(root) NOPASSWD: $BOT_USER_HELPER
EOF
if ! visudo -cqf "$SUDOERS_NEW"; then
  rm -f "$SUDOERS_NEW"
  echo "Couldn't write a valid sudo rule for bot commands." >&2
  exit 1
fi
install -o root -g root -m 440 "$SUDOERS_NEW" "$SUDOERS_FILE"
rm -f "$SUDOERS_NEW"
if ! runuser -u "$SERVICE_USER" -- sudo -n -u "$BOT_USER" -- true >/dev/null 2>&1; then
  echo "$SERVICE_USER can't run commands as $BOT_USER through sudo, so bots' commands will fail. Check $SUDOERS_FILE."
fi

# Bots can write their own ~/.ssh, so keep SSH logins as bot users off.
if [ -d /etc/ssh/sshd_config.d ] && grep -qsE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
  SSHD_DROPIN=/etc/ssh/sshd_config.d/60-weaver-bot.conf
  SSHD_RULES="$(printf 'DenyUsers %s\nDenyGroups %s' "$BOT_USER" "$BOTS_GROUP")"
  if [ "$(cat "$SSHD_DROPIN" 2>/dev/null)" != "$SSHD_RULES" ]; then
    SSHD_OLD="$(cat "$SSHD_DROPIN" 2>/dev/null || true)"
    printf '%s\n' "$SSHD_RULES" > "$SSHD_DROPIN"
    if sshd -t >/dev/null 2>&1; then
      systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || true
    else
      if [ -n "$SSHD_OLD" ]; then printf '%s\n' "$SSHD_OLD" > "$SSHD_DROPIN"; else rm -f "$SSHD_DROPIN"; fi
      echo "Couldn't check the SSH config, so SSH logins as bot users weren't turned off."
    fi
  fi
fi

# Stops a bot from hard-linking the server's files into its workspace (on by default; some images turn it off).
printf 'fs.protected_hardlinks = 1\nfs.protected_symlinks = 1\n' > /etc/sysctl.d/60-weaver.conf
sysctl -q -p /etc/sysctl.d/60-weaver.conf >/dev/null 2>&1 \
  || echo "Couldn't turn on fs.protected_hardlinks; check it with: sysctl fs.protected_hardlinks"

step "Setting up the virtual desktop"
VNC_PASSWORD_FILE=$SERVICE_HOME/.vnc/password.txt
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$SERVICE_HOME/.vnc"
if [ ! -s "$VNC_PASSWORD_FILE" ]; then
  # x11vnc only uses the first 8 characters of a password.
  openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 8 > "$VNC_PASSWORD_FILE"
fi
VNC_PASSWORD="$(cat "$VNC_PASSWORD_FILE")"
x11vnc -storepasswd "$VNC_PASSWORD" "$SERVICE_HOME/.vnc/passwd" >/dev/null
chown "$SERVICE_USER:$SERVICE_USER" "$VNC_PASSWORD_FILE" "$SERVICE_HOME/.vnc/passwd"
chmod 600 "$VNC_PASSWORD_FILE" "$SERVICE_HOME/.vnc/passwd"

# The desktop's X server only lets in programs that have its cookie, which is made anew at every start
# in X_AUTH (readable by $SERVICE_USER only, for the desktop's own programs), and the users in
# DISPLAY_GRANTS. Bots' users get neither, so they can't see, list or type into the desktop's windows.
X_AUTH=/run/weaver-x/Xauthority
case "$BROWSER_ENGINE" in
  camofox) DISPLAY_GRANTS=$BROWSER_USER ;;
  # The agent server starts Playwright MCP's Chromium as $SERVICE_USER, without the cookie.
  playwright) DISPLAY_GRANTS=$SERVICE_USER ;;
  *) DISPLAY_GRANTS="" ;;
esac
FLUXBOX_DIR="$SERVICE_HOME/.fluxbox"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$FLUXBOX_DIR"
# A plain background: the default style's picture needs a wallpaper program, and without one fluxbox
# says so in a window on the desktop.
if ! grep -qs '^background.pixmap:' "$FLUXBOX_DIR/overlay"; then
  printf 'background: solid\nbackground.color: #1d232a\nbackground.pixmap: none\n' >> "$FLUXBOX_DIR/overlay"
  chown "$SERVICE_USER:$SERVICE_USER" "$FLUXBOX_DIR/overlay"
fi
if [ "$BROWSER_ENGINE" = camofox ]; then
  # Camoufox sizes its window to the screen in its made-up fingerprint, often larger than this desktop;
  # pinning it to the top left keeps its tabs and address bar on the Screen.
  FLUXBOX_APPS="$FLUXBOX_DIR/apps"
  if ! grep -qs '(class=camoufox)' "$FLUXBOX_APPS"; then
    printf '[app] (class=camoufox)\n  [Position]\t(UPPERLEFT)\t{0 0}\n[end]\n' >> "$FLUXBOX_APPS"
    chown "$SERVICE_USER:$SERVICE_USER" "$FLUXBOX_APPS"
  fi
fi

install -d -o root -g root -m 755 "$HELPER_DIR"
cat > "$HELPER_DIR/weaver-display" <<EOF
#!/bin/sh
# The virtual desktop's X server (DISPLAY=:1) for weaver-display.service, with access control on: only
# programs with the cookie in $X_AUTH and the users in GRANTS can connect.
#   weaver-display clean   as root, before it starts: no planted or leftover socket or lock for :1
#   weaver-display start   as $SERVICE_USER: makes a new cookie and runs Xvfb with it
#   weaver-display grant   as $SERVICE_USER, once it runs: lets GRANTS in by user ID
set -eu
GRANTS="$DISPLAY_GRANTS"
DISPLAY=:1
XAUTHORITY=$X_AUTH
export DISPLAY XAUTHORITY
case "\${1:-}" in
  clean)
    # Every user can write in /tmp, so the socket folder has to be root's, as X expects.
    if [ -L /tmp/.X11-unix ] || { [ -e /tmp/.X11-unix ] && [ "\$(stat -c %u /tmp/.X11-unix)" != 0 ]; }; then
      rm -rf /tmp/.X11-unix
    fi
    install -d -o root -g root -m 1777 /tmp/.X11-unix
    rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
    ;;
  start)
    umask 077
    : > "\$XAUTHORITY"
    xauth -q -f "\$XAUTHORITY" add "\$DISPLAY" MIT-MAGIC-COOKIE-1 "\$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"
    # With no cookie in the file, Xvfb would let every local user in.
    [ -n "\$(xauth -f "\$XAUTHORITY" list "\$DISPLAY")" ]
    # -noreset: otherwise the grants are dropped whenever the last program disconnects.
    exec Xvfb "\$DISPLAY" -screen 0 ${SCREEN_SIZE}x24 -nolisten tcp -noreset -auth "\$XAUTHORITY"
    ;;
  grant)
    for _ in \$(seq 1 50); do xhost >/dev/null 2>&1 && break; sleep 0.2; done
    xhost | grep -q '^access control enabled'
    for user in \$GRANTS; do xhost "+SI:localuser:\$user" >/dev/null; done
    ;;
  *) echo "Usage: weaver-display clean | start | grant" >&2; exit 2 ;;
esac
EOF
chmod 755 "$HELPER_DIR/weaver-display"

# Programs that need the desktop are bound to this unit (BindsTo), so they only run while it does; they
# stop when it stops, and Wants starts them again when it comes back on its own after a crash.
DISPLAY_USERS="weaver-desktop.service"
[ "$BROWSER_ENGINE" != camofox ] || DISPLAY_USERS="$DISPLAY_USERS weaver-camofox.service"
cat > /etc/systemd/system/weaver-display.service <<EOF
[Unit]
Description=X server of the virtual desktop for Weaver (DISPLAY=:1)
Wants=$DISPLAY_USERS

[Service]
User=$SERVICE_USER
RuntimeDirectory=weaver-x
RuntimeDirectoryMode=0700
ExecStartPre=+$HELPER_DIR/weaver-display clean
ExecStart=$HELPER_DIR/weaver-display start
ExecStartPost=$HELPER_DIR/weaver-display grant
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/bin/weaver-desktop <<EOF
#!/bin/bash
# The virtual desktop's window manager, VNC server and noVNC, for weaver-desktop.service. The X server
# is weaver-display.service; DISPLAY and XAUTHORITY come from the unit.
fluxbox &
x11vnc -display "\$DISPLAY" -rfbauth "\$HOME/.vnc/passwd" -forever -shared -localhost -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 &
# When one of them stops, stop the rest, so systemd starts them all again.
wait -n
exit 1
EOF
chmod +x /usr/local/bin/weaver-desktop

cat > /etc/systemd/system/weaver-desktop.service <<EOF
[Unit]
Description=Virtual desktop for the Weaver bot (window manager, VNC and noVNC)
After=network.target weaver-display.service
BindsTo=weaver-display.service

[Service]
User=$SERVICE_USER
Environment=DISPLAY=:1 XAUTHORITY=$X_AUTH
ExecStart=/usr/local/bin/weaver-desktop
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

step "Installing Glances"
python3 -m venv /opt/weaver/glances
/opt/weaver/glances/bin/pip install -q --upgrade 'glances[web]'

cat > /etc/systemd/system/weaver-glances.service <<EOF
[Unit]
Description=Glances stats API for Weaver
After=network.target

[Service]
User=$SERVICE_USER
ExecStart=/opt/weaver/glances/bin/glances -w --disable-webui
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

install -d -m 755 /etc/weaver
MEMORY_TOKEN_FILE=/etc/weaver/memory-token
MEMORY_TOKEN_VALUE=""
if [ -n "${SKIP_MEMORY:-}" ]; then
step "Removing Basic Memory (SKIP_MEMORY is set)"
systemctl disable --now weaver-memory-proxy weaver-memory >/dev/null 2>&1 || true
rm -f /etc/systemd/system/weaver-memory.service /etc/systemd/system/weaver-memory-proxy.service /etc/weaver/memory.Caddyfile
else
step "Installing Basic Memory"
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL=/usr/local/bin sh >/dev/null
fi
# Basic Memory depends on a FastMCP pre-release, so uv needs --prerelease=allow.
sudo -u "$SERVICE_USER" -H uv tool install --force --prerelease=allow basic-memory >/dev/null

# Basic Memory has no login. With a token, it listens on localhost only and Caddy checks
# "Authorization: Bearer <token>" on the usual port 8765 before passing requests on.
(
  umask 077
  case "$MEMORY_TOKEN" in
    "") ;;
    off) rm -f "$MEMORY_TOKEN_FILE" ;;
    generate) [ -s "$MEMORY_TOKEN_FILE" ] || openssl rand -hex 24 > "$MEMORY_TOKEN_FILE" ;;
    *) printf '%s' "$MEMORY_TOKEN" > "$MEMORY_TOKEN_FILE" ;;
  esac
  )
if [ -s "$MEMORY_TOKEN_FILE" ]; then
  chmod 600 "$MEMORY_TOKEN_FILE"
  MEMORY_TOKEN_VALUE="$(tr -d '[:space:]' < "$MEMORY_TOKEN_FILE")"
fi

if [ -n "$MEMORY_TOKEN_VALUE" ]; then
  MEMORY_LISTEN="--host 127.0.0.1 --port 8766"
  if ! command -v caddy >/dev/null 2>&1; then
    if ! apt-get install -y -qq caddy >/dev/null 2>&1; then
      apt-get install -y -qq gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
      curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
        | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq
      apt-get install -y -qq caddy >/dev/null
    fi
    # The package starts its own Caddy on port 80; Weaver runs a separate one.
    systemctl disable --now caddy >/dev/null 2>&1 || true
  fi
  cat > /etc/weaver/memory.Caddyfile <<EOF
{
	admin off
	auto_https off
}

:8765 {
	@authorized header Authorization "Bearer $MEMORY_TOKEN_VALUE"
	handle @authorized {
		reverse_proxy 127.0.0.1:8766 {
			# Basic Memory only accepts loopback Host headers on its loopback port.
			header_up Host {upstream_hostport}
			flush_interval -1
		}
	}
	handle {
		respond "Unauthorized" 401
	}
}
EOF
  chown root:"$SERVICE_USER" /etc/weaver/memory.Caddyfile
  chmod 640 /etc/weaver/memory.Caddyfile

  cat > /etc/systemd/system/weaver-memory-proxy.service <<EOF
[Unit]
Description=Token check in front of Basic Memory for Weaver
After=network.target weaver-memory.service
Wants=weaver-memory.service

[Service]
User=$SERVICE_USER
ExecStart=$(command -v caddy) run --config /etc/weaver/memory.Caddyfile --adapter caddyfile
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
else
  MEMORY_LISTEN="--host 0.0.0.0 --port 8765"
  if [ -f /etc/systemd/system/weaver-memory-proxy.service ]; then
    systemctl disable --now weaver-memory-proxy >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/weaver-memory-proxy.service /etc/weaver/memory.Caddyfile
  fi
fi

cat > /etc/systemd/system/weaver-memory.service <<EOF
[Unit]
Description=Basic Memory MCP server for Weaver
After=network.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$SERVICE_HOME
ExecStart=$SERVICE_HOME/.local/bin/basic-memory mcp --transport streamable-http $MEMORY_LISTEN
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
fi

step "Installing Node.js (for MCP integrations and the browser)"
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
# Ubuntu's and Debian's own nodejs packages leave npm and npx to a separate package.
if ! command -v npm >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  apt-get install -y -qq npm >/dev/null
fi
if ! command -v npm >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo "Node.js $(node -v 2>/dev/null) is installed without npm and npx, and installing npm didn't add them." >&2
  echo "Install npm (apt-get install npm), then run the script again." >&2
  exit 1
fi

if [ "$BROWSER_ENGINE" != camofox ] && { [ -f /etc/systemd/system/weaver-camofox.service ] || [ -d "$CAMOFOX_ROOT" ]; }; then
  step "Removing Camoufox (the browser is now $BROWSER_ENGINE)"
  systemctl disable --now weaver-camofox >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/weaver-camofox.service "$HELPER_DIR/weaver-camofox"
  rm -rf "$CAMOFOX_ROOT"
fi

if [ "$BROWSER_ENGINE" = playwright ]; then
  step "Installing Chromium for the browser tool"
  # Uses the Playwright version that @playwright/mcp depends on, so the browser build matches.
  npx -y -p @playwright/mcp@latest playwright install-deps chromium >/dev/null 2>&1 \
    || echo "Couldn't install Chromium's system libraries; the browser tool may not start."
  sudo -u "$SERVICE_USER" -H npx -y -p @playwright/mcp@latest playwright install chromium >/dev/null 2>&1 \
    || echo "Couldn't download Chromium; the browser tool may not start."
elif [ "$BROWSER_ENGINE" = camofox ]; then
  step "Installing Camoufox for the browser tool"
  case "$(uname -m)" in
    x86_64 | amd64) CAMOUFOX_ARCH=x86_64 CAMOUFOX_SHA256=$CAMOUFOX_SHA256_X86_64 ;;
    aarch64 | arm64) CAMOUFOX_ARCH=arm64 CAMOUFOX_SHA256=$CAMOUFOX_SHA256_ARM64 ;;
    *) echo "Camoufox supports x86_64 and arm64, not $(uname -m). Run with SKIP_BROWSER=1." >&2; exit 1 ;;
  esac
  # Firefox's libraries and fonts, and make and python3, which installing camofox-browser's
  # better-sqlite3 runs. Newer releases add a t64 suffix to some names.
  BROWSER_PACKAGES=()
  for PACKAGE in libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 libx11-xcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 libegl1 libgl1-mesa-dri libgbm1 \
    fonts-liberation fonts-noto-color-emoji fontconfig unzip make python3; do
    if apt-cache show --no-all-versions "${PACKAGE}t64" >/dev/null 2>&1; then PACKAGE="${PACKAGE}t64"; fi
    BROWSER_PACKAGES+=("$PACKAGE")
  done
  apt-get install -y -qq --no-install-recommends "${BROWSER_PACKAGES[@]}" >/dev/null

  if ! id "$BROWSER_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$BROWSER_HOME" --no-create-home --shell /usr/sbin/nologin "$BROWSER_USER"
  fi
  install -d -o "$BROWSER_USER" -g "$BROWSER_USER" -m 700 "$BROWSER_HOME"
  # The browser service requires this key; the agent server gets it from agent.env.
  (
    umask 077
    [ -s "$CAMOFOX_KEY_FILE" ] || openssl rand -hex 32 > "$CAMOFOX_KEY_FILE"
  )
  chown root:"$BROWSER_USER" "$CAMOFOX_KEY_FILE"
  chmod 640 "$CAMOFOX_KEY_FILE"
  CAMOFOX_KEY="$(tr -d '[:space:]' < "$CAMOFOX_KEY_FILE")"

  # Each version gets its own folder, so a rerun only downloads again when the versions above change.
  CAMOFOX_PKG_DIR="$CAMOFOX_ROOT/camofox-browser-$CAMOFOX_VERSION"
  CAMOUFOX_DIR="$CAMOFOX_ROOT/camoufox-$CAMOUFOX_RELEASE"
  CAMOFOX_APP="$CAMOFOX_PKG_DIR/node_modules/@askjo/camofox-browser"
  if [ ! -f "$CAMOFOX_PKG_DIR/.installed" ] || [ ! -f "$CAMOUFOX_DIR/.installed" ]; then
    # Old versions and unfinished downloads go first, to leave room for the new one.
    systemctl stop weaver-camofox >/dev/null 2>&1 || true
    install -d -o root -g root -m 755 /opt/weaver "$CAMOFOX_ROOT"
    find "$CAMOFOX_ROOT" -mindepth 1 -maxdepth 1 \
      ! \( -path "$CAMOFOX_PKG_DIR" -o -path "$CAMOUFOX_DIR" \) -exec rm -rf {} +
    FREE_MB="$(df -Pm "$CAMOFOX_ROOT" | awk 'NR == 2 { print $4 }')"
    NEED_MB=300
    [ -f "$CAMOUFOX_DIR/.installed" ] || NEED_MB=2200
    if [ "$FREE_MB" -lt "$NEED_MB" ]; then
      echo "Installing Camoufox needs about $NEED_MB MB of free disk space (1.3 GB once installed); $CAMOFOX_ROOT has $FREE_MB MB." >&2
      echo "Free some space, or run with SKIP_BROWSER=1 to set up this computer without a browser." >&2
      exit 1
    fi
  fi
  if [ ! -f "$CAMOFOX_PKG_DIR/.installed" ]; then
    rm -rf "$CAMOFOX_PKG_DIR"
    install -d -o root -g root -m 755 "$CAMOFOX_PKG_DIR"
    # CAMOFOX_SKIP_DOWNLOAD: the browser is downloaded and checked below instead.
    if ! (cd "$CAMOFOX_PKG_DIR" && umask 022 && CAMOFOX_SKIP_DOWNLOAD=1 npm install --no-audit --no-fund \
      --loglevel=error --cache "$WORK_DIR/npm-cache" "@askjo/camofox-browser@$CAMOFOX_VERSION") >"$WORK_DIR/camofox-npm.log" 2>&1; then
      tail -n 20 "$WORK_DIR/camofox-npm.log" >&2
      echo "Couldn't install camofox-browser $CAMOFOX_VERSION. Run the script again, or with SKIP_BROWSER=1." >&2
      exit 1
    fi
    # better-sqlite3's prebuilt binary needs a newer glibc on some systems (2.38 on arm64), so it's
    # compiled here when it doesn't load.
    BETTER_SQLITE3="$CAMOFOX_PKG_DIR/node_modules/better-sqlite3"
    SQLITE_CHECK='new (require(process.argv[1]))(":memory:").close()'
    if ! node -e "$SQLITE_CHECK" "$BETTER_SQLITE3" >/dev/null 2>&1; then
      echo "Compiling better-sqlite3 for this system"
      apt-get install -y -qq --no-install-recommends g++ >/dev/null
      rm -f "$BETTER_SQLITE3"/prebuilds/linux-*.node
      if ! (cd "$CAMOFOX_PKG_DIR" && umask 022 && npm_config_devdir="$WORK_DIR/node-gyp" npm rebuild better-sqlite3 \
        --no-audit --no-fund --loglevel=error --cache "$WORK_DIR/npm-cache") >>"$WORK_DIR/camofox-npm.log" 2>&1 \
        || ! node -e "$SQLITE_CHECK" "$BETTER_SQLITE3" >>"$WORK_DIR/camofox-npm.log" 2>&1; then
        tail -n 20 "$WORK_DIR/camofox-npm.log" >&2
        echo "Couldn't build better-sqlite3 for camofox-browser. Run the script again, or with SKIP_BROWSER=1." >&2
        exit 1
      fi
    fi
    touch "$CAMOFOX_PKG_DIR/.installed"
  fi
  WANTED_RELEASE="$(sed -n "s/^export const BUNDLED_CAMOUFOX_RELEASE = '\(.*\)';\$/\1/p" "$CAMOFOX_APP/lib/camoufox-download.js")"
  if [ "$WANTED_RELEASE" != "$CAMOUFOX_RELEASE" ]; then
    echo "camofox-browser $CAMOFOX_VERSION wants Camoufox ${WANTED_RELEASE:-(unknown)}, but this script pins $CAMOUFOX_RELEASE." >&2
    exit 1
  fi
  if [ ! -f "$CAMOUFOX_DIR/.installed" ]; then
    CAMOUFOX_ZIP="camoufox-$CAMOUFOX_RELEASE-lin.$CAMOUFOX_ARCH.zip"
    echo "Downloading $CAMOUFOX_ZIP (about 650 MB)"
    rm -rf "$CAMOUFOX_DIR" "$CAMOUFOX_DIR.partial"
    # On disk next to the install: /tmp may be a small tmpfs.
    if ! curl -fsSL --retry 3 --connect-timeout 15 -o "$CAMOFOX_ROOT/.$CAMOUFOX_ZIP" \
      "https://github.com/daijro/camoufox/releases/download/v$CAMOUFOX_RELEASE/$CAMOUFOX_ZIP"; then
      rm -f "$CAMOFOX_ROOT/.$CAMOUFOX_ZIP"
      echo "Couldn't download $CAMOUFOX_ZIP. Run the script again, or with SKIP_BROWSER=1." >&2
      exit 1
    fi
    GOT_SHA256="$(sha256sum "$CAMOFOX_ROOT/.$CAMOUFOX_ZIP" | cut -d' ' -f1)"
    if [ "$GOT_SHA256" != "$CAMOUFOX_SHA256" ]; then
      rm -f "$CAMOFOX_ROOT/.$CAMOUFOX_ZIP"
      echo "$CAMOUFOX_ZIP doesn't match its SHA-256 checksum (expected $CAMOUFOX_SHA256, got $GOT_SHA256), so it wasn't installed." >&2
      exit 1
    fi
    echo "Checked $CAMOUFOX_ZIP: sha256 $GOT_SHA256"
    # unzip exits with 1 for warnings only.
    unzip -q "$CAMOFOX_ROOT/.$CAMOUFOX_ZIP" -d "$CAMOUFOX_DIR.partial" || [ "$?" -eq 1 ]
    rm -f "$CAMOFOX_ROOT/.$CAMOUFOX_ZIP"
    if [ ! -x "$CAMOUFOX_DIR.partial/camoufox-bin" ]; then
      echo "$CAMOUFOX_ZIP has no camoufox-bin, so Camoufox wasn't installed." >&2
      exit 1
    fi
    # What camoufox-js reads to tell which build is installed.
    printf '{"version":"%s","release":"%s"}\n' "${CAMOUFOX_RELEASE%-*}" "${CAMOUFOX_RELEASE##*-}" \
      > "$CAMOUFOX_DIR.partial/version.json"
    chown -R root:root "$CAMOUFOX_DIR.partial"
    chmod -R a+rX,go-w "$CAMOUFOX_DIR.partial"
    mv "$CAMOUFOX_DIR.partial" "$CAMOUFOX_DIR"
    touch "$CAMOUFOX_DIR/.installed"
  fi
  # camofox-browser loads uBlock Origin by default; the service can't download it into its read-only install.
  if [ ! -f "$CAMOUFOX_DIR/addons/UBO/manifest.json" ]; then
    (umask 022 && env -u PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD CAMOUFOX_INSTALL_DIR="$CAMOUFOX_DIR" node --input-type=module \
      -e 'const { DefaultAddons, maybeDownloadAddons } = await import(process.argv[1]); await maybeDownloadAddons(DefaultAddons);' \
      "$CAMOFOX_PKG_DIR/node_modules/camoufox-js/dist/addons.js") >"$WORK_DIR/camofox-addons.log" 2>&1 || true
    [ -f "$CAMOUFOX_DIR/addons/UBO/manifest.json" ] \
      || echo "Couldn't download uBlock Origin for Camoufox. The browser works without it; a rerun tries again."
  fi
  [ ! -d "$CAMOUFOX_DIR/addons" ] || chmod -R a+rX,go-w "$CAMOUFOX_DIR/addons"

  install -d -o root -g root -m 755 "$HELPER_DIR"
  cat > "$HELPER_DIR/weaver-camofox" <<EOF
#!/bin/sh
# Starts camofox-browser $CAMOFOX_VERSION for weaver-camofox.service, requiring the access key in
# $CAMOFOX_KEY_FILE. Clients send it as "Authorization: Bearer <key>".
set -eu
CAMOFOX_ACCESS_KEY="\$(tr -d '[:space:]' < $CAMOFOX_KEY_FILE)"
export CAMOFOX_ACCESS_KEY
exec $(command -v node) $CAMOFOX_APP/server.js
EOF
  chmod 755 "$HELPER_DIR/weaver-camofox"

  # The browser window opens on the virtual desktop (DISPLAY=:1), so it shows in Weaver's Screen view;
  # the display lets $BROWSER_USER in by user ID (see weaver-display). Telemetry to the camofox-browser
  # authors is off.
  cat > /etc/systemd/system/weaver-camofox.service <<EOF
[Unit]
Description=Camoufox browser for Weaver's bots (camofox-browser $CAMOFOX_VERSION)
After=network-online.target weaver-display.service weaver-desktop.service
Wants=network-online.target weaver-desktop.service
BindsTo=weaver-display.service

[Service]
User=$BROWSER_USER
Group=$BROWSER_USER
ExecStart=$HELPER_DIR/weaver-camofox
WorkingDirectory=$BROWSER_HOME
StateDirectory=$BROWSER_USER
StateDirectoryMode=0700
UMask=0077
Environment=HOME=$BROWSER_HOME NODE_ENV=production DISPLAY=:1
Environment=CAMOFOX_PORT=$CAMOFOX_PORT CAMOFOX_BIND_HOST=127.0.0.1
Environment=CAMOFOX_INTERACTIVE=desktop CAMOFOX_CRASH_REPORT_ENABLED=false
Environment=CAMOUFOX_INSTALL_DIR=$CAMOUFOX_DIR
Environment=CAMOFOX_PROFILE_DIR=$BROWSER_HOME/profiles CAMOFOX_COOKIES_DIR=$BROWSER_HOME/cookies
Environment=CAMOFOX_UPLOADS_DIR=$BROWSER_HOME/uploads CAMOFOX_TRACES_DIR=$BROWSER_HOME/traces
Restart=on-failure
RestartSec=5
MemoryMax=1536M
NoNewPrivileges=yes
PrivateTmp=yes
# The desktop's X socket, inside the private /tmp.
BindReadOnlyPaths=-/tmp/.X11-unix
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF
fi

step "Installing the Weaver agent server"
case "$(uname -m)" in
  x86_64 | amd64) SERVER_ARCH=x64 ;;
  aarch64 | arm64) SERVER_ARCH=arm64 ;;
  *) echo "The agent server supports x86_64 and arm64, not $(uname -m)." >&2; exit 1 ;;
esac
SERVER_BIN=/usr/local/bin/weaver-server
SERVER_URL="${WEAVER_SERVER_URL:-$RELEASE_URL/weaver-server-linux-$SERVER_ARCH}"
# SHA256SUMS and the helper scripts come from the same release folder as the binary.
SERVER_RELEASE_URL="${SERVER_URL%/*}"

# Downloads $1 to $2 and checks it against the SHA-256 in $3, or against the release's SHA256SUMS
# when $3 is empty. Anything that doesn't match is refused.
download_checked() {
  local url="$1" dest="$2" want="$3" name="${1##*/}" got="" attempt
  for attempt in 1 2 3; do
    if ! curl -fsSL --retry 3 --connect-timeout 15 "$url" -o "$dest"; then
      echo "Couldn't download $url." >&2
      return 1
    fi
    if [ -z "$3" ]; then
      if ! curl -fsSL --retry 3 --connect-timeout 15 "${url%/*}/SHA256SUMS" -o "$WORK_DIR/SHA256SUMS"; then
        echo "Couldn't download ${url%/*}/SHA256SUMS to check $name, so it wasn't installed." >&2
        return 1
      fi
      want="$(awk -v name="$name" '$2 == name || $2 == "*" name { print $1; exit }' "$WORK_DIR/SHA256SUMS")"
      if [ -z "$want" ]; then
        echo "${url%/*}/SHA256SUMS has no checksum for $name, so it wasn't installed." >&2
        return 1
      fi
    fi
    got="$(sha256sum "$dest" | cut -d' ' -f1)"
    if [ "$got" = "${want,,}" ]; then
      echo "Checked $name: sha256 $got"
      return 0
    fi
    # The rolling release is replaced file by file, so a mismatch can be a release mid-upload.
    [ -n "$3" ] || [ "$attempt" -eq 3 ] || sleep 5
  done
  echo "$name doesn't match its SHA-256 checksum (expected $want, got $got), so it wasn't installed." >&2
  return 1
}

if [ -n "${WEAVER_SERVER_BINARY:-}" ]; then
  install -o root -g root -m 755 "$WEAVER_SERVER_BINARY" "$SERVER_BIN.new"
else
  if ! download_checked "$SERVER_URL" "$WORK_DIR/weaver-server" "${WEAVER_SERVER_SHA256:-}"; then
    echo "The agent server wasn't changed. Set WEAVER_SERVER_SHA256 to the checksum you expect, or" >&2
    echo "WEAVER_SERVER_BINARY to a binary you already have, to install one anyway." >&2
    exit 1
  fi
  install -o root -g root -m 755 "$WORK_DIR/weaver-server" "$SERVER_BIN.new"
fi
mv -f "$SERVER_BIN.new" "$SERVER_BIN"

step "Installing weaver-update and the bot user helper"
install -d -o root -g root -m 755 "$HELPER_DIR"
for HELPER in weaver-bot-user weaver-update; do
  if [ -n "${WEAVER_HELPERS_DIR:-}" ]; then
    HELPER_SOURCE="$WEAVER_HELPERS_DIR/$HELPER"
    if [ ! -f "$HELPER_SOURCE" ]; then
      echo "$HELPER_SOURCE is missing (WEAVER_HELPERS_DIR needs weaver-bot-user and weaver-update)." >&2
      exit 1
    fi
  else
    HELPER_SOURCE="$WORK_DIR/$HELPER"
    if ! download_checked "$SERVER_RELEASE_URL/$HELPER" "$HELPER_SOURCE" ""; then
      echo "Set WEAVER_HELPERS_DIR to a folder with weaver-bot-user and weaver-update (weaver-core/scripts)." >&2
      exit 1
    fi
  fi
  case "$HELPER" in
    weaver-bot-user) HELPER_TARGET="$BOT_USER_HELPER" ;;
    *) HELPER_TARGET="/usr/local/bin/$HELPER" ;;
  esac
  install -o root -g root -m 755 "$HELPER_SOURCE" "$HELPER_TARGET.new"
  mv -f "$HELPER_TARGET.new" "$HELPER_TARGET"
done

SERVER_TOKEN_FILE=/etc/weaver/server-token
(
  umask 077
  [ -s "$SERVER_TOKEN_FILE" ] || openssl rand -hex 32 > "$SERVER_TOKEN_FILE"
)
chmod 600 "$SERVER_TOKEN_FILE"
SERVER_TOKEN="$(tr -d '[:space:]' < "$SERVER_TOKEN_FILE")"

# The agent server runs on the same machine, so it reaches Basic Memory on loopback
# (behind the token proxy that's the upstream port, which needs no token).
if [ -n "${SKIP_MEMORY:-}" ]; then
  AGENT_MEMORY_URL=""
  MEMORY_SERVICES=""
elif [ -n "$MEMORY_TOKEN_VALUE" ]; then
  AGENT_MEMORY_URL="http://127.0.0.1:8766/mcp"
  MEMORY_SERVICES="weaver-memory"
else
  AGENT_MEMORY_URL="http://127.0.0.1:8765/mcp"
  MEMORY_SERVICES="weaver-memory"
fi
# WEAVER_BROWSER_COMMAND is only used with WEAVER_BROWSER=playwright; empty also turns the browser
# off for agent servers that predate WEAVER_BROWSER.
case "$BROWSER_ENGINE" in
  camofox)
    BROWSER_SERVICES="weaver-camofox"
    BROWSER_SETTINGS="WEAVER_BROWSER=camofox
WEAVER_CAMOFOX_URL=http://127.0.0.1:$CAMOFOX_PORT
WEAVER_CAMOFOX_KEY=$CAMOFOX_KEY
WEAVER_BROWSER_COMMAND="
    ;;
  playwright)
    BROWSER_SERVICES=""
    BROWSER_SETTINGS="WEAVER_BROWSER=playwright
WEAVER_BROWSER_COMMAND=npx -y @playwright/mcp@latest --browser chromium"
    ;;
  *)
    BROWSER_SERVICES=""
    BROWSER_SETTINGS="WEAVER_BROWSER=off
WEAVER_BROWSER_COMMAND="
    ;;
esac
(
  umask 077
  cat > /etc/weaver/agent.env <<EOF
WEAVER_TOKEN=$SERVER_TOKEN
WEAVER_LISTEN=$TS_IP:7700
WEAVER_DATA_DIR=$DATA_DIR
WEAVER_MEMORY_URL=$AGENT_MEMORY_URL
$BROWSER_SETTINGS
WEAVER_BOT_USER=per-bot
WEAVER_BOT_GROUP=$BOT_GROUP
DISPLAY=:1
EOF
)

step "Keeping bot commands out of the agent server's data"
# Bot users may pass through the data folders to reach bots/<id>/workspace and bots/<id>/home, but
# not list them or open the database or skills. Workspaces are shared through $BOT_GROUP (setgid), and
# with each bot's own user through ACLs that $BOT_USER_HELPER sets.
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 711 "$DATA_DIR" "$DATA_DIR/bots"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$DATA_DIR/backups"
find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name bots -exec chmod -R go-rwx {} +
for BOT_DIR in "$DATA_DIR"/bots/*; do
  if [ ! -d "$BOT_DIR" ] || [ -L "$BOT_DIR" ]; then continue; fi
  chown "$SERVICE_USER:$SERVICE_USER" "$BOT_DIR"
  chmod 711 "$BOT_DIR"
  # home belongs to the bot's own user (see $BOT_USER_HELPER).
  find "$BOT_DIR" -mindepth 1 -maxdepth 1 ! -name workspace ! -name home -exec chmod -R go-rwx {} +
  WORKSPACE="$BOT_DIR/workspace"
  if [ ! -d "$WORKSPACE" ] || [ -L "$WORKSPACE" ]; then continue; fi
  # Only the first run walks the whole workspace; later ones just fix the folder itself.
  if [ "$(stat -c %G "$WORKSPACE")" != "$BOT_GROUP" ]; then
    chgrp -R "$BOT_GROUP" "$WORKSPACE"
    chmod -R g+rwX,o-rwx "$WORKSPACE"
    find "$WORKSPACE" -type d -exec chmod g+s {} +
  fi
  # A workspace already handed to its bot's user keeps that owner; the server hands the others
  # over the first time the bot runs a command.
  if ! id -nG "$(stat -c %U "$WORKSPACE")" 2>/dev/null | tr ' ' '\n' | grep -qx "$BOTS_GROUP"; then
    chown "$SERVICE_USER" "$WORKSPACE"
  fi
  chgrp "$BOT_GROUP" "$WORKSPACE"
  chmod 2770 "$WORKSPACE"
done

AGENT_DEPENDENCIES="${MEMORY_SERVICES:+ $MEMORY_SERVICES.service}${BROWSER_SERVICES:+ $BROWSER_SERVICES.service}"
cat > /etc/systemd/system/weaver-agent.service <<EOF
[Unit]
Description=Weaver agent server (runs the bots)
After=network-online.target tailscaled.service weaver-firewall.service weaver-desktop.service$AGENT_DEPENDENCIES
Wants=network-online.target weaver-firewall.service weaver-desktop.service$AGENT_DEPENDENCIES

[Service]
User=$SERVICE_USER
SupplementaryGroups=$BOT_GROUP
WorkingDirectory=$SERVICE_HOME
EnvironmentFile=/etc/weaver/agent.env
Environment=HOME=$SERVICE_HOME
StateDirectory=weaver
StateDirectoryMode=0711
# Files the server writes in workspaces stay writable for the bot user's group, and nothing is world-readable.
UMask=0007
ExecStart=$SERVER_BIN
Restart=always
# Tailscale may not have its address yet right after boot.
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

step "Keeping bot commands off the local services' ports"
# Bot users can reach what every local user can, so these rules turn away their TCP connections to
# this machine's own addresses (loopback and Tailscale) on Basic Memory, VNC, noVNC, Glances and the
# browser service. Pages the bots open in Camoufox can't reach those services or the agent server either.
cat > "$HELPER_DIR/weaver-firewall" <<EOF
#!/bin/sh
# Rejects TCP connections from Weaver's bot users ($BOT_USER and the $BOTS_GROUP group) to this
# machine's own addresses on the ports of Basic Memory, VNC, noVNC, Glances and the browser service
# ($CAMOFOX_PORT), and new ones from the browser ($BROWSER_USER) to those services and the agent server.
# Run at boot by weaver-firewall.service; safe to run again.
set -eu
PORTS=8765,8766,5900,6080,61208,$CAMOFOX_PORT
BROWSER_PORTS=8765,8766,5900,6080,61208,7700
CHAIN=WEAVER-BOTS
apply() {
  command -v "\$1" >/dev/null 2>&1 || return 0
  "\$1" -w -N "\$CHAIN" 2>/dev/null || "\$1" -w -F "\$CHAIN"
  if id -u $BOT_USER >/dev/null 2>&1; then
    "\$1" -w -A "\$CHAIN" -p tcp -m multiport --dports "\$PORTS" -m addrtype --dst-type LOCAL \\
      -m owner --uid-owner $BOT_USER -j REJECT --reject-with tcp-reset
  fi
  if getent group $BOTS_GROUP >/dev/null 2>&1; then
    "\$1" -w -A "\$CHAIN" -p tcp -m multiport --dports "\$PORTS" -m addrtype --dst-type LOCAL \\
      -m owner --gid-owner $BOTS_GROUP --suppl-groups -j REJECT --reject-with tcp-reset
  fi
  # Only new connections: the browser service's own replies to the agent server pass.
  if id -u $BROWSER_USER >/dev/null 2>&1; then
    "\$1" -w -A "\$CHAIN" -p tcp --syn -m multiport --dports "\$BROWSER_PORTS" -m addrtype --dst-type LOCAL \\
      -m owner --uid-owner $BROWSER_USER -j REJECT --reject-with tcp-reset
  fi
  "\$1" -w -C OUTPUT -j "\$CHAIN" 2>/dev/null || "\$1" -w -I OUTPUT 1 -j "\$CHAIN"
}
apply iptables
apply ip6tables
EOF
chmod 755 "$HELPER_DIR/weaver-firewall"

cat > /etc/systemd/system/weaver-firewall.service <<EOF
[Unit]
Description=Keep Weaver bot users off local service ports
After=network-pre.target ufw.service
Wants=network-pre.target
# ufw rebuilds the firewall when it restarts, so put these rules back after it.
PartOf=ufw.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$HELPER_DIR/weaver-firewall

[Install]
WantedBy=multi-user.target
EOF

step "Setting up nightly backups"
cat > "$HELPER_DIR/weaver-backup" <<EOF
#!/bin/sh
# Backs up the Weaver database, every bot's skills and the skills library into $DATA_DIR/backups and keeps the
# newest 7 of each. Run nightly by weaver-backup.timer as $SERVICE_USER: sudo systemctl start weaver-backup
set -eu
DATA_DIR=$DATA_DIR
BACKUP_DIR=\$DATA_DIR/backups
KEEP=7
STAMP=\$(date +%Y-%m-%d)
umask 077
mkdir -p "\$BACKUP_DIR"
chmod 700 "\$BACKUP_DIR"

if [ -f "\$DATA_DIR/weaver.db" ]; then
  PARTIAL="\$BACKUP_DIR/.weaver-\$STAMP.db.partial"
  rm -f "\$PARTIAL"
  sqlite3 "\$DATA_DIR/weaver.db" ".backup '\$PARTIAL'"
  if [ "\$(sqlite3 "\$PARTIAL" 'PRAGMA quick_check;')" != ok ]; then
    rm -f "\$PARTIAL"
    echo "The database backup failed its integrity check." >&2
    exit 1
  fi
  mv -f "\$PARTIAL" "\$BACKUP_DIR/weaver-\$STAMP.db"
fi

cd "\$DATA_DIR"
set --
for dir in bots/*/skills skills-library; do
  if [ -d "\$dir" ]; then set -- "\$@" "\$dir"; fi
done
if [ "\$#" -gt 0 ]; then
  PARTIAL="\$BACKUP_DIR/.skills-\$STAMP.tar.gz.partial"
  tar -czf "\$PARTIAL" -- "\$@"
  mv -f "\$PARTIAL" "\$BACKUP_DIR/skills-\$STAMP.tar.gz"
fi

# File names sort by date, so the oldest come first.
prune() {
  while [ "\$#" -gt "\$KEEP" ]; do
    rm -f -- "\$1"
    shift
  done
}
prune "\$BACKUP_DIR"/weaver-*.db
prune "\$BACKUP_DIR"/skills-*.tar.gz
echo "Backed up to \$BACKUP_DIR."
EOF
chmod 755 "$HELPER_DIR/weaver-backup"

cat > /etc/systemd/system/weaver-backup.service <<EOF
[Unit]
Description=Back up the Weaver database, bots' skills and the skills library

[Service]
Type=oneshot
User=$SERVICE_USER
Group=$SERVICE_USER
ExecStart=$HELPER_DIR/weaver-backup
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA_DIR
EOF

cat > /etc/systemd/system/weaver-backup.timer <<EOF
[Unit]
Description=Nightly backup of the Weaver database, bots' skills and the skills library

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now weaver-firewall weaver-backup.timer >/dev/null 2>&1
# Before weaver-display existed, weaver-desktop ran the X server itself; it has to be gone first.
systemctl stop weaver-camofox >/dev/null 2>&1 || true
systemctl stop weaver-desktop >/dev/null 2>&1 || true
# shellcheck disable=SC2086
systemctl enable weaver-display weaver-desktop weaver-glances $MEMORY_SERVICES $BROWSER_SERVICES weaver-agent >/dev/null 2>&1
# shellcheck disable=SC2086
systemctl restart weaver-display weaver-desktop weaver-glances $MEMORY_SERVICES $BROWSER_SERVICES weaver-agent
if [ -n "$MEMORY_TOKEN_VALUE" ]; then
  systemctl enable weaver-memory-proxy >/dev/null 2>&1
  systemctl restart weaver-memory-proxy
fi

if [ -z "${SKIP_FIREWALL:-}" ]; then
  if [ -n "${SKIP_TAILSCALE:-}" ]; then
    step "Allowing only SSH traffic"
  else
    step "Allowing only SSH and Tailscale traffic"
  fi
  ufw allow OpenSSH >/dev/null
  if [ -z "${SKIP_TAILSCALE:-}" ]; then
    ufw allow in on tailscale0 >/dev/null
  fi
  ufw default deny incoming >/dev/null
  ufw --force enable >/dev/null
fi
# Applied after ufw, which may have rebuilt the firewall.
systemctl restart weaver-firewall

SCREEN_URL="http://$TS_IP:6080/vnc.html"
STATS_URL="http://$TS_IP:61208"
MEMORY_URL="http://$TS_IP:8765/mcp"
AGENT_URL="http://$TS_IP:7700"
CONNECT_URL="weaver://connect?screen=$SCREEN_URL&stats=$STATS_URL&password=$VNC_PASSWORD"
if [ -z "${SKIP_MEMORY:-}" ]; then
  CONNECT_URL="$CONNECT_URL&memory=$MEMORY_URL"
fi
if [ -n "$MEMORY_TOKEN_VALUE" ]; then
  CONNECT_URL="$CONNECT_URL&memoryToken=$MEMORY_TOKEN_VALUE"
fi
CONNECT_URL="$CONNECT_URL&agent=$AGENT_URL&agentToken=$SERVER_TOKEN"

# weaver-connect prints the link again later. It carries the server token, so only root can read it.
CONNECT_LINK_FILE=/etc/weaver/connect-link
(
  umask 077
  printf '%s\n' "$CONNECT_URL" > "$CONNECT_LINK_FILE"
)
cat > /usr/local/bin/weaver-connect <<EOF
#!/usr/bin/env bash
# Prints the weaver://connect link that connects Weaver on your Mac to this computer. Copy it and click
# Paste Connection Link in Weaver (Settings › Computer), or open it on the Mac.
set -euo pipefail
if [ "\$(id -u)" -ne 0 ]; then exec sudo "\$0" "\$@"; fi
if [ ! -s $CONNECT_LINK_FILE ]; then
  echo "There's no connect link yet. Run Weaver's install script first." >&2
  exit 1
fi
cat $CONNECT_LINK_FILE
EOF
chmod 755 /usr/local/bin/weaver-connect

step "Checking the agent server"
AGENT_OK=""
for _ in $(seq 1 20); do
  if curl -fsS "$AGENT_URL/v1/health" >/dev/null 2>&1; then AGENT_OK=1; break; fi
  sleep 1
done
if [ -z "$AGENT_OK" ]; then
  echo "The agent server didn't answer yet. Check it with: journalctl -u weaver-agent -n 50"
fi
if [ "$BROWSER_ENGINE" = camofox ]; then
  BROWSER_OK=""
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:$CAMOFOX_PORT/health" >/dev/null 2>&1; then BROWSER_OK=1; break; fi
    sleep 1
  done
  if [ -z "$BROWSER_OK" ]; then
    echo "The browser service didn't answer yet. Check it with: journalctl -u weaver-camofox -n 50"
  fi
  # Anything left from versions before this one, now that the service runs from the new folders.
  find "$CAMOFOX_ROOT" -mindepth 1 -maxdepth 1 \
    ! \( -path "$CAMOFOX_PKG_DIR" -o -path "$CAMOUFOX_DIR" \) -exec rm -rf {} +
fi

printf '\n\033[1mDone. This computer is ready for Weaver.\033[0m\n\n'
echo "Connect Weaver with this link: click it on your Mac, or copy it and click Paste Connection Link"
echo "in Weaver (Settings › Computer). Run weaver-connect to see it again."
printf '  \033[4m%s\033[0m\n\n' "$CONNECT_URL"
echo "noVNC password: $VNC_PASSWORD"
echo "Screen:         $SCREEN_URL"
echo "Stats:          $STATS_URL"
if [ -z "${SKIP_MEMORY:-}" ]; then
  echo "Memory:         $MEMORY_URL (notes in $SERVICE_HOME/basic-memory)"
fi
if [ -n "$MEMORY_TOKEN_VALUE" ]; then
  echo "Memory token:   $MEMORY_TOKEN_VALUE (saved in $MEMORY_TOKEN_FILE)"
fi
echo "Agent server:   $AGENT_URL (token in $SERVER_TOKEN_FILE, bot files in $DATA_DIR)"
echo "Bot commands:   each bot runs as its own user (wb-..., home $DATA_DIR/bots/<bot id>/home)"
case "$BROWSER_ENGINE" in
  camofox) echo "Browser:        Camoufox on the Screen (weaver-camofox, logins kept in $BROWSER_HOME)" ;;
  playwright) echo "Browser:        Chromium through Playwright MCP, on the Screen" ;;
  *) echo "Browser:        none (SKIP_BROWSER is set)" ;;
esac
echo "Updates:        sudo weaver-update"
echo "Backups:        nightly in $DATA_DIR/backups (sudo systemctl start weaver-backup to run one now)"

}
