#!/bin/sh
# Restore a backup into the running production stack. Run it on the host, from anywhere:
#
#   backup/restore.sh [--yes] [--identity AGE_KEY_FILE] [--list] [DUMP]
#
# DUMP is "latest" (default), a file name in the `backups` volume (orch-<stamp>.dump[.age]) or the
# path of a dump on this host (for example one downloaded from S3). Encrypted dumps (.age) need
# --identity (the age private key file). The database content is REPLACED: the server is stopped,
# pg_restore --clean --if-exists runs in a single transaction (all or nothing), then the server is
# started again and its entrypoint runs `prisma migrate deploy`.
set -eu

usage() {
  cat <<'EOF'
usage: restore.sh [--yes] [--identity AGE_KEY_FILE] [--list] [DUMP]
  DUMP        latest (default), a file name in the backups volume, or a local file path
  --identity  age private key file, required for .age dumps
  --yes, -y   do not ask for confirmation
  --list      list the dumps in the backups volume and exit
  --help, -h  this help
EOF
}

die() {
  printf 'restore: %s\n' "$*" >&2
  exit 1
}

YES=false
LIST=false
IDENTITY=""
DUMP=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -y | --yes) YES=true ;;
    --list) LIST=true ;;
    --identity)
      [ "$#" -ge 2 ] || die "--identity needs a file"
      IDENTITY="$2"
      shift
      ;;
    --identity=*) IDENTITY="${1#--identity=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      die "unknown option: $1"
      ;;
    *)
      [ -z "$DUMP" ] || die "only one DUMP argument is allowed"
      DUMP="$1"
      ;;
  esac
  shift
done
DUMP="${DUMP:-latest}"

# The compose project is deploy/server, the parent of this script's directory.
cd "$(dirname "$0")/.."
[ -f compose.yaml ] || die "compose.yaml not found next to backup/"

dc() { docker compose "$@"; }
# Run a command in the backup image without starting its dependencies. stdin stays attached.
# As uid 70, the owner of the dumps (the container has no capability to read other users' files).
in_backup() { dc run --rm --no-deps -T --user 70:70 "$@"; }

list_volume() { in_backup --entrypoint ls backup -1 /backups | sort; }

if $LIST; then
  list_volume
  exit 0
fi

TMP="$(mktemp -d)"
SERVER_STOPPED=false
# Whatever happens after the server was stopped (failure, Ctrl-C), bring it back.
cleanup() {
  rm -rf "$TMP"
  if $SERVER_STOPPED; then
    printf 'restore: starting server again\n' >&2
    dc up -d server >&2 || printf 'restore: could not start the server: docker compose start server\n' >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077

# 1. Locate the dump and copy it to a private temp file on the host.
if [ -f "$DUMP" ]; then
  NAME="$(basename "$DUMP")"
  cp "$DUMP" "$TMP/src"
else
  if [ "$DUMP" = latest ]; then
    NAME="$(list_volume | grep -E '^orch-.*\.dump(\.age)?$' | tail -n 1 || true)"
    [ -n "$NAME" ] || die "no backup found in the backups volume"
  else
    NAME="$DUMP"
    case "$NAME" in */* | *..*) die "not a file name in the backups volume: $NAME" ;; esac
  fi
  in_backup --entrypoint cat backup "/backups/$NAME" >"$TMP/src" || die "cannot read $NAME from the backups volume"
fi

# 2. Decrypt if needed.
case "$NAME" in
  *.age)
    [ -n "$IDENTITY" ] || die "$NAME is encrypted: pass --identity AGE_KEY_FILE"
    [ -r "$IDENTITY" ] || die "cannot read identity file: $IDENTITY"
    # The key travels in an environment variable (not in argv, not on a bind mount: a 0600 key of
    # the host user would be unreadable for uid 70) and is written to the container's tmpfs.
    ORCH_AGE_IDENTITY="$(cat "$IDENTITY")"
    export ORCH_AGE_IDENTITY
    # shellcheck disable=SC2016 # expanded inside the container
    in_backup -e ORCH_AGE_IDENTITY --entrypoint sh backup -c \
      'umask 077; printf "%s\n" "$ORCH_AGE_IDENTITY" >/tmp/identity; age -d -i /tmp/identity' \
      <"$TMP/src" >"$TMP/dump" || die "decryption failed (wrong key?)"
    unset ORCH_AGE_IDENTITY
    ;;
  *) mv "$TMP/src" "$TMP/dump" ;;
esac

# 3. Refuse anything that is not a pg_dump custom-format archive, before touching the database.
[ "$(head -c 5 "$TMP/dump")" = "PGDMP" ] || die "$NAME is not a pg_dump custom-format archive"

# 4. Confirm.
if ! $YES; then
  printf 'This REPLACES the whole orch database with %s.\n' "$NAME"
  printf 'The server is stopped meanwhile. Type "restore" to continue: '
  read -r answer || answer=""
  [ "$answer" = restore ] || die "aborted, nothing changed"
fi

# 5. Restore. The server must not write while we do.
printf 'restore: stopping server\n'
SERVER_STOPPED=true
dc stop server
printf 'restore: restoring %s\n' "$NAME"
# shellcheck disable=SC2016 # $POSTGRES_* must expand inside the container
if ! dc exec -T postgres sh -c \
  'pg_restore --clean --if-exists --no-owner --single-transaction --exit-on-error -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  <"$TMP/dump"; then
  printf 'restore: pg_restore FAILED, the database was left unchanged (single transaction).\n' >&2
  exit 1
fi

# 6. Start the server: its entrypoint runs `prisma migrate deploy`, which upgrades an older dump.
printf 'restore: starting server (applies pending migrations)\n'
dc up -d server
SERVER_STOPPED=false
printf 'restore: done. Check: docker compose logs -f server\n'
