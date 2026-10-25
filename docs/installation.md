# Server installation

Requirements: a Linux host with Docker Engine 26+ and the Compose plugin, ports 80 and 443 reachable from the internet, and a DNS name.

The stack (`deploy/server/compose.yaml`) has these pieces:

| Piece             | What it does                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `caddy`           | Automatic HTTPS for `ORCH_DOMAIN`, serves the web build, proxies the rest to the server        |
| `server`          | REST API, GitHub OAuth and webhooks, dispatcher, agent WebSocket gateway, MCP server           |
| `postgres`        | All state. Internal network only                                                               |
| `backup`          | Scheduled `pg_dump` with rotation, optional encryption and S3 upload ({doc}`backups`)          |
| `agent` (members) | `ghcr.io/theroxat/orch-agent`: runs on each member's machine, drives their local Docker daemon |

## 1. DNS

Create an `A` (and optionally `AAAA`) record for your domain, for example `orch.selfhostr.io`, pointing at the host. Caddy requests the Let's Encrypt certificate on first start, so DNS must resolve before you start the stack.

## 2. Get the deployment files

```sh
git clone https://github.com/Theroxat/claude_orch.git
cd claude_orch/deploy/server
cp .env.example .env
```

## 3. Fill in `.env`

Generate the secrets with the commands shown in the file:

```sh
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -base64 32   # ORCH_ENCRYPTION_KEY
openssl rand -hex 32      # GITHUB_WEBHOOK_SECRET
```

The variables are listed in the {ref}`server environment table <server-env>`. The GitHub values come from {doc}`github-app`.

## 4. Put the GitHub App private key in place

Create the App first ({doc}`github-app`), then:

```sh
mkdir -p secrets
mv ~/Downloads/<app-name>.<date>.private-key.pem secrets/github-app.pem
sudo chown 1000:1000 secrets/github-app.pem && chmod 400 secrets/github-app.pem
```

The file must exist before the first start (otherwise Docker creates a directory in its place). The server runs as uid 1000, so the file has to be readable by that user.

## 5. Start

```sh
docker compose up -d          # pulls ghcr.io/theroxat/orch-server and orch-web
# or build from your checkout:
docker compose up -d --build
```

The server applies database migrations on every start. Check it:

```sh
docker compose ps
curl -fsS https://orch.selfhostr.io/healthz     # {"status":"ok"}
```

If you change `HTTP_PORT` or `HTTPS_PORT`, the Let's Encrypt challenge cannot succeed on its own. Use Caddy behind another proxy that owns 80/443, or a DNS challenge build of Caddy.

## Managing access

Who may sign in is explained in {ref}`access-control`. Admins (`ORCH_ADMIN_GITHUB_LOGINS`) see an **Access** page in the web UI (`/admin/access`). To let someone in, you do not edit `.env` or restart anything:

- **Access requests.** Someone who is not allowed yet signs in with GitHub and gets a "Request access" page instead of a session, with an optional message for the admins. The request appears on the Access page (with a counter in the navigation); **Approve** lets them sign in, **Deny** shows them "Your request was declined".
- **Pre-approve.** Type a GitHub login on the Access page to approve it before the person even tries.
- **Invite links.** Create a single-use or multi-use link that expires after 1 to 720 hours and send it to someone. Opening `https://<domain>/invite/<token>` and signing in with GitHub approves that account automatically (never one an admin declined). Only a hash of the token is stored; the link is shown once. Revoke a link from the Access page at any time.
- **Remove.** Removing someone sets their access to denied. Like removal from the env lists, nothing is deleted: their sessions, personal tokens, OAuth grants and agents are refused at once (the cached check is dropped; connected agents are disconnected with close code 4403 and keep retrying slowly) and work again if you approve them later, without re-enrolling. A declined or removed login stays refused even if it is in `ORCH_ALLOWED_GITHUB_LOGINS`, in an allowed organization or the server runs with `ORCH_ALLOW_ANY_GITHUB_USER=true`; only admins are never refused.

The env lists keep working for people who should always have access (logins, whole organizations). Every decision is written to the audit log.

## Behind Cloudflare Tunnel

If you host behind a Cloudflare Tunnel, Cloudflare terminates TLS for your domain and `cloudflared` forwards plain HTTP to a local port. There is no ACME and ports 80 and 443 are not used. Set these in `.env`:

