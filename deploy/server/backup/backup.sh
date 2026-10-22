#!/bin/sh
# Scheduled pg_dump with rotation, optional age encryption and optional S3 upload.
# Runs as the `backup` compose service (see compose.yaml); `backup.sh once` takes one backup now.
#
#   BACKUP_SCHEDULE        5-field cron expression, UTC (default "0 3 * * *")
#   BACKUP_KEEP_DAILY      newest backup of each of the last N days kept (default 7)
#   BACKUP_KEEP_WEEKLY     ... of each of the last N ISO weeks (default 4)
#   BACKUP_KEEP_MONTHLY    ... of each of the last N months (default 6)
#   BACKUP_ON_START        "true" also takes one backup when the container starts
#   BACKUP_AGE_RECIPIENT   age public key(s) (age1..., comma or space separated): encrypts dumps
#   BACKUP_S3_BUCKET       enables the upload to S3-compatible storage (with rclone)
#   BACKUP_S3_PREFIX, BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_PROVIDER,
#   BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_PRUNE
# Files: /backups/orch-<UTC stamp>.dump[.age] (pg_dump custom format, compressed).
# Secrets (PGPASSWORD, S3 keys) only travel in environment variables and are never printed.
set -eu
umask 077

# shellcheck source=lib.sh
. "${ORCH_BACKUP_LIB:-/usr/local/lib/orch-backup/lib.sh}"

DIR="${BACKUP_DIR:-/backups}"
STATE="${BACKUP_STATE_DIR:-/tmp}"
SCHEDULE="${BACKUP_SCHEDULE:-0 3 * * *}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-6}"
export PGHOST="${PGHOST:-postgres}"

log() { printf 'backup: %s\n' "$*"; }
err() { printf 'backup: %s\n' "$*" >&2; }

# usage: print help and exit
usage() {
  cat <<'EOF'
usage: backup.sh [once]
  (no argument)  run forever, taking a backup on BACKUP_SCHEDULE
  once           take one backup now and exit (non-zero on failure)
EOF
}

# check_env: validate settings once at start; prints the problem and returns 1.
check_env() {
  cron_valid "$SCHEDULE" || {
    err "BACKUP_SCHEDULE is not a valid 5-field cron expression"
    return 1
  }
  for v in "$KEEP_DAILY" "$KEEP_WEEKLY" "$KEEP_MONTHLY"; do
    case "$v" in '' | *[!0-9]*)
      err "BACKUP_KEEP_* must be non-negative integers"
      return 1
      ;;
    esac
  done
  if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
    case "$BACKUP_AGE_RECIPIENT" in *age1* | *ssh-*) ;; *)
      err "BACKUP_AGE_RECIPIENT must be an age public key (age1...) or an ssh public key"
      return 1
      ;;
    esac
  fi
  return 0
}

# setup_s3: map BACKUP_S3_* to rclone's environment (kept out of argv and out of logs).
setup_s3() {
  [ -n "${BACKUP_S3_BUCKET:-}" ] || return 0
  : "${BACKUP_S3_ACCESS_KEY_ID:?set BACKUP_S3_ACCESS_KEY_ID}"
  : "${BACKUP_S3_SECRET_ACCESS_KEY:?set BACKUP_S3_SECRET_ACCESS_KEY}"
  RCLONE_S3_PROVIDER="${BACKUP_S3_PROVIDER:-Other}"
  RCLONE_S3_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
  RCLONE_S3_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
  RCLONE_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
  RCLONE_S3_REGION="${BACKUP_S3_REGION:-}"
  RCLONE_S3_NO_CHECK_BUCKET=true
  RCLONE_CONFIG=/dev/null
  export RCLONE_S3_PROVIDER RCLONE_S3_ACCESS_KEY_ID RCLONE_S3_SECRET_ACCESS_KEY \
    RCLONE_S3_ENDPOINT RCLONE_S3_REGION RCLONE_S3_NO_CHECK_BUCKET RCLONE_CONFIG
  prefix="${BACKUP_S3_PREFIX:-orch}"
  prefix="${prefix#/}"
  prefix="${prefix%/}"
  REMOTE=":s3:${BACKUP_S3_BUCKET}/${prefix}"
}

prune_local() {
  (cd "$DIR" && for f in orch-*; do [ -f "$f" ] && printf '%s\n' "$f"; done) |
    rotation_select "$KEEP_DAILY" "$KEEP_WEEKLY" "$KEEP_MONTHLY" | while IFS= read -r f; do
    rm -f "${DIR:?}/$f" && log "rotated out $f"
  done
}

prune_remote() {
  [ "${BACKUP_S3_PRUNE:-false}" = "true" ] || return 0
  rclone lsf --files-only "$REMOTE" |
    rotation_select "$KEEP_DAILY" "$KEEP_WEEKLY" "$KEEP_MONTHLY" | while IFS= read -r f; do
    rclone deletefile "$REMOTE/$f" && log "rotated out remote $f"
  done
}

# take_backup: dump (+encrypt) (+upload) then rotate. Returns 1 if any configured step failed.
take_backup() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="$DIR/.orch-${stamp}.dump.partial"
  out="$DIR/orch-${stamp}.dump"
  ok=true
  if ! pg_dump --format=custom --compress=6 --no-owner --file="$tmp"; then
    rm -f "$tmp"
    err "pg_dump FAILED"
    return 1
  fi
  if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
    set --
    for r in $(printf '%s' "$BACKUP_AGE_RECIPIENT" | tr ',' ' '); do set -- "$@" -r "$r"; done
    out="$out.age"
    if age "$@" -o "$out.partial" "$tmp"; then
      mv "$out.partial" "$out"
    else
      rm -f "$out.partial"
      err "age encryption FAILED"
      ok=false
    fi
    rm -f "$tmp"
  else
    mv "$tmp" "$out"
  fi
  $ok || return 1
  log "wrote $(basename "$out") ($(wc -c <"$out") bytes)"
  if [ -n "${REMOTE:-}" ]; then
    if rclone copyto "$out" "$REMOTE/$(basename "$out")"; then
      log "uploaded $(basename "$out") to S3 bucket"
      prune_remote || { err "remote rotation FAILED"; ok=false; }
    else
      err "S3 upload FAILED"
      ok=false
    fi
  fi
  prune_local || true
  $ok || return 1
  date -u +%s >"$DIR/.last_success"
  return 0
}

run_loop() {
  now="$(date -u +%s)"
  interval="$(schedule_interval "$SCHEDULE" "$now")"
  printf '%s\n' "$interval" >"$STATE/interval"
  printf '%s\n' "$now" >"$STATE/started"
  [ "${BACKUP_ON_START:-false}" = "true" ] && { take_backup || true; }
  while true; do
    now="$(date -u +%s)"
    next="$(cron_next "$SCHEDULE" "$now")"
    log "next run in $((next - now)) s (schedule: $SCHEDULE UTC)"
    sleep $((next - now))
    take_backup || true
  done
}

mode="${1:-run}"
case "$mode" in
  -h | --help | help) usage ;;
  once | run)
    check_env || exit 2
    setup_s3
    if [ "$mode" = once ]; then take_backup; else run_loop; fi
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
