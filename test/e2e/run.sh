#!/bin/sh
# ./dev e2e: real end-to-end test with real Docker (see compose.e2e.yaml).
# Everything runs in containers. Throwaway secrets are generated here and live only in the
# environment of this run. Everything is removed at the end (containers, networks, volumes,
# task containers/networks/images of this run, the work dirs).
#   ./dev e2e            run, then clean up
#   ./dev e2e --keep     keep the stack on failure for debugging (clean later: ./dev e2e --clean)
set -eu
cd "$(dirname "$0")/../.."

keep=0
case "${1:-}" in
  --keep) keep=1 ;;
  --clean) keep=-1 ;;
esac

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
ORCH_E2E_REPO="$PWD"
# ORCH_E2E_PROJECT: compose project (and image tag) of this run, so parallel runs never collide.
ORCH_E2E_PROJECT="${ORCH_E2E_PROJECT:-orch-e2e}"
ORCH_E2E_TAG="${ORCH_E2E_TAG:-$(printf "%s" "$ORCH_E2E_PROJECT" | tr -c "A-Za-z0-9_.-" "_")}"
state_file="${TMPDIR:-/tmp}/$ORCH_E2E_PROJECT.last"
if [ "$keep" -eq -1 ] && [ -f "$state_file" ]; then
  ORCH_E2E_WORK="$(cat "$state_file")"
else
  ORCH_E2E_WORK="$(mktemp -d "${TMPDIR:-/tmp}/orch-e2e.XXXXXX")"
fi
ORCH_E2E_WORK_ALICE="$ORCH_E2E_WORK/alice"
ORCH_E2E_WORK_BOB="$ORCH_E2E_WORK/bob"
mkdir -p "$ORCH_E2E_WORK_ALICE" "$ORCH_E2E_WORK_BOB"
: >>"$ORCH_E2E_WORK/assignments.txt"
echo "$ORCH_E2E_WORK" >"$state_file"

rand() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }
ORCH_E2E_WEBHOOK_SECRET="$(rand)"
ORCH_E2E_CLIENT_SECRET="$(rand)"
ORCH_E2E_ENCRYPTION_KEY="$(rand)"
export HOST_UID HOST_GID ORCH_E2E_REPO ORCH_E2E_WORK ORCH_E2E_WORK_ALICE ORCH_E2E_WORK_BOB \
  ORCH_E2E_WEBHOOK_SECRET ORCH_E2E_CLIENT_SECRET ORCH_E2E_ENCRYPTION_KEY ORCH_E2E_PROJECT ORCH_E2E_TAG

e2e() { docker compose -p "$ORCH_E2E_PROJECT" -f compose.e2e.yaml --profile agents --profile runner "$@"; }

cleanup() {
  echo "== e2e cleanup"
  e2e down -v --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  # Task containers / networks / images / sidecars of THIS run (by assignment id).
  # Ids recorded by the runner, plus the task dirs the agents created (assignment ids).
  ids="$( (cat "$ORCH_E2E_WORK/assignments.txt" 2>/dev/null; ls "$ORCH_E2E_WORK_ALICE" "$ORCH_E2E_WORK_BOB" 2>/dev/null) | grep -E '^[A-Za-z0-9_-]+$' | sort -u || true)"
  for c in $(docker ps -aq --filter label=orch.task); do
    if docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$c" 2>/dev/null | grep -q "$ORCH_E2E_WORK"; then
      docker rm -f -v "$c" >/dev/null 2>&1 || true
    fi
  done
  for id in $ids; do
    safe="$(printf '%s' "$id" | tr -c 'A-Za-z0-9_.-' '_')"
    for c in $(docker ps -aq --filter "label=orch.task=$id"); do docker rm -f -v "$c" >/dev/null 2>&1 || true; done
    docker network rm "orch-net-$safe" >/dev/null 2>&1 || true
    docker image rm -f "orch-task-$safe:latest" >/dev/null 2>&1 || true
    docker compose -p "orch-task-$safe" down -v >/dev/null 2>&1 || true
  done
  # Work dirs are owned by the host user (task uid); fall back to a container for stragglers.
  rm -rf "$ORCH_E2E_WORK" 2>/dev/null ||
    docker run --rm -v "$ORCH_E2E_WORK:/w" debian:bookworm-slim rm -rf /w/alice /w/bob /w/assignments.txt
  rm -rf "$ORCH_E2E_WORK"
  rm -f "$state_file"
}

if [ "$keep" -eq -1 ]; then
  cleanup
  exit 0
fi

status=1
on_exit() {
  if [ "$status" -ne 0 ] && [ "$keep" -eq 1 ]; then
    echo "== e2e failed: stack kept (docker compose -p $ORCH_E2E_PROJECT ...). Clean with ./dev e2e --clean"
    return
  fi
  if [ "$status" -ne 0 ]; then
    echo "== server log (tail)"
    e2e logs --no-color --tail 80 server 2>/dev/null || true
    echo "== agent logs (tail)"
    e2e logs --no-color --tail 80 alice bob 2>/dev/null || true
    echo "== fake-github log (tail)"
    e2e logs --no-color --tail 40 fake-github 2>/dev/null || true
  fi
  cleanup
}
trap on_exit EXIT
trap 'exit 130' INT TERM

echo "== e2e: building images"
docker image inspect orch-tools:dev >/dev/null 2>&1 || ./dev build-tools
e2e build keygen alice bob runner
echo "== e2e: starting postgres, fake GitHub, server"
e2e up -d --wait server
echo "== e2e: running the scenario"
if e2e run --rm --no-deps runner; then status=0; fi
exit "$status"
