#!/usr/bin/env bash
# Tests weaver-vps-setup.sh on a real systemd: builds the Linux agent server, starts a Debian container
# with systemd as PID 1, runs the setup script in its test mode (no Tailscale), checks the result with
# assert.sh, then runs the setup script again (downloading from a local fake release this time) and
# checks everything once more. Finally a run against a tampered release has to fail without changes.
#
#   deploy/test/run.sh            from weaver-core; needs Docker and Bun
#
# Environment:
#   SKIP_MEMORY=1   don't install Basic Memory (faster)
#   SKIP_BROWSER=1  don't install Camoufox (faster, and about 2 GB less disk in the container); without it
#                   the checks open a page in the browser service and look for its window on the desktop
#   KEEP=1          leave the container running afterwards (docker exec -it weaver-systemd-test bash)
#   TEST_SUBNET=…   the subnet of the container's own Docker network (default 172.31.77.0/24)
#   SETUP_SCRIPT=…  the setup script to test (default ../weaver-mac/weaver/Resources/weaver-vps-setup.sh)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CORE="$(cd "$HERE/../.." && pwd)"
SETUP_SCRIPT="${SETUP_SCRIPT:-$CORE/../weaver-mac/weaver/Resources/weaver-vps-setup.sh}"
NAME="${CONTAINER_NAME:-weaver-systemd-test}"
IMAGE=weaver-systemd-test
# The container keeps one address across the reboot round, since the setup script pins the agent server to it.
NETWORK="$NAME"
SUBNET="${TEST_SUBNET:-172.31.77.0/24}"
BOX_IP="${SUBNET%.*}.10"
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/weaver-harness.XXXXXX")"

[ -f "$SETUP_SCRIPT" ] || { echo "Setup script not found: $SETUP_SCRIPT" >&2; exit 1; }
case "$(docker info --format '{{.Architecture}}')" in
  aarch64 | arm64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) echo "Unsupported Docker architecture." >&2; exit 1 ;;
esac

step() { printf '\n\033[1m=== %s\033[0m\n' "$1"; }
in_box() { docker exec "$NAME" "$@"; }
cleanup() {
  if [ -n "${KEEP:-}" ]; then
    echo "Container $NAME is still running (docker rm -f $NAME to remove it)."
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
  fi
  echo "Logs: $LOGS"
}

step "Building the linux-$ARCH agent server"
if ! (cd "$CORE" && bun run "build:linux-$ARCH") >"$LOGS/build.log" 2>&1; then
  tail -n 30 "$LOGS/build.log" >&2
  exit 1
fi

step "Starting a systemd container"
docker build -q -t "$IMAGE" "$HERE" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NETWORK" >/dev/null
docker run -d --name "$NAME" --hostname weaver-vps --privileged --cgroupns=host --network "$NETWORK" --ip "$BOX_IP" \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock "$IMAGE" >/dev/null
trap cleanup EXIT
wait_for_systemd() {
  local state="" _
  for _ in $(seq 1 60); do
    state="$(in_box systemctl is-system-running --wait 2>/dev/null || true)"
    # Right after the container starts, systemctl may not reach systemd yet and says offline.
    [ -z "$state" ] || [ "$state" = offline ] || break
    sleep 1
  done
  echo "systemd: $state"
  case "$state" in running | degraded) ;; *) echo "systemd didn't start in the container." >&2; exit 1 ;; esac
}
wait_for_systemd
LISTEN_IP="$(in_box sh -c "ip -4 -o addr show scope global | awk '{ sub(/\\/.*/, \"\", \$4); print \$4; exit }'")"
echo "Serving on $LISTEN_IP (stands in for the Tailscale address)"

in_box mkdir -p /root/weaver-test/helpers
docker cp "$CORE/dist/weaver-server-linux-$ARCH" "$NAME:/tmp/weaver-server"
docker cp "$CORE/scripts/weaver-bot-user" "$NAME:/root/weaver-test/helpers/weaver-bot-user"
docker cp "$CORE/scripts/weaver-update" "$NAME:/root/weaver-test/helpers/weaver-update"
docker cp "$CORE/scripts/check-bot-isolation.sh" "$NAME:/root/weaver-test/check-bot-isolation.sh"
docker cp "$HERE/assert.sh" "$NAME:/root/weaver-test/assert.sh"
docker cp "$SETUP_SCRIPT" "$NAME:/root/weaver-test/weaver-vps-setup.sh"

