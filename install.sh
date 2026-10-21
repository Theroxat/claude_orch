#!/bin/sh
# orch member installer.
#   curl -fsSL https://<ORCH_DOMAIN>/install.sh | sh -s -- --token <token>
# Options:
#   --token <t>    one-time enrollment token (15 min)
#   --server <u>   server URL (default: URL this script was served from, or $ORCH_SERVER_URL)
#   --dir <path>   install directory (default: ~/orch)
#   --force        re-enroll even if already enrolled
#   --uninstall    stop and remove containers and volumes
#   --purge        with --uninstall: also delete the install directory
#   --yes          do not ask for confirmation
# Tests: docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck install.sh
#        docker run --rm -v "$PWD:/mnt" -w /mnt bats/bats:latest test/install   (or ./dev test:install)
set -eu

# The server replaces this placeholder with its own public URL when it serves the script.
SERVED_FROM_URL="__ORCH_SERVER_URL__"

TOKEN=""
SERVER=""
DIR=""
FORCE=0
UNINSTALL=0
PURGE=0
YES=0

die() { printf 'orch install: error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

usage() {
  cat <<'USAGE'
Usage: install.sh --token <token> [--server <url>] [--dir <path>] [--force]
       install.sh --uninstall [--purge] [--yes] [--dir <path>]
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token) [ $# -ge 2 ] || die "--token needs a value"; TOKEN="$2"; shift 2 ;;
    --server) [ $# -ge 2 ] || die "--server needs a value"; SERVER="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    --yes | -y) YES=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "$DIR" ] || DIR="${HOME}/orch"
if [ -z "$SERVER" ]; then
  if [ "$SERVED_FROM_URL" != "__ORCH_SERVER_URL__" ]; then
    SERVER="$SERVED_FROM_URL"
  else
    SERVER="${ORCH_SERVER_URL:-}"
  fi
fi
SERVER="${SERVER%/}"

check_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed. Install Docker Engine 26+ first: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing. See https://docs.docker.com/compose/install/linux/"
}

compose() { docker compose -f "$DIR/compose.yaml" --env-file "$DIR/.env" "$@"; }

env_value() { # env_value KEY -> value from $DIR/.env (empty if absent)
  [ -f "$DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1
}

confirm() {
  [ "$YES" -eq 1 ] && return 0
  if [ -r /dev/tty ] && : </dev/tty 2>/dev/null; then
    printf '%s [y/N] ' "$1" >/dev/tty
    read -r answer </dev/tty || answer=""
    case "$answer" in y | Y | yes | YES) return 0 ;; esac
    return 1
  fi
  die "cannot ask for confirmation without a terminal; rerun with --yes"
}

do_uninstall() {
  check_docker
  confirm "Stop and remove the orch containers and volumes in $DIR?" || { info "Aborted."; exit 1; }
  if [ -f "$DIR/compose.yaml" ]; then
    if [ -f "$DIR/.env" ]; then compose down --volumes --remove-orphans; else docker compose -f "$DIR/compose.yaml" down --volumes --remove-orphans; fi
  else
    info "No compose.yaml in $DIR, nothing to stop."
  fi
  if [ "$PURGE" -eq 1 ]; then
    rm -rf "$DIR"
    info "Removed $DIR."
  else
    info "Kept $DIR (use --purge to delete it). Revoke the agent on the My server page."
  fi
  info "orch uninstalled."
}

json_field() { # json_field NAME <json on stdin>
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

enroll() {
  [ -n "$SERVER" ] || die "server URL unknown; pass --server <url> or set ORCH_SERVER_URL"
  [ -n "$TOKEN" ] || die "missing --token <token> (generate one on the My server page)"
  host="$(hostname 2>/dev/null | tr -c 'A-Za-z0-9._-' '_' || true)"
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
  dver="$(docker version --format '{{.Server.Version}}' 2>/dev/null | tr -c 'A-Za-z0-9._-' '_' || true)"
  # Token goes through stdin, not argv, so it does not show up in the process list.
  resp="$(printf '{"token":"%s","machine":{"hostname":"%s","os":"%s","arch":"%s","agentVersion":"installer","dockerVersion":"%s"}}' \
    "$TOKEN" "${host:-unknown}" "$os" "$arch" "${dver:-unknown}" |
    curl -fsS -X POST -H 'Content-Type: application/json' --data @- "$SERVER/agent/enroll")" ||
    die "enrollment failed (token invalid, expired or already used). Generate a new install command."
  AGENT_ID="$(printf '%s' "$resp" | json_field agentId)"
  CREDENTIAL="$(printf '%s' "$resp" | json_field credential)"
  [ -n "$AGENT_ID" ] && [ -n "$CREDENTIAL" ] || die "unexpected enrollment response"
}

write_env() {
  umask 077
  tmp="$DIR/.env.tmp.$$"
  cat >"$tmp" <<ENVFILE
ORCH_SERVER_URL=$SERVER
ORCH_AGENT_ID=$AGENT_ID
ORCH_AGENT_CREDENTIAL=$CREDENTIAL
ORCH_WORK_DIR=$DIR/work
ORCH_CLAUDE_DIR=${HOME}/.claude
ORCH_PLAN=pro
ENVFILE
  chmod 600 "$tmp"
  mv "$tmp" "$DIR/.env"
}

do_install() {
  check_docker
  command -v curl >/dev/null 2>&1 || die "curl is required"
  [ -n "$SERVER" ] || die "server URL unknown; pass --server <url> or set ORCH_SERVER_URL"
  mkdir -p "$DIR/work" "${HOME}/.claude"

  curl -fsSL "${ORCH_COMPOSE_URL:-$SERVER/agent/compose.yaml}" -o "$DIR/compose.yaml.tmp" ||
    die "could not download compose.yaml from the server"
  mv "$DIR/compose.yaml.tmp" "$DIR/compose.yaml"

  if [ -n "$(env_value ORCH_AGENT_CREDENTIAL)" ] && [ "$FORCE" -eq 0 ]; then
    info "Already enrolled (use --force to re-enroll). Keeping $DIR/.env."
  else
    enroll
    write_env
    info "Enrolled as $AGENT_ID."
  fi

  compose up -d

  cat <<MSG

orch is running. One manual step remains: link your Claude subscription.

  docker compose -f $DIR/compose.yaml exec agent orch login

This wraps 'claude setup-token'; the token stays in the agent container.
Optional shell alias:

  alias orch='docker compose -f $DIR/compose.yaml exec agent orch'
MSG
}

if [ "$UNINSTALL" -eq 1 ]; then do_uninstall; else do_install; fi
