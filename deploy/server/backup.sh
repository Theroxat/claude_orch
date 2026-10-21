#!/bin/sh
# Nightly pg_dump with retention. Runs forever inside the `backup` service.
#   BACKUP_HOUR_UTC       hour of day (0-23, UTC) at which the dump runs (default 3)
#   BACKUP_RETENTION_DAYS dumps older than this are deleted (default 14)
#   BACKUP_ON_START       "true" also dumps once at container start (default false)
# Files: /backups/orch-<UTC timestamp>.dump (pg_dump custom format; restore with pg_restore).
set -eu

HOUR="${BACKUP_HOUR_UTC:-3}"
KEEP="${BACKUP_RETENTION_DAYS:-14}"
export PGHOST="${PGHOST:-postgres}"

dump() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="/backups/orch-${stamp}.dump"
  if pg_dump --format=custom --no-owner --file="${out}.partial"; then
    mv "${out}.partial" "$out"
    echo "backup: wrote $out"
  else
    rm -f "${out}.partial"
    echo "backup: pg_dump FAILED" >&2
  fi
  find /backups -maxdepth 1 -name 'orch-*.dump' -mtime "+${KEEP}" -print -delete
}

[ "${BACKUP_ON_START:-false}" = "true" ] && dump

while true; do
  now="$(date -u +%s)"
  next="$(date -u -d "today ${HOUR}:00" +%s 2>/dev/null || date -u -d "$(date -u +%F) ${HOUR}:00:00" +%s)"
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo "backup: next run in $((next - now)) s"
  sleep $((next - now))
  dump
done
