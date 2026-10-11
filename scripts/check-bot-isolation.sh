#!/usr/bin/env bash
# Checks, on a VPS set up with weaver-vps-setup.sh, that bot commands can use their workspaces but can't
# reach the agent server's secrets or skills, other bots' files, the browser service's logins and key,
# the local services' ports, or the virtual desktop (screenshots, keystrokes, window lists), which only
# the desktop's own programs and the browser may connect to.
# With WEAVER_BOT_USER=per-bot it makes two throwaway bot users through weaver-bot-user (the way the
# server does) and removes them again; it also checks the older shared weaver-bot user if it exists.
# Run as root: sudo bash check-bot-isolation.sh
# shellcheck disable=SC2016,SC2329 # "$1" in sh -c is meant for the inner shell; as_* run via expect_*.
set -uo pipefail
cd /

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root, for example: sudo bash check-bot-isolation.sh" >&2
  exit 1
fi

ENV_FILE=/etc/weaver/agent.env
setting() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n1; }
SERVICE_USER=weaver
BOT_MODE="$(setting WEAVER_BOT_USER)"
BOT_GROUP="$(setting WEAVER_BOT_GROUP)"
BOT_GROUP="${BOT_GROUP:-weaver-work}"
BOTS_GROUP=weaver-bots
HELPER=/usr/local/lib/weaver/weaver-bot-user
DATA_DIR="$(setting WEAVER_DATA_DIR)"
DATA_DIR="${DATA_DIR:-/var/lib/weaver}"
DISPLAY_NUMBER="$(setting DISPLAY)"
DISPLAY_NUMBER="${DISPLAY_NUMBER:-:1}"
# Ports bot users must not reach on this machine's own addresses (see weaver-firewall).
BLOCKED_PORTS="8765 8766 5900 6080 61208 9377"
# Camoufox's service user and the files only it (or root) may read.
BROWSER_USER=weaver-browser
BROWSER_HOME=/var/lib/weaver-browser

if [ -z "$BOT_MODE" ]; then
  echo "WEAVER_BOT_USER isn't set in $ENV_FILE, so bot commands run as $SERVICE_USER. Rerun the setup script." >&2
  exit 1
fi
if [ "$BOT_MODE" = per-bot ]; then
  SHARED_USER=weaver-bot
  id "$SHARED_USER" >/dev/null 2>&1 || SHARED_USER=""
else
  SHARED_USER="$BOT_MODE"
fi

FAILED=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }
check() { if "${@:2}" >/dev/null 2>&1; then pass "$1"; else fail "$1"; fi; }
expect_ok() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi; }
expect_denied() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$what"; else pass "$what"; fi; }
in_group() { id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qx "$2"; }

# Runs a command the way the agent server does: as the service user, through sudo, with umask 007.
as_user() { local user="$1"; shift; runuser -u "$SERVICE_USER" -- sudo -n -u "$user" -H -- bash -c 'umask 007; "$@"' bot "$@"; }
as_server() { runuser -u "$SERVICE_USER" -- bash -c 'umask 007; "$@"' server "$@"; }
helper() { runuser -u "$SERVICE_USER" -- sudo -n "$HELPER" "$@"; }
connects() { timeout 3 bash -c 'exec 3<>"/dev/tcp/$1/$2"' connect "$1" "$2"; }

AGENT_PID="$(systemctl show -p MainPID --value weaver-agent 2>/dev/null)"
[ "$AGENT_PID" != 0 ] || AGENT_PID=""
LISTEN="$(setting WEAVER_LISTEN)"
LISTEN_HOST="${LISTEN%:*}"
case "$LISTEN_HOST" in "" | 0.0.0.0) LISTEN_HOST=127.0.0.1 ;; esac

