# FAQ and troubleshooting

## The server does not start in production

If the log says nobody restricts sign-in, set `ORCH_ADMIN_GITHUB_LOGINS` (or an allowlist), or `ORCH_ALLOW_ANY_GITHUB_USER=true` for a non-public server. See {ref}`access-control`.

## Docker created a directory instead of `github-app.pem`

The key file must exist before the first `docker compose up`. Remove the directory, put the key in `secrets/github-app.pem` and restart. Without a GitHub App yet, create an empty file; GitHub routes answer 503 until all `GITHUB_*` values are set.

## Caddy cannot get a certificate

DNS must resolve to the host and ports 80/443 must be reachable. Custom `HTTP_PORT`/`HTTPS_PORT` break the Let's Encrypt challenge; use another proxy or the Cloudflare Tunnel mode ({doc}`installation`).

## "Request access" instead of a session

Your GitHub account is not allowed yet. Ask an admin to approve it on the Access page, or use an invite link. Org-based access also needs the App's **Members: Read-only** permission ({doc}`github-app`).

## The agent shows "Claude login expired"

A task failed with `401 ... OAuth access token is invalid`. Run `orch login`; the running agent picks up the new token without a restart.

## The agent is offline or keeps reconnecting

Check `orch status` and `docker compose -f ~/orch/compose.yaml logs agent`. The agent connects out to `wss://<domain>/agent/ws`; make sure nothing (for example Cloudflare Access) blocks that path. Close code 4403 means the member's access was removed or could not be verified; the agent retries slowly and recovers when access is restored.

## No tasks are offered to me

Offers require an active `AUTO` participation, an online unpaused agent, a fresh usage report, enough estimated budget and an allowed model. `orch list` shows what you can take now; `orch status` shows pause state. Run `orch doctor` to check the Claude binary and token.

## `orch` command not found

`install.sh` puts the shortcut in `~/.local/bin/orch`; add that directory to your `PATH`.

## Is it safe with strangers?

No. See {doc}`security`.

## Upgrading broke something

Pin `ORCH_VERSION` (server) or `ORCH_AGENT_TAG` (agent) to the previous release and run `docker compose up -d`. Restore from a dump if needed ({doc}`installation`).
