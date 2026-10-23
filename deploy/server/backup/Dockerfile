## Backup job: Postgres client tools (same major as the server's database), age and rclone.
## Build context is this directory. PG_MAJOR must match the `postgres` service image.
ARG PG_MAJOR=16
FROM postgres:${PG_MAJOR}-alpine

RUN apk add --no-cache age rclone \
 && mkdir -p /usr/local/lib/orch-backup /backups \
 && chown postgres:postgres /backups

COPY lib.sh /usr/local/lib/orch-backup/lib.sh
COPY backup.sh /usr/local/bin/orch-backup
COPY healthcheck.sh /usr/local/bin/orch-backup-healthcheck
COPY entrypoint.sh /usr/local/bin/orch-backup-entry
RUN chmod 0755 /usr/local/bin/orch-backup /usr/local/bin/orch-backup-healthcheck /usr/local/bin/orch-backup-entry

# Starts as root only to chown /backups (a volume created by the previous service is root-owned),
# then runs the job as the official image's `postgres` user (uid 70) via su-exec. compose.yaml adds
# just CHOWN, SETUID and SETGID back for that.
VOLUME /backups
ENTRYPOINT ["/usr/local/bin/orch-backup-entry"]
