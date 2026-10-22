#!/usr/bin/env bats
# Rotation and cron logic of the backup service.
# Run: docker run --rm -v "$PWD:/mnt" -w /mnt bats/bats:latest test/backup

setup() {
  LIB="$BATS_TEST_DIRNAME/../../deploy/server/backup/lib.sh"
  # shellcheck source=../../deploy/server/backup/lib.sh
  . "$LIB"
}

# L CMD ARGS: run a lib function in a plain sh (bats traps every command, which makes the cron loops crawl).
L() { sh -c '. "$0"; "$@"' "$LIB" "$@"; }

# names for N consecutive days ending 2026-10-22, one backup per day at 03:00
days() {
  n="$1"
  i=0
  while [ "$i" -lt "$n" ]; do
    d="$(date -u -d "@$(($(date -u -d '2026-10-22 00:00:00' +%s) - i * 86400))" +%Y%m%d)"
    echo "orch-${d}T030000Z.dump"
    i=$((i + 1))
  done
}

@test "rotation keeps the last N daily backups" {
  days 10 >"$BATS_TEST_TMPDIR/names"
  run rotation_select 3 0 0 <"$BATS_TEST_TMPDIR/names"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | wc -l)" -eq 7 ]
  ! echo "$output" | grep -q 20261022 || false
  ! echo "$output" | grep -q 20261020 || false
  echo "$output" | grep -q 20261019
}

@test "weekly and monthly keep older backups that daily dropped" {
  days 100 >"$BATS_TEST_TMPDIR/names"
  run rotation_select 2 2 2 <"$BATS_TEST_TMPDIR/names"
  [ "$status" -eq 0 ]
  # kept: 2 days, the newest of 2 ISO weeks and of 2 months (they overlap)
  kept=$((100 - $(echo "$output" | wc -l)))
  [ "$kept" -ge 4 ] && [ "$kept" -le 6 ]
  # 2026-10-22 (daily, weekly and monthly) and 2026-09-30 (previous month's newest) are kept
  ! echo "$output" | grep -q 'orch-20261022' || false
  ! echo "$output" | grep -q 'orch-20260930' || false
  echo "$output" | grep -q 'orch-20261012'
}

@test "keeps only the newest backup of a day for the daily bucket" {
  run sh -c ". '$LIB'; printf '%s\n' orch-20261022T030000Z.dump orch-20261022T150000Z.dump orch-20261021T030000Z.dump | rotation_select 2 0 0"
  [ "$status" -eq 0 ]
  [ "$output" = "orch-20261022T030000Z.dump" ]
}

@test "encrypted dumps rotate like plain ones, other files are never listed" {
  run sh -c ". '$LIB'; printf '%s\n' orch-20261022T030000Z.dump.age orch-20261021T030000Z.dump.age notes.txt lost+found orch-20261022T030000Z.dump.partial | rotation_select 1 0 0"
  [ "$status" -eq 0 ]
  [ "$output" = "orch-20261021T030000Z.dump.age" ]
}

@test "the newest backup is never rotated out, even with every KEEP_* at zero" {
  run sh -c ". '$LIB'; printf '%s\n' orch-20261022T030000Z.dump orch-20261021T030000Z.dump | rotation_select 0 0 0"
  [ "$status" -eq 0 ]
  [ "$output" = "orch-20261021T030000Z.dump" ]
  run sh -c ". '$LIB'; printf '%s\n' orch-20261022T030000Z.dump | rotation_select 0 0 0"
  [ -z "$output" ]
}

@test "cron: zero-padded fields (BACKUP_HOUR_UTC=08) do not break the parser" {
  now="$(date -u -d '2026-10-22 00:00:00' +%s)"
  [ "$(L cron_next '0 08 * * *' "$now")" = "$(date -u -d '2026-10-22 08:00:00' +%s)" ]
  [ "$(L cron_next '05 09 08 11 *' "$now")" = "$(date -u -d '2026-11-08 09:05:00' +%s)" ]
  [ "$(L cron_next '*/05 00 * * *' "$now")" = "$(date -u -d '2026-10-22 00:05:00' +%s)" ]
}

@test "cron: a day-of-month step is a star field, so day-of-week restricts (vixie)" {
  # 2026-10-22 is a Thursday. "*/2" days of month AND Monday: a Monday on an odd day (1,3,...).
  now="$(date -u -d '2026-10-22 00:00:00' +%s)"
  [ "$(L cron_next '0 3 */2 * 1' "$now")" = "$(date -u -d '2026-11-09 03:00:00' +%s)" ]
}

@test "schedule_interval takes the longest gap of an irregular schedule" {
  now="$(date -u -d '2026-10-22 12:00:00' +%s)"
  # 1st and 2nd of the month: gaps of 1 day and ~29 days
  [ "$(L schedule_interval '0 3 1,2 * *' "$now")" -ge $((28 * 86400)) ]
}

