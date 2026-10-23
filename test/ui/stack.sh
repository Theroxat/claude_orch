#!/bin/sh
# UI test stack (Playwright): ./dev test:ui, or ./test/ui/stack.sh test | up | pw ... | sql | down.
# Docker only. Never touches other compose projects (set ORCH_E2E_PROJECT to pick a dedicated one).
#   test  up -> playwright (pinned image) -> down, always; exits with the Playwright status
#   up    builds the web app, starts the e2e stack (+ Caddy "web" with the production CSP), seeds it
#   pw    runs a command in the Playwright image on the stack network (e.g. pw npx playwright test)
#   down  removes the stack with its volumes and the work dir
# Output (kept after `test`, uploaded by CI on failure): $ORCH_UITEST_HOME/shots (screenshots),
#   $ORCH_UITEST_HOME/work/report-*.json, findings.jsonl (axe) and test-results/.
#
# Known environment caveats (filtered in test/ui/fixtures.mjs, the CSP is NOT loosened for them):
#   - the stack is served over plain http://web, not a secure context: navigator.clipboard is
#     missing, so Copy buttons cannot be verified end to end;
#   - the fake GitHub avatars (and avatars.githubusercontent.com) are blocked by img-src in the CSP.
set -eu
cd "$(dirname "$0")/../.."
export ORCH_E2E_PROJECT="${ORCH_E2E_PROJECT:-orch-e2e-uitest}"
case "$ORCH_E2E_PROJECT" in orch|orch-agent) echo "refusing prod project"; exit 1 ;; esac
BASE="${ORCH_UITEST_HOME:-$HOME/.cache/orch-uitest}"
WORK="$BASE/work"
ENVF="$WORK/env"
PW_IMAGE="mcr.microsoft.com/playwright:v1.56.1-noble" # keep in sync with @playwright/test in package.json
mkdir -p "$WORK/alice" "$WORK/bob" "$WORK/state" "$BASE/shots"
if [ ! -f "$ENVF" ]; then
  rand() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }
  umask 077
  { echo "ORCH_E2E_WEBHOOK_SECRET='$(rand)'"; echo "ORCH_E2E_CLIENT_SECRET='$(rand)'"; echo "ORCH_E2E_ENCRYPTION_KEY='$(rand)'"; } >"$ENVF"
fi
. "$ENVF"
export ORCH_E2E_WEBHOOK_SECRET ORCH_E2E_CLIENT_SECRET ORCH_E2E_ENCRYPTION_KEY
export HOST_UID="$(id -u)" HOST_GID="$(id -g)" ORCH_E2E_REPO="$PWD" ORCH_E2E_WORK="$WORK" \
  ORCH_E2E_WORK_ALICE="$WORK/alice" ORCH_E2E_WORK_BOB="$WORK/bob"
export ORCH_E2E_TAG="$(printf "%s" "$ORCH_E2E_PROJECT" | tr -c "A-Za-z0-9_.-" "_")"
NET="${ORCH_E2E_PROJECT}_default"
dc() { docker compose -p "$ORCH_E2E_PROJECT" -f compose.e2e.yaml -f test/ui/compose.ui.yaml --profile agents "$@"; }
pw() { # run node in the Playwright image on the stack network
  docker run --rm --init --ipc=host --network "$NET" -u "$HOST_UID:$HOST_GID" -e HOME=/tmp \
    -e ORCH_UI_BASE -e ORCH_UI_GH -e ORCH_UI_REPORT -e ORCH_UI_VERSION -v "$PWD:/repo" -v "$WORK:/work" -v "$BASE/shots:/shots" -w /repo/test/ui "$PW_IMAGE" "$@"
}
PW_WORKERS="${ORCH_UI_WORKERS:-4}"
phases() { # every phase runs (one report each); the status is the worst of them
  rc=0
  ORCH_UI_REPORT=/work/report-early.json pw npx playwright test --project=early --workers=1 || rc=1
  ORCH_UI_REPORT=/work/report-pages.json pw npx playwright test --project=pages --workers="$PW_WORKERS" || rc=1
  ORCH_UI_REPORT=/work/report-late.json pw npx playwright test --project=late --workers=1 || rc=1
  return "$rc"
}
export ORCH_UI_VERSION="${ORCH_UI_VERSION:-0.7.0}" ORCH_VERSION="${ORCH_UI_VERSION:-0.7.0}"
export ORCH_UI_BASE="${ORCH_UI_BASE:-http://web}" ORCH_UI_GH="${ORCH_UI_GH:-http://fake-github:8080}"

case "${1:-up}" in
  test)
    status=1
    trap '"$0" down >/dev/null 2>&1 || true' EXIT
    "$0" down >/dev/null 2>&1 || true # stale stack of a previous run
    rm -rf "$BASE/shots" "$WORK/test-results" "$WORK"/report*.json "$WORK/findings.jsonl"
    mkdir -p "$BASE/shots"
    "$0" up
    # Flow specs mutate the shared stack and are ordered: serial. 10-pages is read-only: parallel.
    if phases; then status=0; fi
    "$0" down
    trap - EXIT
    exit "$status"
    ;;
  up)
    docker run --rm -u "$HOST_UID:$HOST_GID" -v "$PWD:/workspace" -w /workspace -e CI=true orch-tools:dev \
      sh -c 'pnpm install --frozen-lockfile >/dev/null && pnpm --filter @orch/server exec prisma generate >/dev/null && pnpm --filter @orch/web build >/dev/null'
    dc build keygen alice
    dc up -d --wait server web
    [ -d test/ui/node_modules ] || pw npm ci --no-audit --no-fund
    pw node seed.mjs phase1
    tok="$(cat "$WORK/enroll-alice.txt")"
    ORCH_E2E_ENROLL_TOKEN_ALICE="$tok" dc up -d --no-deps --no-build alice
    # wait until alice's agent is connected, then log Claude in (fake)
    pw node seed.mjs wait-agent
    FAKE="sk-ant-oat01-$(printf 'FAKE-uitest-VALID-not-a-real-credential-' | head -c 40)$(printf 'x%.0s' $(seq 1 60))"
    printf '%s\n' "$FAKE" | dc exec -T alice orch login --token-stdin --no-setup >/dev/null
    pw node seed.mjs phase2
    sed "s/__ORCH_VERSION__/$ORCH_UI_VERSION/" test/ui/seed.sql |
      dc exec -T postgres psql -U orch -d orch -q -v ON_ERROR_STOP=1 -f -
    pw node seed.mjs verify
    echo "stack up: browser base $ORCH_UI_BASE on network $NET"
    ;;
  pw) shift; pw "$@" ;;
  sql) shift; dc exec -T postgres psql -U orch -d orch -At -c "$1" ;;
  down)
    dc down -v --remove-orphans --timeout 5 || true
    docker run --rm -v "$WORK:/w" debian:bookworm-slim sh -c 'rm -rf /w/alice /w/bob' || true
    ;;
esac
