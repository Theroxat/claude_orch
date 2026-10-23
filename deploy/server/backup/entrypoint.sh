#!/bin/sh
# Container entrypoint. Volumes created by the former backup service (and host directories) are
# owned by root, but the job itself runs as the unprivileged `postgres` user (uid 70): fix the
# ownership of the backups directory, then drop privileges for good (su-exec, no way back).
set -eu

if [ "$(id -u)" = 0 ]; then
  dir="${BACKUP_DIR:-/backups}"
  chown -R postgres:postgres "$dir" || echo "backup: warning: cannot chown $dir to uid 70" >&2
  exec su-exec postgres /usr/local/bin/orch-backup "$@"
fi
exec /usr/local/bin/orch-backup "$@"
