#!/usr/bin/env bash
# Checks, on a VPS set up with weaver-vps-setup.sh, that bot commands (run as WEAVER_BOT_USER) can
# use their workspaces and the desktop but can't reach the agent server's secrets or skills.
# Run as root: sudo bash check-bot-isolation.sh
# shellcheck disable=SC2016,SC2329 # "$1" in sh -c is meant for the inner shell; as_bot runs via expect_*.
set -uo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root, for example: sudo bash check-bot-isolation.sh" >&2
  exit 1
fi

ENV_FILE=/etc/weaver/agent.env
setting() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n1; }
SERVICE_USER=weaver
BOT_USER="$(setting WEAVER_BOT_USER)"
BOT_GROUP="$(setting WEAVER_BOT_GROUP)"
BOT_GROUP="${BOT_GROUP:-weaver-work}"
DATA_DIR="$(setting WEAVER_DATA_DIR)"
DATA_DIR="${DATA_DIR:-/var/lib/weaver}"
DISPLAY_NUMBER="$(setting DISPLAY)"
DISPLAY_NUMBER="${DISPLAY_NUMBER:-:1}"

if [ -z "$BOT_USER" ]; then
  echo "WEAVER_BOT_USER isn't set in $ENV_FILE, so bot commands run as $SERVICE_USER. Rerun the setup script." >&2
  exit 1
fi

FAILED=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }
expect_ok() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi; }
expect_denied() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$what"; else pass "$what"; fi; }

# Runs a command the way the agent server does: as the service user, through sudo, with umask 007.
as_bot() { runuser -u "$SERVICE_USER" -- sudo -n -u "$BOT_USER" -H -- bash -c 'umask 007; "$@"' bot "$@"; }
as_server() { runuser -u "$SERVICE_USER" -- bash -c 'umask 007; "$@"' server "$@"; }

echo "Accounts"
expect_ok "$SERVICE_USER can run commands as $BOT_USER through sudo" runuser -u "$SERVICE_USER" -- sudo -n -u "$BOT_USER" -- true
expect_denied "$BOT_USER can't use sudo" as_bot sudo -n true
if id -nG "$BOT_USER" | tr ' ' '\n' | grep -qx "$SERVICE_USER"; then fail "$BOT_USER isn't in the $SERVICE_USER group"; else pass "$BOT_USER isn't in the $SERVICE_USER group"; fi
for user in "$SERVICE_USER" "$BOT_USER"; do
  if id -nG "$user" | tr ' ' '\n' | grep -qx "$BOT_GROUP"; then pass "$user is in $BOT_GROUP"; else fail "$user is in $BOT_GROUP"; fi
done
if [ "$(sysctl -n fs.protected_hardlinks 2>/dev/null)" = 1 ]; then pass "fs.protected_hardlinks is on"; else fail "fs.protected_hardlinks is on"; fi

echo "The agent server"
AGENT_PID="$(systemctl show -p MainPID --value weaver-agent 2>/dev/null)"
if [ -n "$AGENT_PID" ] && [ "$AGENT_PID" != 0 ]; then
  expect_denied "$BOT_USER can't read the server's environment (/proc/$AGENT_PID/environ)" as_bot cat "/proc/$AGENT_PID/environ"
  if grep -q '^Umask:[[:space:]]*0007' "/proc/$AGENT_PID/status"; then pass "the server runs with umask 0007"; else fail "the server runs with umask 0007"; fi
  BOT_GID="$(getent group "$BOT_GROUP" | cut -d: -f3)"
  if grep '^Groups:' "/proc/$AGENT_PID/status" | tr -s ' \t' '\n' | grep -qx "$BOT_GID"; then pass "the server is in $BOT_GROUP"; else fail "the server is in $BOT_GROUP (restart weaver-agent)"; fi
else
  fail "weaver-agent is running"
fi
for file in /etc/weaver/*; do
  [ -f "$file" ] && expect_denied "$BOT_USER can't read $file" as_bot cat "$file"
done
expect_denied "$BOT_USER can't list $DATA_DIR" as_bot ls "$DATA_DIR"
for file in "$DATA_DIR"/weaver.db*; do
  [ -e "$file" ] && expect_denied "$BOT_USER can't read $file" as_bot cat "$file"
done
expect_denied "$BOT_USER can't read /home/$SERVICE_USER" as_bot ls "/home/$SERVICE_USER"

echo "Bots"
CLEANUP=""
WORKSPACES=()
for dir in "$DATA_DIR"/bots/*/workspace; do [ -d "$dir" ] && WORKSPACES+=("$dir"); done
if [ "${#WORKSPACES[@]}" -eq 0 ]; then
  # No bots yet: check a stand-in laid out the way the server lays out a new bot.
  CLEANUP="$DATA_DIR/bots/isolation-check"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 711 "$CLEANUP"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$CLEANUP/skills"
  install -d -o "$SERVICE_USER" -g "$BOT_GROUP" -m 2770 "$CLEANUP/workspace"
  WORKSPACES=("$CLEANUP/workspace")
  echo "  (no bots yet, so this checks a stand-in at $CLEANUP)"
fi
for workspace in "${WORKSPACES[@]}"; do
  bot_dir="$(dirname "$workspace")"
  probe="$workspace/.isolation-check-$$"
  expect_ok "$BOT_USER can write $workspace" as_bot sh -c 'echo bot > "$1"' sh "$probe"
  expect_ok "the server can edit what $BOT_USER wrote" as_server sh -c 'echo server >> "$1"' sh "$probe"
  as_server rm -f "$probe"
  as_server sh -c 'echo server > "$1"' sh "$probe"
  expect_ok "$BOT_USER can edit what the server wrote" as_bot sh -c 'echo bot >> "$1"' sh "$probe"
  as_server rm -f "$probe"
  if [ -e "$DATA_DIR/weaver.db" ]; then
    expect_denied "$BOT_USER can't hard-link the database into $workspace" as_bot ln "$DATA_DIR/weaver.db" "$probe"
    as_server rm -f "$probe"
  fi
  if [ -d "$bot_dir/skills" ]; then
    expect_denied "$BOT_USER can't list $bot_dir/skills" as_bot ls "$bot_dir/skills"
    expect_denied "$BOT_USER can't write in $bot_dir/skills" as_bot touch "$bot_dir/skills/.isolation-check"
  fi
  expect_denied "$BOT_USER can't list $bot_dir" as_bot ls "$bot_dir"
done
[ -n "$CLEANUP" ] && rm -rf "$CLEANUP"

echo "Desktop"
X_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUMBER#:}"
# Sends an X11 connection setup and expects "success" back, without needing any X client installed.
X_HELLO='import socket, struct, sys
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])
s.sendall(struct.pack("<cxHHHHxx", b"l", 11, 0, 0, 0))
sys.exit(0 if s.recv(1) == b"\x01" else 1)'
expect_ok "$BOT_USER can open windows on DISPLAY=$DISPLAY_NUMBER" as_bot python3 -c "$X_HELLO" "$X_SOCKET"

echo
if [ "$FAILED" -eq 0 ]; then echo "Bot commands are isolated."; else echo "Some checks failed; rerun the setup script and check again."; fi
exit "$FAILED"
