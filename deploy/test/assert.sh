#!/usr/bin/env bash
# Checks a machine set up by install.sh in SKIP_TAILSCALE test mode. Run as root inside the
# harness container by run.sh: assert.sh <round>. Also leaves fake releases in /srv/fake-releases
# (server-latest, tampered, broken) for weaver-update and the setup script's next run.
# shellcheck disable=SC2016,SC2329 # "$1" in bash -c is meant for the inner shell; checks run via check/refuse.
set -uo pipefail
cd /

ROUND="${1:-1}"
FAILED=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }
check() { if "${@:2}" >/dev/null 2>&1; then pass "$1"; else fail "$1"; fi; }
refuse() { if "${@:2}" >/dev/null 2>&1; then fail "$1"; else pass "$1"; fi; }

setting() { sed -n "s/^$1=//p" /etc/weaver/agent.env | tail -n1; }
LISTEN="$(setting WEAVER_LISTEN)"
BASE="http://$LISTEN"
TOKEN="$(tr -d '[:space:]' < /etc/weaver/server-token)"
SERVER_BIN=/usr/local/bin/weaver-server
HELPER=/usr/local/lib/weaver/weaver-bot-user
case "$(uname -m)" in aarch64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
ASSET="weaver-server-linux-$ARCH"
RELEASES=/srv/fake-releases

