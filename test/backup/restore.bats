#!/usr/bin/env bats
# Argument parsing, confirmation and ordering of deploy/server/backup/restore.sh, with a fake docker.
# Run: docker run --rm -v "$PWD:/mnt" -w /mnt bats/bats:latest test/backup

setup() {
  T="$BATS_TEST_TMPDIR"
  mkdir -p "$T/bin"
  export CALLS="$T/calls.log"
  : >"$CALLS"
  export PATH="$T/bin:$PATH"
  # Fake docker: logs every call; `cat` of a volume file prints a PGDMP archive, `ls` lists two.
  cat >"$T/bin/docker" <<'F'
#!/bin/sh
echo "docker $*" >>"$CALLS"
case "$*" in
  *"--entrypoint ls"*) printf 'orch-20261020T030000Z.dump\norch-20261021T030000Z.dump\nnotes.txt\n' ;;
  *"--entrypoint cat"*) printf 'PGDMPfake' ;;
  *"age -d"*) printf 'PGDMPdecrypted' ;;
  *"exec -T postgres"*) cat >"$CALLS.stdin"; [ -z "${FAKE_RESTORE_KILL:-}" ] || { kill -TERM "$PPID"; sleep 0.3; }; [ -z "${FAKE_RESTORE_FAIL:-}" ] || exit 1 ;;
esac
exit 0
F
  chmod +x "$T/bin/docker"
  R="$BATS_TEST_DIRNAME/../../deploy/server/backup/restore.sh"
}

@test "--help prints usage and exits 0" {
  run sh "$R" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"usage: restore.sh"* ]]
}

@test "unknown option and extra arguments are refused" {
  run sh "$R" --nope
  [ "$status" -eq 1 ]
  run sh "$R" a b
  [ "$status" -eq 1 ]
}

@test "--list lists the volume and changes nothing" {
  run sh "$R" --list
  [ "$status" -eq 0 ]
  [[ "$output" == *"orch-20261021T030000Z.dump"* ]]
  ! grep -q 'stop server' "$CALLS" || false
}

@test "--yes restores the newest dump: stop, pg_restore single transaction, start" {
  run sh "$R" --yes
  [ "$status" -eq 0 ]
  grep -q 'cat backup /backups/orch-20261021T030000Z.dump' "$CALLS"
  [ "$(cat "$CALLS.stdin")" = "PGDMPfake" ]
  stop="$(grep -n 'stop server' "$CALLS" | cut -d: -f1)"
  rest="$(grep -n 'exec -T postgres' "$CALLS" | cut -d: -f1)"
  start="$(grep -n 'up -d server' "$CALLS" | cut -d: -f1)"
  [ "$stop" -lt "$rest" ] && [ "$rest" -lt "$start" ]
  grep -q -- '--clean --if-exists' "$CALLS"
  grep -q -- '--single-transaction' "$CALLS"
}

@test "without --yes, anything but 'restore' aborts before stopping the server" {
  run sh -c "echo no | sh '$R'"
  [ "$status" -eq 1 ]
  [[ "$output" == *"aborted"* ]]
  ! grep -q 'stop server' "$CALLS" || false
}

@test "without --yes, typing 'restore' proceeds" {
  run sh -c "echo restore | sh '$R' orch-20261020T030000Z.dump"
  [ "$status" -eq 0 ]
  grep -q '/backups/orch-20261020T030000Z.dump' "$CALLS"
  grep -q 'up -d server' "$CALLS"
}

@test "a local file is used as is" {
  printf 'PGDMPlocal' >"$BATS_TEST_TMPDIR/my.dump"
  run sh "$R" --yes "$BATS_TEST_TMPDIR/my.dump"
  [ "$status" -eq 0 ]
  [ "$(cat "$CALLS.stdin")" = "PGDMPlocal" ]
  ! grep -q 'entrypoint cat' "$CALLS" || false
}

@test "a file that is not a pg_dump archive is refused before the server is stopped" {
  echo garbage >"$BATS_TEST_TMPDIR/bad.dump"
  run sh "$R" --yes "$BATS_TEST_TMPDIR/bad.dump"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not a pg_dump"* ]]
  ! grep -q 'stop server' "$CALLS" || false
}

@test "path traversal in the volume file name is refused" {
  run sh "$R" --yes ../etc/passwd
  [ "$status" -eq 1 ]
  ! grep -q 'stop server' "$CALLS" || false
}

@test "an .age dump needs --identity, then is decrypted in the backup container" {
  run sh "$R" --yes orch-20261021T030000Z.dump.age
  [ "$status" -eq 1 ]
  [[ "$output" == *"--identity"* ]]
  echo AGE-SECRET-KEY-X >"$BATS_TEST_TMPDIR/key.txt"
  run sh "$R" --yes --identity "$BATS_TEST_TMPDIR/key.txt" orch-20261021T030000Z.dump.age
  [ "$status" -eq 0 ]
  grep -q 'age -d -i' "$CALLS"
  # the private key never appears in the docker command line
  ! grep -q 'AGE-SECRET-KEY' "$CALLS" || false
  grep -q -- '-e ORCH_AGE_IDENTITY' "$CALLS"
  grep -q -- '--user 70:70' "$CALLS"
  [ "$(cat "$CALLS.stdin")" = "PGDMPdecrypted" ]
}

@test "a failed pg_restore says so and starts the server again" {
  FAKE_RESTORE_FAIL=1 run sh "$R" --yes
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAILED"* ]]
  rest="$(grep -n 'exec -T postgres' "$CALLS" | cut -d: -f1)"
  start="$(grep -n 'up -d server' "$CALLS" | cut -d: -f1)"
  [ -n "$start" ] && [ "$rest" -lt "$start" ]
}

@test "an interrupted restore (TERM after the server was stopped) starts the server again" {
  FAKE_RESTORE_KILL=1 run sh "$R" --yes
  [ "$status" -ne 0 ]
  grep -q 'up -d server' "$CALLS"
}
