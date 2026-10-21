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
case "$*" in *"exec -T agent test"*) exit 1 ;; esac
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

# ---- host shortcut and Claude login offer ----

@test "install writes an executable orch wrapper pointing at the install dir" {
  run sh "$S" --token t --server https://o.example.com
  [ "$status" -eq 0 ]
  W="$HOME/.local/bin/orch"
  [ -x "$W" ]
  grep -q "compose='$HOME/orch/compose.yaml'" "$W"
  grep -q 'exec -T agent orch "\$@"' "$W"
  case "$output" in *"not on your PATH"*) true ;; *) false ;; esac
}

@test "wrapper respects --dir and does not warn when ~/.local/bin is on PATH" {
  run env PATH="$HOME/.local/bin:$PATH" sh "$S" --token t --server https://o.example.com --dir "$T/custom"
  [ "$status" -eq 0 ]
  grep -q "compose='$T/custom/compose.yaml'" "$HOME/.local/bin/orch"
  case "$output" in *"not on your PATH"*) false ;; *) true ;; esac
}

@test "wrapper runs docker compose exec in the agent, with -T when not on a terminal" {
  sh "$S" --token t --server https://o.example.com
  : >"$CALLS"
  run "$HOME/.local/bin/orch" status --x
  [ "$status" -eq 0 ]
  grep -q "docker compose -f $HOME/orch/compose.yaml exec -T agent orch status --x" "$CALLS"
}

@test "wrapper: orch update runs inside the agent when it is running" {
  sh "$S" --token t --server https://o.example.com
  cat >"$T/bin/docker" <<'F'
#!/bin/sh
echo "docker $*" >>"$CALLS"
case "$*" in *" ps -q agent"*) echo abc123 ;; esac
exit 0
F
  : >"$CALLS"
  run "$HOME/.local/bin/orch" update --when-idle
  [ "$status" -eq 0 ]
  grep -q "exec -T agent orch update --when-idle" "$CALLS"
  run grep -q " pull agent" "$CALLS"
  [ "$status" -ne 0 ]
}

@test "wrapper: orch update falls back to compose pull + up when the agent is stopped" {
  sh "$S" --token t --server https://o.example.com
  : >"$CALLS"
  run "$HOME/.local/bin/orch" update
  [ "$status" -eq 0 ]
  grep -q "docker compose -f $HOME/orch/compose.yaml pull agent" "$CALLS"
  grep -q "docker compose -f $HOME/orch/compose.yaml up -d agent" "$CALLS"
  run grep -q "exec" "$CALLS"
  [ "$status" -ne 0 ]
}

@test "rerun is idempotent: same wrapper, no duplicate" {
  sh "$S" --token t --server https://o.example.com
  cp "$HOME/.local/bin/orch" "$T/first"
  run sh "$S" --server https://o.example.com
  [ "$status" -eq 0 ]
  cmp "$HOME/.local/bin/orch" "$T/first"
  [ "$(ls "$HOME/.local/bin" | wc -l)" -eq 1 ]
}

@test "a foreign orch binary is left alone" {
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\necho mine\n' >"$HOME/.local/bin/orch"
  run sh "$S" --token t --server https://o.example.com
  [ "$status" -eq 0 ]
  grep -q mine "$HOME/.local/bin/orch"
  run sh "$S" --uninstall --yes
  grep -q mine "$HOME/.local/bin/orch"
}

@test "uninstall removes the wrapper" {
  sh "$S" --token t --server https://o.example.com
  [ -e "$HOME/.local/bin/orch" ]
  run sh "$S" --uninstall --yes
  [ "$status" -eq 0 ]
  [ ! -e "$HOME/.local/bin/orch" ]
}

@test "without a terminal the login question is skipped and the one-liner is printed" {
  run sh "$S" --token t --server https://o.example.com </dev/null
  [ "$status" -eq 0 ]
  case "$output" in *"Connect your Claude account now"*) false ;; *) true ;; esac
  case "$output" in *"  orch login"*) true ;; *) false ;; esac
  run grep -q 'exec agent orch login' "$CALLS"
  [ "$status" -eq 1 ]
}

@test "--yes never asks for the Claude login even with a terminal" {
  echo y >"$T/tty"
  run env ORCH_TTY="$T/tty" sh "$S" --yes --token t --server https://o.example.com
  [ "$status" -eq 0 ]
  run grep -q 'exec agent orch login' "$CALLS"
  [ "$status" -eq 1 ]
}

@test "with a terminal, answering yes runs orch login interactively in the agent" {
  echo y >"$T/tty"
  run env ORCH_TTY="$T/tty" sh "$S" --token t --server https://o.example.com
  [ "$status" -eq 0 ]
  grep -q 'docker compose .* exec agent orch login' "$CALLS"
  case "$output" in *"Last step"*) false ;; *) true ;; esac
}

@test "with a terminal, an empty answer defaults to yes" {
  echo >"$T/tty"
  run env ORCH_TTY="$T/tty" sh "$S" --token t --server https://o.example.com
  [ "$status" -eq 0 ]
  grep -q 'exec agent orch login' "$CALLS"
}

@test "with a terminal, answering no prints how to log in later" {
  echo n >"$T/tty"
  run env ORCH_TTY="$T/tty" sh "$S" --token t --server https://o.example.com
  [ "$status" -eq 0 ]
  case "$output" in *"  orch login"*) true ;; *) false ;; esac
  run grep -q 'exec agent orch login' "$CALLS"
  [ "$status" -eq 1 ]
}

@test "an already connected Claude account is not asked again" {
  echo y >"$T/tty"
  cat >"$T/bin/docker" <<'F'
#!/bin/sh
echo "docker $*" >>"$CALLS"
[ "$1" = "version" ] && echo 27.1.0
exit 0
F
  run env ORCH_TTY="$T/tty" sh "$S" --token t --server https://o.example.com
  case "$output" in *"already connected"*) true ;; *) false ;; esac
  run grep -q 'exec agent orch login' "$CALLS"
  [ "$status" -eq 1 ]
}

@test "a failed login does not fail the install" {
  echo y >"$T/tty"
  cat >"$T/bin/docker" <<'F'
#!/bin/sh
echo "docker $*" >>"$CALLS"
[ "$1" = "version" ] && echo 27.1.0
case "$*" in *"exec -T agent test"*) exit 1 ;; *"orch login"*) exit 1 ;; esac
exit 0
F
  run env ORCH_TTY="$T/tty" sh "$S" --token t --server https://o.example.com
  [ "$status" -eq 0 ]
  case "$output" in *"Last step"*) true ;; *) false ;; esac
}
