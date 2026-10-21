#!/usr/bin/env bats
# Run: docker run --rm -v "$PWD:/mnt" -w /mnt bats/bats:latest test/install

setup() {
  T="$BATS_TEST_TMPDIR"
  export HOME="$T/home"
  mkdir -p "$HOME" "$T/bin"
  export CALLS="$T/calls.log"
  : >"$CALLS"
  export PATH="$T/bin:$PATH"
  cat >"$T/bin/docker" <<'F'
#!/bin/sh
echo "docker $*" >>"$CALLS"
[ "$1" = "version" ] && echo 27.1.0
exit 0
F
  cat >"$T/bin/curl" <<'F'
#!/bin/sh
echo "curl $*" >>"$CALLS"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
if [ -n "$out" ]; then echo "services: {}" >"$out"; exit 0; fi
cat >/dev/null
if [ -n "${FAKE_ENROLL_FAIL:-}" ]; then exit 22; fi
echo '{"agentId":"agt_1","credential":"orch_agent_agt_1.SECRETSECRET"}'
F
  chmod +x "$T/bin/docker" "$T/bin/curl"
  S="$BATS_TEST_DIRNAME/../../install.sh"
}

@test "fresh install enrolls, writes 600 .env, starts stack, hides credential" {
  run sh "$S" --token tok123 --server https://orch.example.com
  [ "$status" -eq 0 ]
  [ -f "$HOME/orch/compose.yaml" ]
  grep -q '^ORCH_AGENT_CREDENTIAL=orch_agent_agt_1.SECRETSECRET' "$HOME/orch/.env"
  [ "$(stat -c %a "$HOME/orch/.env")" = "600" ]
  grep -q 'docker compose .* up -d' "$CALLS"
  case "$output" in *SECRETSECRET*) false ;; esac
  case "$output" in *"orch login"*) true ;; *) false ;; esac
}

@test "token is not passed on the curl command line" {
  run sh "$S" --token tok123 --server https://orch.example.com
  run grep -q tok123 "$CALLS"
  [ "$status" -eq 1 ]
}

@test "token from ORCH_TOKEN enrolls without any --token argument" {
  run env ORCH_TOKEN=envtok123 sh "$S" --server https://orch.example.com
  [ "$status" -eq 0 ]
  grep -q '^ORCH_AGENT_CREDENTIAL=' "$HOME/orch/.env"
  grep -q '/agent/enroll' "$CALLS"
  run grep -q envtok123 "$CALLS"
  [ "$status" -eq 1 ]
}

@test "rerun does not re-enroll" {
  sh "$S" --token tok123 --server https://orch.example.com
  : >"$CALLS"
  run sh "$S" --server https://orch.example.com
  [ "$status" -eq 0 ]
  run grep -q '/agent/enroll' "$CALLS"
  [ "$status" -eq 1 ]
  grep -q 'up -d' "$CALLS"
}

@test "--force re-enrolls" {
  sh "$S" --token tok123 --server https://orch.example.com
  : >"$CALLS"
  run sh "$S" --token tok456 --server https://orch.example.com --force
  [ "$status" -eq 0 ]
  grep -q '/agent/enroll' "$CALLS"
}

@test "missing token on first install fails" {
  run sh "$S" --server https://orch.example.com
  [ "$status" -ne 0 ]
  case "$output" in *"ORCH_TOKEN"*) true ;; *) false ;; esac
}

@test "missing server fails with a clear message" {
  run env -u ORCH_SERVER_URL sh "$S" --token t
  [ "$status" -ne 0 ]
  case "$output" in *"server URL"*) true ;; *) false ;; esac
}

@test "ORCH_SERVER_URL env var is used" {
  ORCH_SERVER_URL=https://env.example.com run sh "$S" --token t
  [ "$status" -eq 0 ]
  grep -q '^ORCH_SERVER_URL=https://env.example.com$' "$HOME/orch/.env"
}

@test "failed enrollment is reported and nothing is started" {
  FAKE_ENROLL_FAIL=1 run sh "$S" --token t --server https://orch.example.com
  [ "$status" -ne 0 ]
  case "$output" in *"enrollment failed"*) true ;; *) false ;; esac
  run grep -q 'up -d' "$CALLS"
  [ "$status" -eq 1 ]
}

@test "custom --dir" {
  run sh "$S" --token t --server https://o.example.com --dir "$T/custom"
  [ "$status" -eq 0 ]
  [ -f "$T/custom/.env" ]
}

@test "unknown option fails" {
  run sh "$S" --bogus
  [ "$status" -ne 0 ]
}

@test "missing docker produces a clear error" {
  rm "$T/bin/docker"
  run env PATH="$T/bin:/usr/bin:/bin" sh "$S" --token t --server https://o.example.com
  [ "$status" -ne 0 ]
  case "$output" in *"docker is not installed"*) true ;; *) false ;; esac
}

@test "missing compose plugin produces a clear error" {
  cat >"$T/bin/docker" <<'F'
#!/bin/sh
[ "$1" = "compose" ] && exit 1
exit 0
F
  run sh "$S" --token t --server https://o.example.com
  [ "$status" -ne 0 ]
  case "$output" in *"compose plugin"*) true ;; *) false ;; esac
}

@test "uninstall --yes brings the stack down with volumes and keeps the dir" {
  sh "$S" --token t --server https://o.example.com
  : >"$CALLS"
  run sh "$S" --uninstall --yes
  [ "$status" -eq 0 ]
  grep -q 'down --volumes' "$CALLS"
  [ -d "$HOME/orch" ]
}

@test "uninstall --purge removes the directory" {
  sh "$S" --token t --server https://o.example.com
  run sh "$S" --uninstall --purge --yes
  [ "$status" -eq 0 ]
  [ ! -e "$HOME/orch" ]
}

@test "uninstall without --yes and without a terminal refuses" {
  sh "$S" --token t --server https://o.example.com
  run sh "$S" --uninstall </dev/null
  [ "$status" -ne 0 ]
  grep -q . "$HOME/orch/.env"
}
