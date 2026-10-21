#!/bin/sh
# Idempotent: create /srv/git/acme/widgets.git from /app/fixture-repo
set -eu
BARE=/srv/git/acme/widgets.git
if [ -d "$BARE" ] && git -C "$BARE" rev-parse --verify refs/heads/main >/dev/null 2>&1; then
  git -C "$BARE" config http.receivepack true
  exit 0
fi
mkdir -p "$BARE"
git init --bare -b main "$BARE" >/dev/null
git -C "$BARE" config http.receivepack true
T=$(mktemp -d)
cp -r /app/fixture-repo/. "$T"/
cd "$T"
git init -b main >/dev/null
git add -A
GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.com GIT_AUTHOR_DATE="2024-01-01T00:00:00Z" \
GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.com GIT_COMMITTER_DATE="2024-01-01T00:00:00Z" \
  git commit -q -m "Initial commit"
git push -q "$BARE" main:main
cd /
rm -rf "$T"
