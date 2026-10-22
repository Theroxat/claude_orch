# Configuration reference

(server-env)=

## Server environment (`deploy/server/.env`)

| Variable                                                                       | Required | Meaning                                                                               |
| ------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------- |
| `ORCH_DOMAIN`                                                                  | yes      | Public host name (example: `orch.selfhostr.io`)                                       |
| `HTTP_PORT`, `HTTPS_PORT`                                                      | no       | Host ports for Caddy (default 80 and 443). The only ports published                   |
| `ORCH_BASE_URL`                                                                | no       | Public URL, default `https://$ORCH_DOMAIN`. Set only for a non-standard port          |
| `ORCH_TLS_MODE`, `ORCH_BIND_ADDR`, `HTTPS_PUBLISH`, `ORCH_PUBLIC_URL`          | no       | Cloudflare Tunnel mode, see [installation](installation.md#behind-cloudflare-tunnel)  |
| `ORCH_TRUST_PROXY`                                                             | no       | Peers allowed to set `X-Forwarded-*` (default: private networks, i.e. Caddy)          |
| `ORCH_VERSION`                                                                 | no       | Image tag of `orch-server` and `orch-web` (default `latest`)                          |
| `POSTGRES_PASSWORD`                                                            | yes      | Database password (`POSTGRES_USER` and `POSTGRES_DB` default to `orch`)               |
| `ORCH_ENCRYPTION_KEY`                                                          | yes      | 32 random bytes, base64. Encrypts stored GitHub user tokens. Back it up               |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | yes      | From your GitHub App ({doc}`github-app`)                                              |
| `ORCH_ADMIN_GITHUB_LOGINS`                                                     | yes (\*) | Admins: GitHub logins, comma-separated, case-insensitive. They manage the Access page |
| `ORCH_ALLOWED_GITHUB_LOGINS`, `ORCH_ALLOWED_GITHUB_ORGS`                       | no (\*)  | Who may also sign in: GitHub logins and/or organizations, comma-separated             |
| `ORCH_ALLOW_ANY_GITHUB_USER`                                                   | no       | `true` lets any GitHub account sign in. Only for a server that is not public          |
| `ORCH_ALLOWLIST_CACHE_SEC`                                                     | no       | How often org membership is re-checked for open sessions, default 300                 |
| `ORCH_ACCESS_GRACE_SEC`                                                        | no       | GitHub outage grace for org-based access, default 900 (see {doc}`security`)           |
| `GITHUB_WEBHOOK_SECRET`                                                        | yes      | Same value as the App's webhook secret                                                |
| `GITHUB_APP_PRIVATE_KEY_FILE`                                                  | yes      | Host path of the App private key (default `./secrets/github-app.pem`)                 |
| `LOG_LEVEL`                                                                    | no       | `info` by default                                                                     |
| `BACKUP_HOUR_UTC`, `BACKUP_RETENTION_DAYS`, `BACKUP_ON_START`                  | no       | Backup schedule (default 03:00 UTC), retention (14 days), dump at container start     |

(access-control)=

### Who may sign in

(\*) **In production the server refuses to start** when nobody restricts sign-in: no `ORCH_ADMIN_GITHUB_LOGINS`, no `ORCH_ALLOWED_GITHUB_LOGINS`, no `ORCH_ALLOWED_GITHUB_ORGS` and no access approved on the Access page, unless `ORCH_ALLOW_ANY_GITHUB_USER=true`. Without an allowlist, anyone with a GitHub account could sign in, see the projects set to "All orch users on this server" and join their pools.

The usual setup is to list yourself in `ORCH_ADMIN_GITHUB_LOGINS` and let people in from the web UI (see "Managing access" in {doc}`installation`). A user may sign in if they are an admin, **or** their login is listed, **or** they are an active member of a listed organization, **or** an admin approved them on the Access page.

Org membership is checked at login with the user's own GitHub token, and again for open sessions every `ORCH_ALLOWLIST_CACHE_SEC` seconds (default 300). Removing someone from the list or the org therefore takes effect within minutes (logins are re-checked on every request). Org checks need the GitHub App organization permission **Members: Read-only** ({doc}`github-app`) and the App installed on, or approved by, the organization. In development and tests an empty allowlist only logs a warning.

(rate-limits)=

### Rate limits

The server limits requests with an **in-memory** counter (`@fastify/rate-limit`). orch runs as one server instance, so no shared store is needed; counters reset when the server restarts and are not shared between instances. Each limit counts requests per window (`RATE_LIMIT_WINDOW_SEC`, default 60 s). Over the limit the server answers `429` with a `Retry-After` header, `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers, and the usual error body `{"error": {"code": "rate_limited", "message": "..."}}`. The web app shows a short notice.

| Variable                       | Default | Applies to (key)                                                                                                                                              |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED`           | `true`  | `false` turns the HTTP limiter off (also the agent message cap)                                                                                               |
| `RATE_LIMIT_WINDOW_SEC`        | 60      | Window length of every limit below                                                                                                                            |
| `RATE_LIMIT_API_MAX`           | 300     | All other routes (signed-in user, else client IP)                                                                                                             |
| `RATE_LIMIT_AUTH_MAX`          | 20      | Sign-in start and callback, access requests, OAuth `authorize`/`register`/`token`/`revoke`, agent enrollment, invite links (client IP)                        |
| `RATE_LIMIT_WEBHOOK_MAX`       | 600     | `POST /api/github/webhook` (client IP). Bodies are capped at 1 MiB                                                                                            |
| `RATE_LIMIT_MCP_MAX`           | 120     | `/mcp` (bearer token, else client IP)                                                                                                                         |
| `RATE_LIMIT_HEAVY_MAX`         | 60      | Expensive reads such as the pool view (signed-in user)                                                                                                        |
| `RATE_LIMIT_AGENT_CONNECT_MAX` | 30      | New agent WebSocket connections (client IP)                                                                                                                   |
| `RATE_LIMIT_AGENT_MSG_PER_SEC` | 100     | Messages per second on one agent connection. Above it the socket is closed with code 4429; the agent reconnects with its normal backoff. `0` disables the cap |

Health checks (`/healthz`, `/api/healthz`), `install.sh` and `/agent/compose.yaml` are never limited. The existing per-IP limits on access requests and on OAuth registration and token calls stay in place on top of these.

The client IP comes from `X-Forwarded-For` only when the direct peer is in `ORCH_TRUST_PROXY` (default: private networks, i.e. the Caddy container, which sets the header itself; in Cloudflare Tunnel mode Caddy keeps the chain Cloudflare built). A client that reaches the server directly cannot choose its own IP by sending that header. If you publish the server port without Caddy, set `ORCH_TRUST_PROXY=false`.

## Other server knobs

These have defaults and are defined in `apps/server/src/config/index.ts`. To change one, add it to the `server` service `environment` in `compose.yaml`.

| Variable                     | Default                     | Meaning                                                                  |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------ |
| `DISPATCHER_ENABLED`         | `true`                      | Run the dispatcher                                                       |
| `DISPATCHER_INTERVAL_MS`     | 5000                        | Dispatcher tick                                                          |
| `AUTO_OFFER_TTL_SEC`         | 60                          | Pending auto offers expire after this                                    |
| `CONSENT_REQUEST_TTL_SEC`    | 1800                        | Pending approval requests expire after this                              |
| `USAGE_STALE_SEC`            | 900                         | A usage report older than this makes a member ineligible for auto offers |
| `BUDGET_SAFETY_RESERVE`      | 0                           | Extra server-side reserve on top of the agent's own 20 %                 |
| `OPUS_FACTOR`                | 5                           | Weight of Opus relative to Sonnet in estimates                           |
| `PRO_WINDOW_WEIGHTED`        | 44000                       | Weighted tokens of a Pro 5-hour window (base of S/M/L estimates)         |
| `EXEC_LEASE_GRACE_SEC`       | 900                         | Grace added to task timeouts before an auto run is declared lost         |
| `AGENT_LEASE_SEC`            | 1800                        | Running assignments of an agent unseen this long become lost             |
| `AGENT_HEARTBEAT_SEC`        | 30                          | Agent heartbeat interval                                                 |
| `AGENT_HEARTBEAT_TIMEOUT_MS` | 90000                       | Agent considered offline after this                                      |
| `AGENT_USAGE_SEC`            | 300                         | Usage report interval                                                    |
| `ORCH_AGENT_IMAGE_REPO`      | ghcr.io/theroxat/orch-agent | Image repository offered for one-click agent updates                     |

## Agent environment

See {doc}`cli` for `~/orch/.env`; the full list is in `apps/agent/src/config.ts`.

## Development environment (`.env`)

`./dev` copies `.env.example` to `.env` on first run. Besides the `GITHUB_*` and `ORCH_ENCRYPTION_KEY` values shared with production, it has `ORCH_DEV_WEB_PORT` (8470), `ORCH_DEV_API_PORT` (8471), `POSTGRES_*` placeholders, `ORCH_DEV_ENROLL_TOKEN` and `ORCH_DEV_AGENT_CREDENTIAL` for the dev agent. See {doc}`development`.