# What every kind of bot user must not reach: the server's settings, database, home and environment.
check_server_secrets() {
  local user="$1" file
  for file in /etc/weaver/*; do
    [ -f "$file" ] && expect_denied "$user can't read $file" as_user "$user" cat "$file"
  done
  expect_denied "$user can't list $DATA_DIR" as_user "$user" ls "$DATA_DIR"
  for file in "$DATA_DIR"/weaver.db*; do
    [ -e "$file" ] && expect_denied "$user can't read $file" as_user "$user" cat "$file"
  done
  [ -d "$DATA_DIR/backups" ] && expect_denied "$user can't list $DATA_DIR/backups" as_user "$user" ls "$DATA_DIR/backups"
  expect_denied "$user can't read /home/$SERVICE_USER" as_user "$user" ls "/home/$SERVICE_USER"
  if [ -n "$AGENT_PID" ]; then
    expect_denied "$user can't read the server's environment (/proc/$AGENT_PID/environ)" as_user "$user" cat "/proc/$AGENT_PID/environ"
  fi
  expect_denied "$user can't use sudo" as_user "$user" sudo -n true
  check_browser "$user"
}

# The browser service's saved logins and cookies, and its process environment with the access key
# (/etc/weaver/camofox-key is covered with the rest of /etc/weaver above).
check_browser() {
  local user="$1" pid
  id "$BROWSER_USER" >/dev/null 2>&1 || return 0
  expect_denied "$user can't list $BROWSER_HOME" as_user "$user" ls "$BROWSER_HOME"
  expect_denied "$user can't run commands as $BROWSER_USER" as_user "$user" sudo -n -u "$BROWSER_USER" true
  pid="$(systemctl show -p MainPID --value weaver-camofox 2>/dev/null)"
  if [ -n "$pid" ] && [ "$pid" != 0 ]; then
    expect_denied "$user can't read the browser service's environment (/proc/$pid/environ)" as_user "$user" cat "/proc/$pid/environ"
  fi
}

# The firewall rules: the server reaches each listening port, the bot user doesn't.
check_ports() {
  local user="$1" port host
  for host in 127.0.0.1 "$LISTEN_HOST"; do
    for port in $BLOCKED_PORTS; do
      as_server bash -c "$(declare -f connects); connects $host $port" >/dev/null 2>&1 || continue
      expect_denied "$user can't connect to $host:$port" as_user "$user" bash -c "$(declare -f connects); connects $host $port"
    done
    [ "$LISTEN_HOST" = 127.0.0.1 ] && break
  done
}

X_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUMBER#:}"
# The desktop's cookie, made by weaver-display.service; only the desktop's own programs read it.
X_AUTH=/run/weaver-x/Xauthority
# Sends an X11 connection setup and succeeds if the X server accepts it, without needing any X client
# installed: python3 -c "$X_HELLO" <socket, or @socket for the abstract one> [cookie file | random]
X_HELLO='import os, socket, struct, sys
name, cookie = b"", b""
if len(sys.argv) > 2:
    name = b"MIT-MAGIC-COOKIE-1"
    cookie = os.urandom(16)
    if sys.argv[2] != "random":
        raw, at = open(sys.argv[2], "rb").read(), 0
        def field():
            global at
            size = struct.unpack(">H", raw[at:at + 2])[0]
            at += 2 + size
            return raw[at - size:at]
        while at < len(raw):
            at += 2
            fields = [field() for _ in range(4)]
            if fields[2] == name:
                cookie = fields[3]
                break
s = socket.socket(socket.AF_UNIX)
s.connect("\0" + sys.argv[1][1:] if sys.argv[1].startswith("@") else sys.argv[1])
pad = lambda data: data + bytes(-len(data) % 4)
s.sendall(struct.pack("<cxHHHHxx", b"l", 11, 0, len(name), len(cookie)) + pad(name) + pad(cookie))
sys.exit(0 if s.recv(1) == b"\x01" else 1)'
x_hello() { python3 -c "$X_HELLO" "$@"; }
check_desktop() {
  local user="$1" tool
  expect_denied "$user can't connect to the desktop (DISPLAY=$DISPLAY_NUMBER)" as_user "$user" python3 -c "$X_HELLO" "$X_SOCKET"
  expect_denied "$user can't connect to it through the abstract socket" as_user "$user" python3 -c "$X_HELLO" "@$X_SOCKET"
  expect_denied "$user can't connect to it with a made-up cookie" as_user "$user" python3 -c "$X_HELLO" "$X_SOCKET" random
  expect_denied "$user can't read the desktop's cookie ($X_AUTH)" as_user "$user" cat "$X_AUTH"
  for tool in xdpyinfo "xwininfo -root -tree"; do
    command -v "${tool%% *}" >/dev/null 2>&1 || continue
    # shellcheck disable=SC2086 # the tool's arguments
    expect_denied "$user can't run $tool on it, even with XAUTHORITY=$X_AUTH" \
      as_user "$user" env DISPLAY="$DISPLAY_NUMBER" XAUTHORITY="$X_AUTH" $tool
  done
}

echo "Accounts"
if [ "$(sysctl -n fs.protected_hardlinks 2>/dev/null)" = 1 ]; then pass "fs.protected_hardlinks is on"; else fail "fs.protected_hardlinks is on"; fi
if in_group "$SERVICE_USER" "$BOT_GROUP"; then pass "$SERVICE_USER is in $BOT_GROUP"; else fail "$SERVICE_USER is in $BOT_GROUP"; fi
if [ -n "$SHARED_USER" ]; then
  expect_ok "$SERVICE_USER can run commands as $SHARED_USER through sudo" runuser -u "$SERVICE_USER" -- sudo -n -u "$SHARED_USER" -- true
  if in_group "$SHARED_USER" "$SERVICE_USER"; then fail "$SHARED_USER isn't in the $SERVICE_USER group"; else pass "$SHARED_USER isn't in the $SERVICE_USER group"; fi
  if in_group "$SHARED_USER" "$BOT_GROUP"; then pass "$SHARED_USER is in $BOT_GROUP"; else fail "$SHARED_USER is in $BOT_GROUP"; fi
fi
if id "$BROWSER_USER" >/dev/null 2>&1; then
  for group in "$SERVICE_USER" "$BOT_GROUP" "$BOTS_GROUP"; do
    if in_group "$BROWSER_USER" "$group"; then fail "$BROWSER_USER isn't in $group"; else pass "$BROWSER_USER isn't in $group"; fi
  done
  expect_denied "$SERVICE_USER can't run commands as $BROWSER_USER" runuser -u "$SERVICE_USER" -- sudo -n -u "$BROWSER_USER" -- true
  if [ "$(stat -c '%U %a' "$BROWSER_HOME" 2>/dev/null)" = "$BROWSER_USER 700" ]; then pass "$BROWSER_HOME is $BROWSER_USER's, 0700"; else fail "$BROWSER_HOME is $BROWSER_USER's, 0700"; fi
fi

echo "The agent server"
if [ -n "$AGENT_PID" ]; then
  if grep -q '^Umask:[[:space:]]*0007' "/proc/$AGENT_PID/status"; then pass "the server runs with umask 0007"; else fail "the server runs with umask 0007"; fi
  BOT_GID="$(getent group "$BOT_GROUP" | cut -d: -f3)"
  if grep '^Groups:' "/proc/$AGENT_PID/status" | tr -s ' \t' '\n' | grep -qx "$BOT_GID"; then pass "the server is in $BOT_GROUP"; else fail "the server is in $BOT_GROUP (restart weaver-agent)"; fi
else
  fail "weaver-agent is running"
fi

if [ -n "$SHARED_USER" ]; then
  echo "The shared bot user ($SHARED_USER)"
  check_server_secrets "$SHARED_USER"
  CLEANUP=""
  WORKSPACES=()
  # In per-bot mode the bots' workspaces belong to their own users, so only a stand-in is checked here.
  if [ "$BOT_MODE" != per-bot ]; then
    for dir in "$DATA_DIR"/bots/*/workspace; do [ -d "$dir" ] && WORKSPACES+=("$dir"); done
  fi
  if [ "${#WORKSPACES[@]}" -eq 0 ]; then
    CLEANUP="$DATA_DIR/bots/isolation-check-shared"
    install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 711 "$CLEANUP"
    install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$CLEANUP/skills"
    install -d -o "$SERVICE_USER" -g "$BOT_GROUP" -m 2770 "$CLEANUP/workspace"
    WORKSPACES=("$CLEANUP/workspace")
    echo "  (checking a stand-in at $CLEANUP)"
  fi
  for workspace in "${WORKSPACES[@]}"; do
    bot_dir="$(dirname "$workspace")"
    probe="$workspace/.isolation-check-$$"
    expect_ok "$SHARED_USER can write $workspace" as_user "$SHARED_USER" sh -c 'echo bot > "$1"' sh "$probe"
    expect_ok "the server can edit what $SHARED_USER wrote" as_server sh -c 'echo server >> "$1"' sh "$probe"
    as_server rm -f "$probe"
    as_server sh -c 'echo server > "$1"' sh "$probe"
    expect_ok "$SHARED_USER can edit what the server wrote" as_user "$SHARED_USER" sh -c 'echo bot >> "$1"' sh "$probe"
    as_server rm -f "$probe"
    if [ -e "$DATA_DIR/weaver.db" ]; then
      expect_denied "$SHARED_USER can't hard-link the database into $workspace" as_user "$SHARED_USER" ln "$DATA_DIR/weaver.db" "$probe"
      as_server rm -f "$probe"
    fi
    if [ -d "$bot_dir/skills" ]; then
      expect_denied "$SHARED_USER can't list $bot_dir/skills" as_user "$SHARED_USER" ls "$bot_dir/skills"
      expect_denied "$SHARED_USER can't write in $bot_dir/skills" as_user "$SHARED_USER" touch "$bot_dir/skills/.isolation-check"
    fi
    expect_denied "$SHARED_USER can't list $bot_dir" as_user "$SHARED_USER" ls "$bot_dir"
  done
  [ -n "$CLEANUP" ] && rm -rf "$CLEANUP"
  check_ports "$SHARED_USER"
fi

if [ "$BOT_MODE" = per-bot ] || [ -e "$HELPER" ]; then
  echo "Per-bot users ($HELPER)"
  if [ "$(stat -c '%U:%G %a' "$HELPER" 2>/dev/null)" = "root:root 755" ]; then pass "$HELPER is root:root 0755"; else fail "$HELPER is root:root 0755"; fi
  if [ "$(stat -c '%U %A' "$(dirname "$HELPER")" 2>/dev/null)" = "root drwxr-xr-x" ]; then pass "$(dirname "$HELPER") belongs to root"; else fail "$(dirname "$HELPER") belongs to root"; fi
  check "the $BOTS_GROUP group exists" getent group "$BOTS_GROUP"

  for bad in ../etc a/b "a b" --- "$(printf 'x%.0s' $(seq 1 65))" "-"; do
    expect_denied "the helper refuses the bot id '${bad:0:20}'" helper ensure "$bad"
  done

  RANDOM_PART="$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')"
  BOT_A="ic${RANDOM_PART}-isolation-check-a"
  BOT_B="ic${RANDOM_PART:0:8}ff-isolation-check-b"
  USER_A="wb-ic${RANDOM_PART}"
  USER_B="wb-ic${RANDOM_PART:0:8}ff"
  [ "$USER_A" != "$USER_B" ] || USER_B="wb-ic${RANDOM_PART:0:8}fe" BOT_B="ic${RANDOM_PART:0:8}fe-isolation-check-b"
  DIR_A="$DATA_DIR/bots/$BOT_A"
  DIR_B="$DATA_DIR/bots/$BOT_B"
  TRAP_DIR="$(mktemp -d)"
  SYMLINK_BOT="ic${RANDOM_PART}-isolation-link"
  cleanup_per_bot() {
    helper remove "$BOT_A" >/dev/null 2>&1
    helper remove "$BOT_B" >/dev/null 2>&1
    rm -rf "$DIR_A" "$DIR_B" "$TRAP_DIR"
    rm -f "$DATA_DIR/bots/$SYMLINK_BOT"
  }
  trap cleanup_per_bot EXIT

  # A symlink planted where a bot folder (or its home) should be must not let root touch its target.
  ln -s "$TRAP_DIR" "$DATA_DIR/bots/$SYMLINK_BOT"
  expect_denied "the helper refuses a bot folder that is a symlink" helper ensure "$SYMLINK_BOT"
  rm -f "$DATA_DIR/bots/$SYMLINK_BOT"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 711 "$DIR_A"
  ln -s "$TRAP_DIR" "$DIR_A/home"
  expect_denied "the helper refuses a bot home that is a symlink" helper ensure "$BOT_A"
  if [ "$(stat -c '%U %a' "$TRAP_DIR")" = "root 700" ]; then pass "the symlinks' target wasn't changed"; else fail "the symlinks' target wasn't changed"; fi
  rm -f "$DIR_A/home"
  id "$USER_A" >/dev/null 2>&1 && helper remove "$BOT_A" >/dev/null 2>&1

  # An existing workspace, laid out the way the server made them before per-bot users.
  install -d -o "$SERVICE_USER" -g "$BOT_GROUP" -m 2770 "$DIR_A/workspace"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$DIR_A/skills"
  as_server sh -c 'echo old > "$1"' sh "$DIR_A/workspace/old.txt"

  GOT_A="$(helper ensure "$BOT_A" 2>/dev/null)"
  GOT_B="$(helper ensure "$BOT_B" 2>/dev/null)"
  if [ "$GOT_A" = "$USER_A" ] && [ "$GOT_B" = "$USER_B" ]; then pass "ensure prints only the user name ($USER_A, $USER_B)"; else fail "ensure prints only the user name (got '$GOT_A', '$GOT_B')"; fi
  AGAIN="$(helper ensure "$BOT_A" 2>/dev/null)"
  if [ "$AGAIN" = "$USER_A" ]; then pass "ensure can run again"; else fail "ensure can run again (got '$AGAIN')"; fi
  if [ "$(getent passwd "$USER_A" | cut -d: -f6,7)" = "$DIR_A/home:/bin/bash" ]; then pass "$USER_A's home is $DIR_A/home"; else fail "$USER_A's home is $DIR_A/home"; fi
  if [ "$(id -gn "$USER_A" 2>/dev/null)" = "$USER_A" ]; then pass "$USER_A's primary group is its own"; else fail "$USER_A's primary group is its own"; fi
  if in_group "$USER_A" "$BOTS_GROUP"; then pass "$USER_A is in $BOTS_GROUP"; else fail "$USER_A is in $BOTS_GROUP"; fi
  for group in "$SERVICE_USER" "$BOT_GROUP"; do
    if in_group "$USER_A" "$group"; then fail "$USER_A isn't in $group"; else pass "$USER_A isn't in $group"; fi
  done
  if [ "$(stat -c '%U:%G %a' "$DIR_A")" = "$SERVICE_USER:$SERVICE_USER 711" ]; then pass "$DIR_A is $SERVICE_USER:$SERVICE_USER 0711"; else fail "$DIR_A is $SERVICE_USER:$SERVICE_USER 0711"; fi
  if [ "$(stat -c '%U:%G %a' "$DIR_A/home")" = "$USER_A:$USER_A 700" ]; then pass "$DIR_A/home is $USER_A's, 0700"; else fail "$DIR_A/home is $USER_A's, 0700"; fi
  if [ "$(stat -c '%U:%G %a' "$DIR_A/workspace")" = "$USER_A:$BOT_GROUP 2770" ]; then pass "$DIR_A/workspace is $USER_A:$BOT_GROUP 2770"; else fail "$DIR_A/workspace is $USER_A:$BOT_GROUP 2770"; fi

  echo "  as $USER_A:"
  check_server_secrets "$USER_A"
  expect_ok "$USER_A can write its workspace" as_user "$USER_A" sh -c 'echo a > "$1/a.txt"' sh "$DIR_A/workspace"
  expect_ok "$USER_A can edit files from before it existed" as_user "$USER_A" sh -c 'echo a >> "$1"' sh "$DIR_A/workspace/old.txt"
  expect_ok "$USER_A can write its home" as_user "$USER_A" sh -c 'echo a > "$HOME/.probe" && [ "$HOME" = "$1" ]' sh "$DIR_A/home"
  expect_ok "the server can read and edit $USER_A's files" as_server sh -c 'cat "$1" && echo server >> "$1"' sh "$DIR_A/workspace/a.txt"
  expect_ok "the server can write in $DIR_A/workspace" as_server sh -c 'echo server > "$1/server.txt"' sh "$DIR_A/workspace"
  WS_A="$DIR_A/workspace"
  OUTSIDERS=("$USER_B")
  [ -n "$SHARED_USER" ] && OUTSIDERS+=("$SHARED_USER")
  # Everyone who isn't the bot's user or the server: other bots, the shared user, and any other local user.
  outsider_denied() {
    local what="$1" user; shift
    for user in "${OUTSIDERS[@]}"; do expect_denied "$user can't $what" as_user "$user" "$@"; done
    expect_denied "nobody can't $what" runuser -u nobody -- "$@"
  }
  if getfacl -cE "$WS_A" 2>/dev/null | grep -qx "default:user:$USER_A:rwx"; then pass "$WS_A has a default ACL for $USER_A"; else fail "$WS_A has a default ACL for $USER_A"; fi
  # The file tools write as the server (umask 007); the bot's user isn't in $BOT_GROUP but must still get at it all.
  as_server sh -c 'echo server > "$1/from-server.txt" && mkdir -p "$1/server-dir/nested" && echo server > "$1/server-dir/nested/deep.txt"' sh "$WS_A"
  expect_ok "$USER_A can read a file the server wrote" as_user "$USER_A" cat "$WS_A/from-server.txt"
  expect_ok "$USER_A can edit a file the server wrote" as_user "$USER_A" sh -c 'echo a >> "$1"' sh "$WS_A/from-server.txt"
  expect_ok "$USER_A can read and edit a file in folders the server made" as_user "$USER_A" sh -c 'cat "$1" && echo a >> "$1"' sh "$WS_A/server-dir/nested/deep.txt"
  expect_ok "$USER_A can write in folders the server made" as_user "$USER_A" sh -c 'echo a > "$1/a.txt"' sh "$WS_A/server-dir/nested"
  outsider_denied "read a file the server wrote for $USER_A" cat "$WS_A/from-server.txt"
  outsider_denied "read a file in folders the server made for $USER_A" cat "$WS_A/server-dir/nested/deep.txt"
  outsider_denied "list $WS_A" ls "$WS_A"
  expect_ok "$USER_A can delete what the server wrote" as_user "$USER_A" rm -r "$WS_A/from-server.txt" "$WS_A/server-dir"
  as_user "$USER_A" sh -c 'mkdir -p "$1/bot-dir/nested" && echo a > "$1/bot-dir/nested/deep.txt"' sh "$WS_A"
  expect_ok "the server can read and edit a file in folders $USER_A made" as_server sh -c 'cat "$1" && echo server >> "$1"' sh "$WS_A/bot-dir/nested/deep.txt"
  outsider_denied "read $USER_A's files" cat "$WS_A/a.txt"
  outsider_denied "read a file in folders $USER_A made" cat "$WS_A/bot-dir/nested/deep.txt"
  if [ -z "$(find "$WS_A" -perm /007 -print -quit)" ]; then pass "nothing in $WS_A is open to other users"; else fail "nothing in $WS_A is open to other users"; fi
  # A workspace handed over before the helper set ACLs gets them on the next ensure, files inside included.
  setfacl -R -P -b -k "$WS_A"
  as_server sh -c 'mkdir -p "$1/pre-acl" && echo server > "$1/pre-acl/old.txt"' sh "$WS_A"
  helper ensure "$BOT_A" >/dev/null 2>&1
  expect_ok "ensure gives $USER_A the files the server wrote before the ACLs" as_user "$USER_A" sh -c 'cat "$1" && echo a >> "$1"' sh "$WS_A/pre-acl/old.txt"
  as_server sh -c 'echo server > "$1/new.txt"' sh "$WS_A/pre-acl"
  expect_ok "and the ones it writes in their folders afterwards" as_user "$USER_A" sh -c 'echo a >> "$1"' sh "$WS_A/pre-acl/new.txt"
  outsider_denied "read files the server wrote before the ACLs" cat "$WS_A/pre-acl/old.txt"
  as_user "$USER_B" sh -c 'echo b > "$1/b.txt"' sh "$DIR_B/workspace"
  expect_ok "the server can read and edit $USER_B's files" as_server sh -c 'cat "$1" && echo server >> "$1"' sh "$DIR_B/workspace/b.txt"
  expect_denied "$USER_A can't list $DIR_B/workspace" as_user "$USER_A" ls "$DIR_B/workspace"
  expect_denied "$USER_A can't read $USER_B's files" as_user "$USER_A" cat "$DIR_B/workspace/b.txt"
  expect_denied "$USER_A can't write in $DIR_B/workspace" as_user "$USER_A" touch "$DIR_B/workspace/x"
  expect_denied "$USER_A can't list $USER_B's home" as_user "$USER_A" ls "$DIR_B/home"
  expect_denied "$USER_A can't list its bot folder" as_user "$USER_A" ls "$DIR_A"
  expect_denied "$USER_A can't list its skills" as_user "$USER_A" ls "$DIR_A/skills"
  expect_denied "$USER_A can't run commands as $USER_B" as_user "$USER_A" sudo -n -u "$USER_B" true
  if [ -e "$DATA_DIR/weaver.db" ]; then
    expect_denied "$USER_A can't hard-link the database into its workspace" as_user "$USER_A" ln "$DATA_DIR/weaver.db" "$DIR_A/workspace/db"
  fi
  check_ports "$USER_A"
  check_desktop "$USER_A"

  UID_A="$(id -u "$USER_A")"
  as_user "$USER_A" sh -c 'nohup sleep 300 >/dev/null 2>&1 &'
  expect_ok "remove deletes $USER_A" helper remove "$BOT_A"
  if id "$USER_A" >/dev/null 2>&1; then fail "$USER_A is gone"; else pass "$USER_A is gone"; fi
  if pgrep -u "$UID_A" >/dev/null 2>&1; then fail "$USER_A's processes were stopped"; else pass "$USER_A's processes were stopped"; fi
  if [ -e "$DIR_A/home" ]; then fail "$DIR_A/home was removed"; else pass "$DIR_A/home was removed"; fi
  if [ -f "$DIR_A/workspace/a.txt" ]; then pass "$DIR_A/workspace was kept"; else fail "$DIR_A/workspace was kept"; fi
  # Nothing left behind may let a later user with the same uid in.
  if [ -z "$(find "$DIR_A/workspace" -uid "$UID_A" -print -quit)" ]; then pass "$DIR_A/workspace went back to $SERVICE_USER"; else fail "$DIR_A/workspace went back to $SERVICE_USER"; fi
  if getfacl -R -P -n "$DIR_A/workspace" 2>/dev/null | grep -qE "^(default:)?user:$UID_A:"; then fail "no ACL entry for $USER_A's uid is left"; else pass "no ACL entry for $USER_A's uid is left"; fi
  expect_ok "remove can run again" helper remove "$BOT_A"
  cleanup_per_bot
  trap - EXIT
fi

echo "Desktop (DISPLAY=$DISPLAY_NUMBER)"
if [ -S "$X_SOCKET" ]; then
  if [ "$(stat -c '%U %a' /tmp/.X11-unix)" = "root 1777" ]; then pass "/tmp/.X11-unix is root's, 1777"; else fail "/tmp/.X11-unix is root's, 1777"; fi
  if [ "$(stat -c '%U %a' "$(dirname "$X_AUTH")" 2>/dev/null) $(stat -c '%U %a' "$X_AUTH" 2>/dev/null)" = "$SERVICE_USER 700 $SERVICE_USER 600" ]; then
    pass "$X_AUTH is $SERVICE_USER's, 0600, in a 0700 folder"
  else
    fail "$X_AUTH is $SERVICE_USER's, 0600, in a 0700 folder"
  fi
  expect_ok "the desktop's cookie gets programs in" x_hello "$X_SOCKET" "$X_AUTH"
  expect_ok "and through the abstract socket" x_hello "@$X_SOCKET" "$X_AUTH"
  expect_denied "other local users (nobody) can't connect" runuser -u nobody -- python3 -c "$X_HELLO" "$X_SOCKET"
  expect_denied "nor through the abstract socket" runuser -u nobody -- python3 -c "$X_HELLO" "@$X_SOCKET"
  BROWSER="$(setting WEAVER_BROWSER)"
  case "$BROWSER" in
    camofox) X_ALLOWED="$BROWSER_USER" ;;
    playwright) X_ALLOWED="$SERVICE_USER" ;;
    *) X_ALLOWED="" ;;
  esac
  if command -v xhost >/dev/null 2>&1; then
    ACCESS="$(DISPLAY="$DISPLAY_NUMBER" XAUTHORITY="$X_AUTH" xhost 2>&1)"
    if grep -q '^access control enabled' <<<"$ACCESS"; then pass "the desktop has access control on"; else fail "the desktop has access control on"; fi
    WANTED="$(for user in $X_ALLOWED; do echo "SI:localuser:$user"; done)"
    GRANTED="$(sed 1d <<<"$ACCESS")"
    if [ "$GRANTED" = "$WANTED" ]; then
      pass "it lets in only ${X_ALLOWED:-the programs with its cookie} by user"
    else
      fail "it lets in only ${X_ALLOWED:-the programs with its cookie} by user (it allows: $(tr '\n' ' ' <<<"$GRANTED"))"
    fi
  fi
  for user in $X_ALLOWED; do
    expect_ok "$user can connect without the cookie" runuser -u "$user" -- python3 -c "$X_HELLO" "$X_SOCKET"
    expect_ok "and through the abstract socket" runuser -u "$user" -- python3 -c "$X_HELLO" "@$X_SOCKET"
  done
  [ -n "$SHARED_USER" ] && check_desktop "$SHARED_USER"
else
  fail "the desktop's X server is running ($X_SOCKET; check weaver-display)"
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "Bot commands are isolated."; else echo "Some checks failed; rerun the setup script and check again."; fi
exit "$FAILED"