```sh
ORCH_DOMAIN=orch.selfhostr.io
ORCH_TLS_MODE=tunnel                      # default is acme
HTTP_PORT=8495                            # local port cloudflared connects to
ORCH_BIND_ADDR=127.0.0.1                  # keep the port off the LAN
HTTPS_PUBLISH=127.0.0.1:                  # nothing serves 443; maps it to a random loopback port
ORCH_PUBLIC_URL=https://orch.selfhostr.io # always https
```

In this mode Caddy serves plain HTTP only (`auto_https off`, no HSTS; Cloudflare can add HSTS at the edge). The routes and the Content-Security-Policy are the same as in ACME mode. The server builds the GitHub OAuth callback, the `install.sh` URL, the install and `claude mcp add` commands and the `Secure` session cookie from `ORCH_PUBLIC_URL`, so they say `https` even though the request reached the server over HTTP. It trusts `X-Forwarded-For` only from private networks (the Caddy container), see `ORCH_TRUST_PROXY`.

`cloudflared` ingress (`config.yml`, or the equivalent public hostname in the Zero Trust dashboard):

```yaml
ingress:
  - hostname: orch.selfhostr.io
    service: http://localhost:8495
  - service: http_status:404
```

**`cloudflared` in Docker on another Compose project.** If `cloudflared` runs in Docker, use the optional override `deploy/server/compose.cloudflared.yaml`: `docker compose -f compose.yaml -f compose.cloudflared.yaml up -d` and set the tunnel service URL to `http://orch-caddy:80`. It attaches Caddy to the external network named by `CLOUDFLARED_NETWORK` (default `cloudflared_default`, which must exist) under the alias `orch-caddy`, and publishes no host port for Caddy (`ports: !reset []`, needs Docker Compose 2.24 or later). Without a GitHub App yet, create an empty `secrets/github-app.pem` so Docker does not create a directory there; GitHub routes answer 503 until all `GITHUB_*` values are set.

If `cloudflared` runs in Docker on the same Compose network, use `service: http://caddy:80` (the Caddy container name or service name) instead. If it runs in another container on a different network or on another host, set `ORCH_BIND_ADDR=0.0.0.0` so it can reach the port, and firewall that port so only `cloudflared` can connect: with `trusted_proxies` on private ranges, anyone who can reach the port directly could forge `X-Forwarded-For`.

Notes:

- WebSockets are enabled by default in Tunnel, which `/agent/ws` needs. Cloudflare closes idle WebSockets after about 100 s; the agent heartbeat is 30 s, so the link stays up.
- Do not put Cloudflare Access in front of `/api/github/webhook`, `/agent/ws`, `/mcp`, `/.well-known/oauth-*`, `/api/oauth/*` or `/install.sh`: they authenticate themselves (HMAC, agent credential, OAuth or personal token, public script) and Access would block GitHub, Claude Code and the agents.
- "Always Use HTTPS" is fine.
- Update the GitHub App URLs as in {doc}`github-app`; they use your public `https` domain.

(multi-instance)=

## Running several server instances

One server handles a team comfortably; run several to keep orch up while one restarts (upgrades, host maintenance) or crashes. The instances share **Postgres and nothing else**: no Redis, no shared disk, no sticky sessions.

```sh
cd deploy/server
docker compose -f compose.yaml -f compose.replicas.yaml up -d   # 2 replicas (ORCH_SERVER_REPLICAS)
```

`compose.replicas.yaml` scales the `server` service and mounts `routes.replicas.caddy`, the same routes with a load balancer over every replica (Caddy reads the A records of `server` every 5 s, sends each request to the least busy replica and retries on another one when a replica is restarting). Elsewhere (Kubernetes, another proxy), the same rules apply:

- Every instance gets the **same configuration** (`.env`): same `DATABASE_URL`, `ORCH_ENCRYPTION_KEY`, GitHub App, `DISPATCHER_ENABLED`, rate limits.
- Each one needs a **unique `ORCH_INSTANCE_ID`**. The default, the hostname, is unique per container; set it explicitly when several processes share a hostname (host networking).
- Instances cooperate when they share the database **and** `ORCH_CLUSTER_NAME` (default `orch`; only change it to run separate orch deployments on one database).
- Migrations run on every start; Prisma holds a database lock while it applies them, so replicas starting together are safe.

**Why no sticky sessions, WebSockets included.** Nothing a client depends on lives in one process: sessions, OAuth codes, tokens and tasks are in Postgres, and the MCP endpoint is stateless. An agent's WebSocket stays on the replica that accepted it for as long as it is open; that replica writes "agent X is on instance B" to the database and tells the others. When the dispatcher (running on another replica) offers a task to that agent, or anyone cancels a run or changes its configuration, the message is relayed to the replica holding the socket over Postgres `LISTEN/NOTIFY`, and an offer the socket did not take counts as "offline" exactly as on a single server. When the agent reconnects (after a restart of its replica, say), it may land on another replica, which takes over: the agent replays its outbox and the server reconciles its runs, as it already does after any reconnect. A browser's live-log stream (SSE) can likewise open on any replica: that replica mirrors the run from the replica receiving the agent's output while someone watches it.