agent_pid() { systemctl show -p MainPID --value weaver-agent; }
healthy() {
  local _
  for _ in $(seq 1 30); do
    curl -fsS --max-time 2 "$BASE/v1/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
indent() { while IFS= read -r line; do printf '        %s\n' "$line"; done <<<"$1"; }
connects() { timeout 3 bash -c 'exec 3<>"/dev/tcp/$1/$2"' connect "$1" "$2"; }
connects_as() {
  local user="$1"; shift
  if [ "$user" = weaver ]; then
    runuser -u weaver -- bash -c "$(declare -f connects); connects $*"
  else
    runuser -u weaver -- sudo -n -u "$user" -- bash -c "$(declare -f connects); connects $*"
  fi
}

echo "Services (round $ROUND)"
UNITS=(weaver-display weaver-desktop weaver-glances weaver-agent weaver-firewall weaver-backup.timer)
BROWSER="$(setting WEAVER_BROWSER)"
[ "$BROWSER" = camofox ] && UNITS+=(weaver-camofox)
[ -f /etc/systemd/system/weaver-memory.service ] && UNITS+=(weaver-memory)
[ -f /etc/systemd/system/weaver-memory-proxy.service ] && UNITS+=(weaver-memory-proxy)
healthy
for unit in "${UNITS[@]}"; do
  check "$unit is active" systemctl is-active --quiet "$unit"
  check "$unit is enabled" systemctl is-enabled --quiet "$unit"
done
FAILED_UNITS="$(systemctl list-units --failed --no-legend --plain 'weaver-*' | awk '{ print $1 }' | tr '\n' ' ')"
if [ -z "$FAILED_UNITS" ]; then pass "no weaver unit has failed"; else fail "no weaver unit has failed ($FAILED_UNITS)"; fi

echo "Agent server"
HEALTH="$(curl -fsS "$BASE/v1/health" 2>/dev/null)"
echo "  health: $HEALTH"
check "/v1/health answers without a token" grep -q '"status":"ok"' <<<"$HEALTH"
check "/v1/health has version, memory and browser" grep -qE '"version":"[^"]+".*"memory":(true|false).*"browser":(true|false)' <<<"$HEALTH"
check "/v1/health has uptimeSeconds" grep -qE '"uptimeSeconds":[0-9]+' <<<"$HEALTH"
check "/v1/health has dataDirFreeBytes" grep -qE '"dataDirFreeBytes":[0-9]+' <<<"$HEALTH"
check "/v1/bots refuses requests without a token" test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/bots")" = 401
check "/v1/bots answers with the token" curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/bots"
check "agent.env sets WEAVER_BOT_USER=per-bot" test "$(setting WEAVER_BOT_USER)" = per-bot
check "agent.env is root-only" test "$(stat -c '%U %a' /etc/weaver/agent.env)" = "root 600"
check "the server listens on LISTEN_IP" test "$LISTEN" = "$(hostname -I | awk '{ print $1 }'):7700"

echo "Browser (WEAVER_BROWSER=$BROWSER)"
CAMOFOX=http://127.0.0.1:9377
if [ "$BROWSER" = camofox ]; then
  KEY="$(setting WEAVER_CAMOFOX_KEY)"
  AUTH="Authorization: Bearer $KEY"
  CAMOFOX_PID="$(systemctl show -p MainPID --value weaver-camofox)"
  camofox_up() {
    local _
    for _ in $(seq 1 30); do
      curl -fsS --max-time 2 "$CAMOFOX/health" >/dev/null 2>&1 && return 0
      sleep 1
    done
    return 1
  }
  status_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
  check "weaver-camofox answers /health" camofox_up
  check "agent.env points the server at $CAMOFOX" test "$(setting WEAVER_CAMOFOX_URL)" = "$CAMOFOX"
  check "agent.env has the key from /etc/weaver/camofox-key" test "$KEY" = "$(tr -d '[:space:]' < /etc/weaver/camofox-key)"
  check "the key is 64 hex characters" grep -qxE '[0-9a-f]{64}' <<<"$KEY"
  check "/etc/weaver/camofox-key is root:weaver-browser 0640" test "$(stat -c '%U:%G %a' /etc/weaver/camofox-key)" = "root:weaver-browser 640"
  check "agent.env leaves WEAVER_BROWSER_COMMAND empty" test -z "$(setting WEAVER_BROWSER_COMMAND)"
  check "weaver-camofox runs as weaver-browser" test "$(stat -c %U "/proc/$CAMOFOX_PID")" = weaver-browser
  check "weaver-browser has no login shell" test "$(getent passwd weaver-browser | cut -d: -f6,7)" = /var/lib/weaver-browser:/usr/sbin/nologin
  check "/var/lib/weaver-browser is weaver-browser's, 0700" test "$(stat -c '%U %a' /var/lib/weaver-browser)" = "weaver-browser 700"
  check "camofox-browser 1.18.1 is installed under /opt/weaver/camofox" \
    test -f /opt/weaver/camofox/camofox-browser-1.18.1/node_modules/@askjo/camofox-browser/server.js
  check "only the current versions are kept" test "$(find /opt/weaver/camofox -mindepth 1 -maxdepth 1 | wc -l)" = 2
  check "nothing in /opt/weaver/camofox is writable by others" test -z "$(find /opt/weaver/camofox -perm /022 ! -type l -print -quit)"
  check "uBlock Origin was installed with it" sh -c 'test -f /opt/weaver/camofox/camoufox-*/addons/UBO/manifest.json'
  LISTENERS="$(ss -ltnH 'sport = :9377' | awk '{ print $4 }' | sort -u | tr '\n' ' ')"
  check "it listens on 127.0.0.1:9377 only ($LISTENERS)" test "$LISTENERS" = "127.0.0.1:9377 "
  check "telemetry is off" sh -c "tr '\\0' '\\n' < /proc/$CAMOFOX_PID/environ | grep -qx CAMOFOX_CRASH_REPORT_ENABLED=false"
  check "it opens a real window (CAMOFOX_INTERACTIVE=desktop, DISPLAY=:1)" \
    sh -c "tr '\\0' '\\n' < /proc/$CAMOFOX_PID/environ | grep -qx CAMOFOX_INTERACTIVE=desktop && tr '\\0' '\\n' < /proc/$CAMOFOX_PID/environ | grep -qx DISPLAY=:1"
  check "requests without the key get 401" test "$(status_of "$CAMOFOX/tabs?userId=check")" = 401
  check "requests with a wrong key get 401" test "$(status_of -H 'Authorization: Bearer wrong' "$CAMOFOX/tabs?userId=check")" = 401
  check "GET /health answers with the key" curl -fsS --max-time 5 -H "$AUTH" "$CAMOFOX/health"
  check "requests with the key get through" curl -fsS --max-time 10 -H "$AUTH" "$CAMOFOX/tabs?userId=check"
  for property in NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes PrivateTmp=yes MemoryMax=1610612736 \
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX'; do
    check "weaver-camofox has $property" test "$(systemctl show -p "${property%%=*}" --value weaver-camofox)" = "${property#*=}"
  done

  # A page served inside the box, so the check doesn't depend on the internet.
  PAGE_DIR="$(mktemp -d)"
  python3 -m http.server 18377 --bind 127.0.0.1 --directory "$PAGE_DIR" >/dev/null 2>&1 &
  PAGE_SERVER=$!
  sleep 1
  # Opens the local page, titled $1, in a tab and looks for the browser's window on the desktop, listing
  # the windows as weaver-browser, which the desktop lets in by user ID.
  browser_window() {
    local marker="$1" tab="" tab_id snapshot window _
    printf '<!doctype html><title>%s</title><h1>%s</h1>\n' "$marker" "$marker" > "$PAGE_DIR/index.html"
    # The first tab launches the browser, which can take a while in a fresh container.
    for _ in 1 2 3; do
      tab="$(curl -fsS --max-time 120 -H "$AUTH" -H 'Content-Type: application/json' \
        -d '{"userId":"weaver-check","sessionKey":"check","url":"http://127.0.0.1:18377/"}' "$CAMOFOX/tabs" 2>&1)" && break
      sleep 5
    done
    tab_id="$(python3 -c 'import json, sys; print(json.load(sys.stdin).get("tabId", ""))' <<<"$tab" 2>/dev/null)"
    if [ -n "$tab_id" ]; then pass "it opens a tab on a local page ($tab_id)"; else fail "it opens a tab on a local page"; indent "$tab"; fi
    snapshot="$(curl -fsS --max-time 60 -H "$AUTH" "$CAMOFOX/tabs/$tab_id/snapshot?userId=weaver-check" 2>&1)"
    check "the tab's snapshot shows the page" grep -q "$marker" <<<"$snapshot"
    # The title has an em dash ("<page> — Camoufox"), which xwininfo only prints in a UTF-8 locale.
    window="$(runuser -u weaver-browser -- env LANG=C.UTF-8 DISPLAY=:1 xwininfo -root -tree 2>&1 | grep -F "\"$marker")"
    if [ -n "$window" ]; then
      pass "the browser window is on DISPLAY=:1, the Screen view"
    else
      fail "the browser window is on DISPLAY=:1, the Screen view"
      indent "$(runuser -u weaver-browser -- env LANG=C.UTF-8 DISPLAY=:1 xwininfo -root -tree 2>&1 | grep '"' | head -n 15)"
    fi
    read -r window <<<"$window" || true
    echo "        window: $window"
    # Its absolute position, the last +X+Y on the line: fluxbox pins it to the top left.
    check "the window starts at the desktop's top left" grep -qE '\+[0-9]\+[0-9]{1,2}$' <<<"$window"
    check "Camoufox runs as weaver-browser" test -n "$(pgrep -u weaver-browser -f camoufox-bin)"
    refuse "no Camoufox runs as anyone else" sh -c "ps -eo user:20,args | grep camoufox-bi[n] | grep -v '^weaver-browser '"
    check "closing the session works" curl -fsS --max-time 30 -X DELETE -H "$AUTH" "$CAMOFOX/sessions/weaver-check"
  }
  browser_window "Weaver browser check $ROUND"
  refuse "other users can't list /var/lib/weaver-browser" runuser -u nobody -- ls /var/lib/weaver-browser
  echo "        memory charged to weaver-camofox (with page cache): $(( $(systemctl show -p MemoryCurrent --value weaver-camofox) / 1048576 )) MB"
  echo "        disk: $(du -sh /opt/weaver/camofox | cut -f1) in /opt/weaver/camofox"
