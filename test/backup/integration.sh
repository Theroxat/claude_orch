#!/bin/sh
# Integration test of the backup image: throwaway Postgres, real backup (plain, then age-encrypted),
# restore into a fresh database with the same pg_restore flags as restore.sh, compare row counts.
# Needs docker. Everything is created with a unique suffix and removed on exit.
#   ./test/backup/integration.sh      (or: ./dev test:backup)
set -eu
cd "$(dirname "$0")/../.."

PG_MAJOR="${POSTGRES_MAJOR:-16}"
ID="orch-bkp-test-$$"
IMG="$ID:img"
NET="$ID"
PG="$ID-pg"
VOL="$ID-vol"
fail=0

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rmi -f "$IMG" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

step() { printf '== %s\n' "$*"; }
check() {
  if [ "$1" = "$2" ]; then printf 'ok   %s\n' "$3"; else
    printf 'FAIL %s (expected %s, got %s)\n' "$3" "$1" "$2" >&2
    fail=1
  fi
}
psql_pg() { docker exec -e PGPASSWORD=pw "$PG" psql -U orch -tA "$@"; }
backup_run() { # backup_run [docker run options] -- [backup.sh args]
  docker run --rm --network "$NET" -v "$VOL:/backups" \
    -e PGHOST="$PG" -e PGUSER=orch -e PGPASSWORD=pw -e PGDATABASE=orch "$@"
}

step "build backup image (postgres:$PG_MAJOR-alpine)"
docker build -q --build-arg "PG_MAJOR=$PG_MAJOR" -t "$IMG" deploy/server/backup >/dev/null

step "start throwaway postgres"
docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=orch -e POSTGRES_PASSWORD=pw \
  -e POSTGRES_DB=orch "postgres:$PG_MAJOR-alpine" >/dev/null
i=0
until docker exec "$PG" pg_isready -U orch -d orch >/dev/null 2>&1 && [ "$(psql_pg -c 'select 1' 2>/dev/null)" = 1 ]; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "postgres did not start" >&2; exit 1; }
  sleep 1
done
psql_pg -c "create table task (id serial primary key, title text); create table run (id serial primary key, task_id int references task(id));
  insert into task(title) select 'task ' || g from generate_series(1, 250) g;
  insert into run(task_id) select (g % 250) + 1 from generate_series(1, 700) g;" >/dev/null
check 250 "$(psql_pg -c 'select count(*) from task')" "seed: task rows"

step "backup, plain"
backup_run "$IMG" once
plain="$(docker run --rm -v "$VOL:/backups" --entrypoint sh "$IMG" -c 'ls /backups | grep "^orch-.*\.dump$"')"
check 1 "$(printf '%s\n' "$plain" | grep -c .)" "one plain dump written"
check yes "$(docker run --rm -v "$VOL:/backups" --entrypoint sh "$IMG" -c '[ -s /backups/.last_success ] && echo yes')" "last_success marker written"
check 0 "$(docker run --rm -v "$VOL:/backups" --entrypoint sh "$IMG" -c 'stat -c %u /backups/orch-*.dump | grep -vc "^70$"' || true)" "dump owned by non-root uid 70"

step "healthcheck passes right after a backup"
hc=failed
if docker run --rm -v "$VOL:/backups" -e BACKUP_STATE_DIR=/backups --entrypoint sh "$IMG" -c \
  'echo 86400 > /backups/interval; /usr/local/bin/orch-backup-healthcheck'; then hc=ok; fi
check ok "$hc" "healthcheck ok"

step "restore into a fresh database"
psql_pg -c 'create database orch_restore' >/dev/null
docker run --rm -v "$VOL:/backups" --entrypoint sh "$IMG" -c 'cat /backups/orch-*.dump' |
  docker exec -i -e PGPASSWORD=pw "$PG" pg_restore --clean --if-exists --no-owner --single-transaction --exit-on-error -U orch -d orch_restore
for t in task run; do
  check "$(psql_pg -c "select count(*) from $t")" "$(psql_pg -d orch_restore -c "select count(*) from $t")" "restored row count: $t"
done
# Restoring over existing data (what restore.sh does on a live database) must also work.
psql_pg -c "insert into task(title) values ('extra')" >/dev/null
docker run --rm -v "$VOL:/backups" --entrypoint sh "$IMG" -c 'cat /backups/orch-*.dump' |
  docker exec -i -e PGPASSWORD=pw "$PG" pg_restore --clean --if-exists --no-owner --single-transaction --exit-on-error -U orch -d orch
check 250 "$(psql_pg -c 'select count(*) from task')" "restore over live data replaces it"

step "backup, age-encrypted"
key="$(docker run --rm --entrypoint age-keygen "$IMG" 2>/dev/null)"
recipient="$(printf '%s\n' "$key" | sed -n 's/^# public key: //p')"
printf '%s\n' "$key" | grep '^AGE-SECRET-KEY' >"$ID.key" # in the repo root only for the test; removed below
trap 'rm -f "$ID.key"; cleanup' EXIT INT TERM
sleep 1 # distinct timestamp
backup_run -e BACKUP_AGE_RECIPIENT="$recipient" "$IMG" once
enc="$(docker run --rm -v "$VOL:/backups" --entrypoint sh "$IMG" -c 'ls /backups | grep "\.dump\.age$"')"
check 1 "$(printf '%s\n' "$enc" | grep -c .)" "one encrypted dump written"
check no "$(docker run --rm -v "$VOL:/backups" --entrypoint sh "$IMG" -c "head -c 5 /backups/$enc | grep -q PGDMP && echo yes || echo no")" "encrypted dump is not a readable archive"
check 0 "$(docker run --rm -v "$VOL:/backups" --entrypoint sh "$IMG" -c 'ls -a /backups | grep -c "partial"' || true)" "no leftover .partial file"
psql_pg -c 'drop database orch_restore' >/dev/null
psql_pg -c 'create database orch_restore' >/dev/null
docker run --rm -i -v "$VOL:/backups" -v "$PWD/$ID.key:/identity:ro" --entrypoint sh "$IMG" -c "age -d -i /identity /backups/$enc" |
  docker exec -i -e PGPASSWORD=pw "$PG" pg_restore --no-owner --exit-on-error -U orch -d orch_restore
check 250 "$(psql_pg -d orch_restore -c 'select count(*) from task')" "decrypted restore: task rows"
check 700 "$(psql_pg -d orch_restore -c 'select count(*) from run')" "decrypted restore: run rows"

step "no secrets in the logs"
logs="$(backup_run -e BACKUP_ON_START=false "$IMG" once 2>&1)"
check 0 "$(printf '%s' "$logs" | grep -c 'pw\b\|AGE-SECRET' || true)" "logs contain no password or private key"

rm -f "$ID.key"
if [ "$fail" -ne 0 ]; then
  echo "backup integration: FAILED" >&2
  exit 1
fi
echo "backup integration: all checks passed"
