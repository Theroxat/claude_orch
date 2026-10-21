#!/bin/sh
# orch member installer.
#   curl -fsSL https://<ORCH_DOMAIN>/install.sh | ORCH_TOKEN=<token> sh
# The token is read from $ORCH_TOKEN so it never appears in a process argument list.
# Options:
#   --token <t>    one-time enrollment token (15 min). Deprecated: visible in `ps`; prefer ORCH_TOKEN
#   --server <u>   server URL (default: URL this script was served from, or $ORCH_SERVER_URL)
#   --dir <path>   install directory (default: ~/orch)
#   --force        re-enroll even if already enrolled
#   --uninstall    stop and remove containers and volumes (and the ~/.local/bin/orch shortcut)
#   --purge        with --uninstall: also delete the install directory
#   --yes          do not ask for confirmation (also skips the Claude login offer)
# After installing it writes a shortcut ~/.local/bin/orch (runs `orch` inside the agent container)
# and, when a terminal is available, offers to run `orch login` right away.
# Tests: docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck install.sh
#        docker run --rm -v "$PWD:/mnt" -w /mnt bats/bats:latest test/install   (or ./dev test:install)
set -eu

# The server replaces this placeholder with its own public URL when it serves the script.
SERVED_FROM_URL="__ORCH_SERVER_URL__"

TOKEN="${ORCH_TOKEN:-}"
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
Usage: ORCH_TOKEN=<token> install.sh [--server <url>] [--dir <path>] [--force]
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

# Absolute install directory (the shortcut must keep working from any cwd).
case "$DIR" in
  /*) ;;
  *) DIR="$(pwd)/$DIR" ;;
esac
BIN_DIR="${HOME}/.local/bin"
WRAPPER="$BIN_DIR/orch"
WRAPPER_MARK="# orch-shortcut: managed by install.sh"
# The terminal used for questions (stdin is the curl pipe). ORCH_TTY overrides it (tests).
TTY_DEV="${ORCH_TTY:-/dev/tty}"

check_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed. Install Docker Engine 26+ first: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing. See https://docs.docker.com/compose/install/linux/"
}

compose() { docker compose -f "$DIR/compose.yaml" --env-file "$DIR/.env" "$@"; }

env_value() { # env_value KEY -> value from $DIR/.env (empty if absent)
  [ -f "$DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1
}

# have_tty: a terminal we can talk to. stdout must be a terminal unless ORCH_TTY is set (tests).
have_tty() {
  if [ -z "${ORCH_TTY:-}" ]; then [ -t 1 ] || return 1; fi
  [ -r "$TTY_DEV" ] && : <"$TTY_DEV" 2>/dev/null
}

confirm() {
  [ "$YES" -eq 1 ] && return 0
  if [ -r "$TTY_DEV" ] && : <"$TTY_DEV" 2>/dev/null; then
    printf '%s [y/N] ' "$1" >>"$TTY_DEV"
    read -r answer <"$TTY_DEV" || answer=""
    case "$answer" in y | Y | yes | YES) return 0 ;; esac
    return 1
  fi
  die "cannot ask for confirmation without a terminal; rerun with --yes"
}

# The shortcut: `orch <cmd>` runs `orch <cmd>` inside the agent container. -T (no pseudo-TTY) is
# used when stdin or stdout is not a terminal, so pipes and scripts keep working.
install_wrapper() {
  case "$DIR" in *"'"*) die "the install directory must not contain a single quote" ;; esac
  if [ -e "$WRAPPER" ] && ! grep -qF "$WRAPPER_MARK" "$WRAPPER" 2>/dev/null; then
    info "Not touching $WRAPPER: it is not an orch shortcut. Remove it to get the 'orch' command."
    return 0
  fi
  mkdir -p "$BIN_DIR"
  tmp="$WRAPPER.tmp.$$"
  {
    printf '#!/bin/sh\n%s\n' "$WRAPPER_MARK"
    printf "compose='%s/compose.yaml'\n" "$DIR"
    cat <<'WRAP'
# `orch update` with the agent stopped: update the stack directly.
if [ "${1:-}" = "update" ] && [ -z "$(docker compose -f "$compose" ps -q agent 2>/dev/null)" ]; then
  echo "orch: the agent is not running; updating with docker compose pull + up -d"
  docker compose -f "$compose" pull agent && exec docker compose -f "$compose" up -d agent
  exit 1
fi
if [ -t 0 ] && [ -t 1 ]; then
  exec docker compose -f "$compose" exec agent orch "$@"
fi
exec docker compose -f "$compose" exec -T agent orch "$@"
WRAP
  } >"$tmp"
  chmod 755 "$tmp"
  mv "$tmp" "$WRAPPER"
}

remove_wrapper() {
  if [ -f "$WRAPPER" ] && grep -qF "$WRAPPER_MARK" "$WRAPPER" 2>/dev/null &&
    grep -qF "compose='$DIR/compose.yaml'" "$WRAPPER"; then
    rm -f "$WRAPPER"
    info "Removed $WRAPPER."
  fi
}

path_hint() {
  case ":${PATH}:" in
    *":$BIN_DIR:"*) ;;
    *)
      info "Note: $BIN_DIR is not on your PATH. Add it with:"
      info "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile   # then open a new shell"
      ;;
  esac
}

# Offer to link the Claude account now. Never fatal: the member can always run `orch login` later.
offer_login() {
  if compose exec -T agent test -s /secrets/claude-token >/dev/null 2>&1; then
    info "Claude account already connected."
    return 0
  fi
  if [ "$YES" -eq 1 ] || ! have_tty; then return 1; fi
  printf '\nConnect your Claude account now? [Y/n] ' >>"$TTY_DEV"
  read -r answer <"$TTY_DEV" || answer="n"
  case "$answer" in "" | y | Y | yes | YES | Yes) ;; *) return 1 ;; esac
  # shellcheck disable=SC2094
  if compose exec agent orch login <"$TTY_DEV" >>"$TTY_DEV" 2>&1; then
    return 0
  fi
  info "Claude login did not finish."
  return 1
}

do_uninstall() {
  check_docker
  confirm "Stop and remove the orch containers and volumes in $DIR?" || { info "Aborted."; exit 1; }
  if [ -f "$DIR/compose.yaml" ]; then
    if [ -f "$DIR/.env" ]; then compose down --volumes --remove-orphans; else docker compose -f "$DIR/compose.yaml" down --volumes --remove-orphans; fi
  else
    info "No compose.yaml in $DIR, nothing to stop."
  fi
  remove_wrapper
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
  [ -n "$TOKEN" ] || die "missing token: set ORCH_TOKEN=<token> (generate one on the My server page)"
  host="$(hostname 2>/dev/null | tr -c 'A-Za-z0-9._-' '_' || true)"
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
  dver="$(docker version --format '{{.Server.Version}}' 2>/dev/null | tr -c 'A-Za-z0-9._-' '_' || true)"
  # The token travels to curl through stdin, not argv. It is also kept out of this script's own
  # argv when passed as $ORCH_TOKEN; the deprecated --token flag does expose it to `ps`.
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

  install_wrapper
  info ""
  info "orch is running. The 'orch' command is installed at $WRAPPER."
  path_hint
  if offer_login; then
    info ""
    info "All set. Try: orch status"
  else
    info ""
    info "Last step: connect your Claude account (it stays on this machine):"
    info "  orch login"
  fi
}

if [ "$UNINSTALL" -eq 1 ]; then do_uninstall; else do_install; fi