else
  refuse "weaver-camofox isn't installed" systemctl cat weaver-camofox
  refuse "/opt/weaver/camofox is gone" test -e /opt/weaver/camofox
fi

echo "Desktop"
X_AUTH=/run/weaver-x/Xauthority
as_desktop() { env LANG=C.UTF-8 DISPLAY=:1 XAUTHORITY="$X_AUTH" "$@"; }
as_bot() { local user="$1"; shift; runuser -u weaver -- sudo -n -u "$user" -H -- "$@"; }
invocation() { systemctl show -p InvocationID --value "$1"; }
vnc_serves() { timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900; head -c 12 <&3' 2>/dev/null | grep -q '^RFB 00'; }
novnc_serves() { test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${LISTEN%:*}:6080/vnc.html")" = 200; }
access_control_on() { as_desktop xhost | grep -q '^access control enabled'; }
# x11vnc and fluxbox print these when the X server turns them away.
x_refusals() {
  local unit
  for unit in weaver-desktop weaver-camofox; do
    systemctl cat "$unit" >/dev/null 2>&1 || continue
    journalctl -q -o cat "_SYSTEMD_INVOCATION_ID=$(invocation "$unit")" 2>/dev/null
  done | grep -iE 'XOpenDisplay.*failed|Authorization required|No protocol specified|Cannot open display|Invalid MIT-MAGIC-COOKIE'
}
until_true() { local _; for _ in $(seq 1 "$1"); do "${@:2}" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
desktop_serves() {
  check "x11vnc serves the screen on 127.0.0.1:5900" until_true 15 vnc_serves
  check "noVNC answers on ${LISTEN%:*}:6080 (HTTP 200)" until_true 15 novnc_serves
  refuse "nothing on the desktop was turned away by the X server" x_refusals
}
XVFB_PID="$(systemctl show -p MainPID --value weaver-display)"
XVFB_ARGS="$(tr '\0' ' ' < "/proc/$XVFB_PID/cmdline" 2>/dev/null)"
echo "        X server: $XVFB_ARGS"
check "the X server runs as weaver" test "$(stat -c %U "/proc/$XVFB_PID")" = weaver
check "it requires a cookie (-auth $X_AUTH)" grep -q -- "-auth $X_AUTH" <<<"$XVFB_ARGS"
refuse "it doesn't turn access control off (-ac)" grep -qwE -- '-ac' <<<"$XVFB_ARGS"
check "it doesn't listen on TCP" grep -q -- '-nolisten tcp' <<<"$XVFB_ARGS"
refuse "nothing listens on X's TCP port 6001" connects 127.0.0.1 6001
check "$X_AUTH is weaver's, 0600" test "$(stat -c '%U %a' "$X_AUTH")" = "weaver 600"
check "access control is on" access_control_on
desktop_serves
WINDOWS="$(as_desktop xwininfo -root -tree 2>&1)"
refuse "fluxbox shows no fbsetbg message" grep -qiE 'fbsetbg|xmessage' <<<"$WINDOWS"
check "fluxbox runs on it" pgrep -u weaver -x fluxbox
for user in weaver-bot nobody; do
  if [ "$user" = nobody ]; then run_as=(runuser -u nobody --); else run_as=(as_bot "$user"); fi
  refuse "$user can't list the desktop's windows" "${run_as[@]}" env DISPLAY=:1 xwininfo -root -tree
  refuse "$user can't with XAUTHORITY=$X_AUTH either" "${run_as[@]}" env DISPLAY=:1 XAUTHORITY="$X_AUTH" xdpyinfo
done

echo "Desktop after the X server crashes"
OLD_COOKIE="$(sha256sum "$X_AUTH" | cut -d' ' -f1)"
OLD_DESKTOP="$(invocation weaver-desktop)"
OLD_CAMOFOX="$(invocation weaver-camofox 2>/dev/null)"
kill -9 "$XVFB_PID"
display_back() {
  local pid
  pid="$(systemctl show -p MainPID --value weaver-display)"
  systemctl is-active --quiet weaver-display && [ "$pid" != 0 ] && [ "$pid" != "$XVFB_PID" ] \
    && systemctl is-active --quiet weaver-desktop && [ "$(invocation weaver-desktop)" != "$OLD_DESKTOP" ]
}
check "weaver-display and weaver-desktop come back" until_true 45 display_back
check "with a new cookie" test "$(sha256sum "$X_AUTH" | cut -d' ' -f1)" != "$OLD_COOKIE"
check "access control is still on" access_control_on
desktop_serves
refuse "weaver-bot still can't list the desktop's windows" as_bot weaver-bot env DISPLAY=:1 xwininfo -root -tree
if [ "$BROWSER" = camofox ]; then
  camofox_restarted() { systemctl is-active --quiet weaver-camofox && [ "$(invocation weaver-camofox)" != "$OLD_CAMOFOX" ]; }
  check "weaver-camofox restarted with it" until_true 30 camofox_restarted
  check "weaver-camofox answers /health again" camofox_up
  check "weaver-browser can still connect (granted again)" runuser -u weaver-browser -- env DISPLAY=:1 xdpyinfo
  browser_window "Weaver browser check $ROUND after an X restart"
fi
[ -n "${PAGE_SERVER:-}" ] && kill "$PAGE_SERVER" 2>/dev/null
[ -n "${PAGE_DIR:-}" ] && rm -rf "$PAGE_DIR"

echo "Accounts, sudo and SSH"
check "the weaver-bots group exists" getent group weaver-bots
check "the shared weaver-bot user still exists" id weaver-bot
check "$HELPER is root:root 0755" test "$(stat -c '%U:%G %a' "$HELPER")" = "root:root 755"
check "weaver-update is installed" test -x /usr/local/bin/weaver-update
check "weaver-backup and weaver-restore are installed" test -x /usr/local/bin/weaver-backup -a -x /usr/local/bin/weaver-restore
check "the sudoers file is valid" visudo -cf /etc/sudoers.d/weaver-bot
check "the sudoers file is root:root 0440" test "$(stat -c '%U:%G %a' /etc/sudoers.d/weaver-bot)" = "root:root 440"
check "sudo lets weaver run the helper" runuser -u weaver -- sudo -n -l "$HELPER" ensure x
refuse "sudo doesn't let weaver run other root commands" runuser -u weaver -- sudo -n -l /bin/sh
SSHD="$(sshd -T -C user=nobody,host=localhost,addr=127.0.0.1 2>/dev/null)"
check "sshd denies the weaver-bot user" grep -qi '^denyusers weaver-bot' <<<"$SSHD"
check "sshd denies the weaver-bots group" grep -qi '^denygroups weaver-bots' <<<"$SSHD"

echo "Bot isolation (check-bot-isolation.sh)"
if bash /root/weaver-test/check-bot-isolation.sh >/tmp/isolation.log 2>&1; then
  pass "check-bot-isolation.sh passes ($(grep -c '  ok ' /tmp/isolation.log) checks)"
else
  fail "check-bot-isolation.sh passes"
  grep -E 'FAIL' /tmp/isolation.log | sed 's/^/        /'
fi

echo "Loopback firewall"
check "weaver-firewall.service applied the rules" iptables -C OUTPUT -j WEAVER-BOTS
check "the IPv6 rules are there too" ip6tables -C OUTPUT -j WEAVER-BOTS
RULES_BEFORE="$(iptables -S WEAVER-BOTS | wc -l)"
systemctl restart weaver-firewall
check "reapplying keeps the same rules" test "$(iptables -S WEAVER-BOTS | wc -l)" = "$RULES_BEFORE"
check "reapplying adds no second jump" test "$(iptables -S OUTPUT | grep -c 'WEAVER-BOTS')" = 1
# Basic Memory's upstream port only listens with MEMORY_TOKEN, so stand something up there if it's free.
LISTENER=""
if ! connects 127.0.0.1 8766 2>/dev/null; then
  python3 -m http.server 8766 --bind 0.0.0.0 >/dev/null 2>&1 &
  LISTENER=$!
  sleep 1
fi
FW_BOT="fw$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')"
FW_USER="$(runuser -u weaver -- sudo -n "$HELPER" ensure "$FW_BOT")"
refuse "a per-bot user can't list the desktop's windows" as_bot "$FW_USER" env DISPLAY=:1 xwininfo -root -tree
LOCAL_IP="${LISTEN%:*}"
for port in 8766 5900 6080 61208; do
  for host in 127.0.0.1 "$LOCAL_IP"; do
    # x11vnc only listens on loopback.
    [ "$port" = 5900 ] && [ "$host" != 127.0.0.1 ] && continue
    check "weaver can connect to $host:$port" connects_as weaver "$host" "$port"
    refuse "weaver-bot can't connect to $host:$port" connects_as weaver-bot "$host" "$port"
    refuse "a per-bot user can't connect to $host:$port" connects_as "$FW_USER" "$host" "$port"
  done
done
check "weaver-bot can still reach the agent server's port" connects_as weaver-bot "$LOCAL_IP" 7700
if [ "$BROWSER" = camofox ]; then
  # The browser service only listens on loopback.
  check "weaver can connect to 127.0.0.1:9377" connects_as weaver 127.0.0.1 9377
  refuse "weaver-bot can't connect to 127.0.0.1:9377" connects_as weaver-bot 127.0.0.1 9377
  refuse "a per-bot user can't connect to 127.0.0.1:9377" connects_as "$FW_USER" 127.0.0.1 9377
  # Pages the bots open can't reach the local services either.
  for target in 127.0.0.1:8766 127.0.0.1:5900 127.0.0.1:6080 127.0.0.1:61208 "$LOCAL_IP:6080" "$LOCAL_IP:7700"; do
    refuse "weaver-browser can't connect to $target" runuser -u weaver-browser -- bash -c "$(declare -f connects); connects ${target%:*} ${target##*:}"
  done
fi
runuser -u weaver -- sudo -n "$HELPER" remove "$FW_BOT" >/dev/null
rm -rf "/var/lib/weaver/bots/$FW_BOT"
[ -n "$LISTENER" ] && kill "$LISTENER" 2>/dev/null

echo "Backups"
check "weaver-backup.timer is scheduled" sh -c 'systemctl list-timers --all --no-legend | grep -q weaver-backup.timer'
BACKUPS=/var/lib/weaver/backups
SKILL_BOT=backup-check
install -d -o weaver -g weaver -m 711 "/var/lib/weaver/bots/$SKILL_BOT"
install -d -o weaver -g weaver -m 700 "/var/lib/weaver/bots/$SKILL_BOT/skills/demo"
runuser -u weaver -- sh -c "echo '# demo' > /var/lib/weaver/bots/$SKILL_BOT/skills/demo/SKILL.md"
for day in 01 02 03 04 05 06 07 08 09; do
  runuser -u weaver -- touch "$BACKUPS/weaver-2000-01-$day.db" "$BACKUPS/skills-2000-01-$day.tar.gz"
done
TODAY="$(date +%Y-%m-%d)"
check "systemctl start weaver-backup succeeds" systemctl start weaver-backup
check "it wrote weaver-$TODAY.db" test -s "$BACKUPS/weaver-$TODAY.db"
check "the backup passes an integrity check" test "$(sqlite3 "$BACKUPS/weaver-$TODAY.db" 'PRAGMA quick_check;')" = ok
check "the backup has the bots table" sqlite3 "$BACKUPS/weaver-$TODAY.db" 'SELECT count(*) FROM bots;'
check "it wrote skills-$TODAY.tar.gz with the skills" sh -c "tar -tzf '$BACKUPS/skills-$TODAY.tar.gz' | grep -q 'bots/$SKILL_BOT/skills/demo/SKILL.md'"
check "it kept the newest 7 database backups" test "$(find "$BACKUPS" -name 'weaver-*.db' | wc -l)" = 7
check "it kept the newest 7 skills backups" test "$(find "$BACKUPS" -name 'skills-*.tar.gz' | wc -l)" = 7
check "the oldest backups were removed" test ! -e "$BACKUPS/weaver-2000-01-01.db"
check "$BACKUPS is weaver's, 0700" test "$(stat -c '%U %a' "$BACKUPS")" = "weaver 700"
check "today's backups are weaver's and private" test -z "$(find "$BACKUPS" -type f -name "*-$TODAY.*" \( ! -user weaver -o -perm /077 \))"
rm -rf "/var/lib/weaver/bots/$SKILL_BOT" "$BACKUPS"/weaver-2000-* "$BACKUPS"/skills-2000-*

echo "weaver-update"
HELPERS=(weaver-bot-user weaver-update weaver-backup weaver-restore)
make_release() { # <tag> <binary>: a release folder with the binary, the helpers and SHA256SUMS
  local dir="$RELEASES/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp "$2" "$dir/$ASSET"
  for helper in "${HELPERS[@]}"; do cp "/root/weaver-test/helpers/$helper" "$dir/"; done
  printf '{"version":"0.0.0","commit":"test","tag":"%s","publishedAt":"","notes":""}\n' "$1" > "$dir/release.json"
  (cd "$dir" && sha256sum "$ASSET" "${HELPERS[@]}" release.json > SHA256SUMS)
}
ORIGINAL_SUM="$(sha256sum "$SERVER_BIN" | cut -d' ' -f1)"
cp "$SERVER_BIN" /tmp/weaver-server-good
make_release server-latest /tmp/weaver-server-good
make_release tampered /tmp/weaver-server-good
sed -i -E "s/^[0-9a-f]{64}(  $ASSET)\$/$(printf '0%.0s' $(seq 1 64))\\1/" "$RELEASES/tampered/SHA256SUMS"
printf '#!/bin/sh\necho "this build is broken" >&2\nexit 1\n' > /tmp/weaver-server-broken
make_release broken /tmp/weaver-server-broken
export WEAVER_UPDATE_URL="file://$RELEASES"

OUT="$(weaver-update 2>&1)"
check "weaver-update with the same build says it's up to date" grep -q "already up to date" <<<"$OUT"
PID_BEFORE="$(agent_pid)"
OUT="$(weaver-update --force 2>&1)"
STATUS=$?
indent "$OUT"
check "weaver-update --force reinstalls and restarts" test "$STATUS" = 0
check "the agent server restarted" test "$(agent_pid)" != "$PID_BEFORE"
check "the agent server is healthy after the update" healthy
check "the previous binary is kept" cmp -s "$SERVER_BIN.previous" /tmp/weaver-server-good

PID_BEFORE="$(agent_pid)"
OUT="$(weaver-update tampered 2>&1)"
STATUS=$?
check "weaver-update refuses a binary that doesn't match SHA256SUMS" test "$STATUS" != 0
check "it says why" grep -q "doesn't match the release's SHA256SUMS" <<<"$OUT"
check "the binary is unchanged" test "$(sha256sum "$SERVER_BIN" | cut -d' ' -f1)" = "$ORIGINAL_SUM"
check "the agent server wasn't restarted" test "$(agent_pid)" = "$PID_BEFORE"

refuse "weaver-update fails for a missing release" weaver-update no-such-tag
refuse "weaver-update refuses a tag with odd characters" weaver-update "../broken"

STARTED=$SECONDS
OUT="$(WEAVER_UPDATE_TIMEOUT=15 weaver-update broken 2>&1)"
STATUS=$?
indent "$OUT"
check "weaver-update fails for a build that doesn't start" test "$STATUS" != 0
check "it rolled back" grep -q "rolled back to the previous agent server" <<<"$OUT"
check "the original binary is back" test "$(sha256sum "$SERVER_BIN" | cut -d' ' -f1)" = "$ORIGINAL_SUM"
check "the agent server is healthy after the rollback" healthy
echo "        (rollback took $((SECONDS - STARTED))s)"

echo "One-click updates"
UPDATE_DIR=/var/lib/weaver-update
check "weaver-update.path is active" systemctl is-active --quiet weaver-update.path
check "weaver-update.path is enabled" systemctl is-enabled --quiet weaver-update.path
check "$UPDATE_DIR is root:weaver 1770" test "$(stat -c '%U:%G %a' "$UPDATE_DIR")" = "root:weaver 1770"
check "the updater's marker is there" test -f "$UPDATE_DIR/.updater-installed"
api() { curl -sS --max-time 30 -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }
check "the server says one-click updates are supported" grep -q '"supported":true' <<<"$(api "$BASE/v1/update")"
update_state() { sed -n 's/.*"state":"\([^"]*\)".*/\1/p' "$UPDATE_DIR/status.json" 2>/dev/null; }
# Waits for the request to be taken and the update to end.
update_finished() {
  local _
  for _ in $(seq 1 120); do
    if [ ! -e "$UPDATE_DIR/request" ] && [ ! -L "$UPDATE_DIR/request" ]; then
      case "$(update_state)" in done | failed | rolled-back) return 0 ;; esac
    fi
    sleep 1
  done
  return 1
}
cp /etc/weaver/agent.env /tmp/agent.env.saved
echo "WEAVER_UPDATE_URL=file://$RELEASES" >> /etc/weaver/agent.env
rm -f "$UPDATE_DIR/status.json"
PID_BEFORE="$(agent_pid)"
check "POST /v1/update queues the update" test "$(api -o /dev/null -w '%{http_code}' -X POST -d '{"channel":"latest","tag":"broken"}' "$BASE/v1/update")" = 202
check "the updater picked up the request and finished" update_finished
check "it rolled back the broken build and says so" test "$(update_state)" = rolled-back
check "the agent server is healthy after the rollback" healthy
check "the status is readable by the server's user" runuser -u weaver -- cat "$UPDATE_DIR/status.json"
refuse "the server's user can't rewrite the status" runuser -u weaver -- sh -c "echo '{}' > $UPDATE_DIR/status.json"
refuse "the server's user can't remove the marker" runuser -u weaver -- rm -f "$UPDATE_DIR/.updater-installed"
rm -f "$UPDATE_DIR/status.json"
check "a request through the API with the same build ends up to date" test "$(api -o /dev/null -w '%{http_code}' -X POST -d '{"channel":"latest","tag":"server-latest"}' "$BASE/v1/update")" = 202
check "the updater finished it" update_finished
check "it says done" test "$(update_state)" = "done"
rm -f "$UPDATE_DIR/status.json"
runuser -u weaver -- ln -s /etc/weaver/server-token "$UPDATE_DIR/request"
check "a request that's a link to another file is refused" update_finished
check "it failed" test "$(update_state)" = failed
refuse "and doesn't repeat what the file says" grep -qF "$TOKEN" "$UPDATE_DIR/status.json"
cp /tmp/agent.env.saved /etc/weaver/agent.env
rm -f /tmp/agent.env.saved /tmp/weaver-server-good /tmp/weaver-server-broken

echo
if [ "$FAILED" -eq 0 ]; then echo "Round $ROUND: all checks passed."; else echo "Round $ROUND: some checks failed."; fi
exit "$FAILED"