@test "split_recipients: commas and spaces for age keys, ssh keys stay whole" {
  run split_recipients "age1aaa, age1bbb age1ccc,ssh-ed25519 AAAAC3 me@host"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | wc -l)" -eq 4 ]
  [ "$(echo "$output" | sed -n 3p)" = "age1ccc" ]
  [ "$(echo "$output" | sed -n 4p)" = "ssh-ed25519 AAAAC3 me@host" ]
  run split_recipients "*"
  [ "$output" = "*" ]
}

@test "cron_valid accepts normal expressions and rejects bad ones" {
  cron_valid "0 3 * * *"
  cron_valid "*/15 2-4 1,15 * 1-5"
  ! cron_valid "0 3 * *" || false
  ! cron_valid "60 3 * * *" || false
  ! cron_valid "0 24 * * *" || false
  ! cron_valid "0 3 * * mon" || false
  ! cron_valid "*/0 3 * * *" || false
  ! cron_valid "0 3 * * * *" || false
  ! cron_valid "" || false
}

@test "cron_next: daily at 03:00 UTC" {
  now="$(date -u -d '2026-10-22 02:59:30' +%s)"
  [ "$(L cron_next '0 3 * * *' "$now")" = "$(date -u -d '2026-10-22 03:00:00' +%s)" ]
  now="$(date -u -d '2026-10-22 03:00:00' +%s)"
  [ "$(L cron_next '0 3 * * *' "$now")" = "$(date -u -d '2026-10-23 03:00:00' +%s)" ]
}

@test "cron_next: steps, lists and month rollover" {
  now="$(date -u -d '2026-10-22 10:07:00' +%s)"
  [ "$(L cron_next '*/15 * * * *' "$now")" = "$(date -u -d '2026-10-22 10:15:00' +%s)" ]
  now="$(date -u -d '2026-10-31 23:59:00' +%s)"
  [ "$(L cron_next '30 1 1 * *' "$now")" = "$(date -u -d '2026-11-01 01:30:00' +%s)" ]
}

@test "cron_next: day of week (Sunday at 04:00)" {
  now="$(date -u -d '2026-10-22 00:00:00' +%s)" # Thursday
  [ "$(L cron_next '0 4 * * 0' "$now")" = "$(date -u -d '2026-10-25 04:00:00' +%s)" ]
  [ "$(L cron_next '0 4 * * 7' "$now")" = "$(date -u -d '2026-10-25 04:00:00' +%s)" ]
}

@test "schedule_interval: daily, hourly and weekly" {
  now="$(date -u -d '2026-10-22 12:00:00' +%s)"
  [ "$(L schedule_interval '0 3 * * *' "$now")" = 86400 ]
  [ "$(L schedule_interval '0 * * * *' "$now")" = 3600 ]
  [ "$(L schedule_interval '0 3 * * 0' "$now")" = 604800 ]
}

@test "healthcheck: fresh backup is healthy, older than 2x interval is not" {
  d="$BATS_TEST_TMPDIR"
  export BACKUP_DIR="$d" BACKUP_STATE_DIR="$d" ORCH_BACKUP_LIB="$LIB"
  echo 86400 >"$d/interval"
  echo 1000000 >"$d/started"
  H="$BATS_TEST_DIRNAME/../../deploy/server/backup/healthcheck.sh"
  # no backup yet, just started: healthy; after 2 days and a second: unhealthy
  HEALTHCHECK_NOW=1050000 run sh "$H"
  [ "$status" -eq 0 ]
  HEALTHCHECK_NOW=$((1000000 + 172801)) run sh "$H"
  [ "$status" -eq 1 ]
  echo 1100000 >"$d/.last_success"
  HEALTHCHECK_NOW=$((1100000 + 172800)) run sh "$H"
  [ "$status" -eq 0 ]
  HEALTHCHECK_NOW=$((1100000 + 172801)) run sh "$H"
  [ "$status" -eq 1 ]
}

@test "healthcheck fails before the service has written its state" {
  export BACKUP_DIR="$BATS_TEST_TMPDIR" BACKUP_STATE_DIR="$BATS_TEST_TMPDIR" ORCH_BACKUP_LIB="$LIB"
  run sh "$BATS_TEST_DIRNAME/../../deploy/server/backup/healthcheck.sh"
  [ "$status" -eq 1 ]
}

@test "backup.sh rejects bad settings and unknown arguments before doing anything" {
  B="$BATS_TEST_DIRNAME/../../deploy/server/backup/backup.sh"
  export ORCH_BACKUP_LIB="$LIB"
  BACKUP_SCHEDULE="every day" run sh "$B" once
  [ "$status" -eq 2 ]
  [[ "$output" == *"BACKUP_SCHEDULE"* ]]
  BACKUP_KEEP_DAILY=abc run sh "$B" once
  [ "$status" -eq 2 ]
  BACKUP_AGE_RECIPIENT=notakey run sh "$B" once
  [ "$status" -eq 2 ]
  run sh "$B" bogus
  [ "$status" -eq 2 ]
  run sh "$B" --help
  [ "$status" -eq 0 ]
}