What runs where:

| Concern                                             | With several instances                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatcher loop                                     | One **leader** (Postgres advisory lock on a dedicated connection). A kick on another instance (a new task, a finished run) is forwarded to it. When the leader stops or loses its database connection, another instance takes over within `ORCH_LEADER_RETRY_MS` (5 s) |
| Retention purges, cleanup of expired rows           | One `maintenance` leader, same mechanism                                                                                                                                                                                                                               |
| Agent WebSockets                                    | Any instance; messages for an agent are relayed to the instance holding its socket                                                                                                                                                                                     |
| Live task output (SSE)                              | Kept in memory by the instance holding the agent's socket, mirrored on demand by the instances with viewers. Still never written to disk                                                                                                                               |
| Notification deliveries (Slack, webhook, e-mail...) | A durable queue in the database: sent at once by the instance that queued them, retries and leftovers of a dead instance picked up by any instance, each delivery by one worker at a time                                                                              |
| Unread notification counts                          | Read from the database on every request: nothing to invalidate                                                                                                                                                                                                         |
| Access decisions of admins                          | Cached per instance for `ORCH_ALLOWLIST_CACHE_SEC`; an approval, denial or removal clears the cache on every instance at once and disconnects the person's agents wherever they are                                                                                    |

**Rate limits.** The limits that stop abuse hold for the whole deployment: the `auth` and `agent-connect` tiers, access requests, OAuth client registration and token requests, and test notifications are counted in Postgres (they are rare requests that already use the database). The other tiers (`api`, `heavy`, `stream`, `mcp`, `webhook`) protect a process from load and are counted **per instance**, so a client whose requests are spread over N instances gets up to N times the limit; every API request stays free of an extra query. The concurrent live-log streams per user (8) are per instance too. If Postgres is unreachable, shared limits fall back to per-instance counting rather than failing requests.

**What stays per instance.** The `orch_agents_connected` metric counts the sockets of the instance that serves `/metrics` (sum the series over the instances); every instance exports its own `orch_cluster_leader{lease}` (1 on the leader), `orch_cluster_leader_changes_total`, `orch_cluster_peers` and `orch_cluster_messages_total`. Scrape each replica: in `deploy/observability/prometheus.yml`, replace the static target with `dns_sd_configs: [{ names: ['server'], type: A, port: 3000 }]`. Leadership changes are also logged (`cluster: leadership acquired` / `lost`).

**Failure behaviour.** Messages between instances are best effort; the database stays the truth and each instance reloads the agent directory every `ORCH_INSTANCE_HEARTBEAT_MS` (10 s) and after a reconnect. A leader whose host vanishes without closing its connection keeps its lock until Postgres notices (about 25 s: the server sets short TCP keepalives on that connection). An instance that crashes is considered gone after three missed heartbeats (30 s): until then, offers relayed to its agents time out (5 s) and are treated as undeliverable, and its agents reconnect elsewhere. Running alone, an instance costs one heartbeat query every 10 s and one row write per agent connect or disconnect; nothing is added to request paths.

## Monitoring

The server exposes `/healthz` (liveness) and `/readyz` (database reachable), plus optional Prometheus metrics and OpenTelemetry traces. See {doc}`observability` for the metrics, the optional Prometheus and Grafana stack in `deploy/observability/`, and how `/metrics` stays off the public internet.

## Upgrading

```sh
git pull
docker compose pull && docker compose up -d     # or: docker compose up -d --build
```

Members upgrade their agent with `docker compose -f ~/orch/compose.yaml pull && docker compose -f ~/orch/compose.yaml up -d`, or with one click, see {ref}`updating-agents`.

## Backups and restore

The `backup` service dumps the database every night at 03:00 UTC (`BACKUP_SCHEDULE`), keeps 7 daily, 4 weekly and 6 monthly dumps, and can encrypt them (age) and upload them to S3-compatible storage. To restore:

```sh
backup/restore.sh --list
backup/restore.sh            # newest dump, asks for confirmation
```

The dump does **not** contain `.env` (notably `ORCH_ENCRYPTION_KEY`) or the GitHub App private key: keep them separately. Details, encryption, off-site copies and what is not backed up are in {doc}`backups`.