COMMON_ENV=(-e SKIP_TAILSCALE=1 -e "LISTEN_IP=$LISTEN_IP")
[ -z "${SKIP_MEMORY:-}" ] || COMMON_ENV+=(-e SKIP_MEMORY=1)
[ -z "${SKIP_BROWSER:-}" ] || COMMON_ENV+=(-e SKIP_BROWSER=1)

# Runs the setup script with extra docker exec arguments; output goes to $LOGS/<name>.log.
setup() {
  local log="$LOGS/$1.log" started=$SECONDS
  shift
  if docker exec "${COMMON_ENV[@]}" "$@" "$NAME" bash /root/weaver-test/weaver-vps-setup.sh >"$log" 2>&1; then
    echo "setup finished in $((SECONDS - started))s"
  else
    echo "setup failed after $((SECONDS - started))s; last lines of $log:" >&2
    tail -n 30 "$log" >&2
    return 1
  fi
}
checks() {
  if in_box bash /root/weaver-test/assert.sh "$1" 2>&1 | tee "$LOGS/assert-$1.log"; then
    return 0
  fi
  echo "Checks failed (round $1)." >&2
  return 1
}

step "Setup, first run (local binary and helpers)"
setup setup-1 -e WEAVER_SERVER_BINARY=/tmp/weaver-server -e WEAVER_HELPERS_DIR=/root/weaver-test/helpers
step "Checks after the first run"
checks 1

step "Setup, second run (downloads and verifies from the fake release assert.sh made)"
setup setup-2 -e "WEAVER_SERVER_URL=file:///srv/fake-releases/server-latest/weaver-server-linux-$ARCH"
for file in "weaver-server-linux-$ARCH" weaver-bot-user weaver-update; do
  grep -q "^Checked $file: sha256 " "$LOGS/setup-2.log" || { echo "The setup script didn't check $file." >&2; exit 1; }
done
echo "checked the binary and both helpers against SHA256SUMS"
if [ -z "${SKIP_BROWSER:-}" ]; then
  grep -q "^Checked camoufox-.*: sha256 " "$LOGS/setup-1.log" || { echo "The first run didn't check the Camoufox download." >&2; exit 1; }
  if grep -q "^Downloading camoufox-" "$LOGS/setup-2.log"; then echo "The second run downloaded Camoufox again." >&2; exit 1; fi
  echo "Camoufox was checked against its SHA-256 on the first run and kept on the second"
fi
step "Checks after the second run"
checks 2

step "Reboot: everything has to come back on its own"
docker restart "$NAME" >/dev/null
wait_for_systemd
checks reboot

step "Setup against a tampered release has to fail and change nothing"
BEFORE="$(in_box sha256sum /usr/local/bin/weaver-server)"
if setup setup-tampered -e "WEAVER_SERVER_URL=file:///srv/fake-releases/tampered/weaver-server-linux-$ARCH" 2>/dev/null; then
  echo "The setup script installed a binary that doesn't match SHA256SUMS." >&2
  exit 1
fi
grep -q "doesn't match its SHA-256 checksum" "$LOGS/setup-tampered.log" \
  || { echo "The tampered run failed for another reason:" >&2; tail -n 20 "$LOGS/setup-tampered.log" >&2; exit 1; }
[ "$(in_box sha256sum /usr/local/bin/weaver-server)" = "$BEFORE" ] || { echo "The binary changed." >&2; exit 1; }
in_box curl -fsS "http://$LISTEN_IP:7700/v1/health" >/dev/null || { echo "The agent server stopped answering." >&2; exit 1; }
echo "refused, binary unchanged, server still up"

printf '\n\033[1mThe setup script passed every check, twice.\033[0m\n'
