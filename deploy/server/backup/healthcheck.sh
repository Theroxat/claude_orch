#!/bin/sh
# Healthcheck of the backup service: fails when the last successful backup is older than twice the
# schedule interval (or, before the first backup, when the container has been up that long).
set -eu

# shellcheck source=lib.sh
. "${ORCH_BACKUP_LIB:-/usr/local/lib/orch-backup/lib.sh}"

DIR="${BACKUP_DIR:-/backups}"
STATE="${BACKUP_STATE_DIR:-/tmp}"
NOW="${HEALTHCHECK_NOW:-$(date -u +%s)}"

[ -r "$STATE/interval" ] || { echo "backup service not started yet" >&2; exit 1; }
interval="$(cat "$STATE/interval")"
if [ -r "$DIR/.last_success" ]; then
  ref="$(cat "$DIR/.last_success")"
else
  ref="$(cat "$STATE/started")"
fi
age=$((NOW - ref))
if [ "$age" -gt $((2 * interval)) ]; then
  echo "last successful backup is $age s old (limit $((2 * interval)) s)" >&2
  exit 1
fi
