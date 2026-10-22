# Server installation

Requirements: a Linux host with Docker Engine 26+ and the Compose plugin, ports 80 and 443 reachable from the internet, and a DNS name.

The stack (`deploy/server/compose.yaml`) has these pieces:

| Piece             | What it does                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `caddy`           | Automatic HTTPS for `ORCH_DOMAIN`, serves the web build, proxies the rest to the server        |
| `server`          | REST API, GitHub OAuth and webhooks, dispatcher, agent WebSocket gateway, MCP server           |
| `postgres`        | All state. Internal network only                                                               |
| `backup`          | Nightly `pg_dump` into a volume with retention                                                 |
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

## Upgrading

```sh
git pull
docker compose pull && docker compose up -d     # or: docker compose up -d --build
```

Members upgrade their agent with `docker compose -f ~/orch/compose.yaml pull && docker compose -f ~/orch/compose.yaml up -d`, or with one click, see {ref}`updating-agents`.

## Backups and restore

The `backup` service writes `orch-<UTC timestamp>.dump` files (pg_dump custom format) into the `backups` volume every night at `BACKUP_HOUR_UTC` and deletes dumps older than `BACKUP_RETENTION_DAYS` (14 by default).

```sh
# list backups
docker compose exec backup ls -lh /backups

# copy the newest one out of the volume (do this regularly: a backup on the same host is not a disaster plan)
docker compose cp backup:/backups/orch-<timestamp>.dump ./orch.dump

# take one now
docker compose exec -e BACKUP_ON_START=false backup sh -c \
  'pg_dump --format=custom --no-owner --file=/backups/orch-manual.dump'
```

Restore into a running stack (this replaces the data):

```sh
docker compose stop server
docker compose cp ./orch.dump postgres:/tmp/orch.dump
docker compose exec postgres sh -c \
  'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB" /tmp/orch.dump && rm /tmp/orch.dump'
docker compose start server
```

Also keep `.env` (in particular `ORCH_ENCRYPTION_KEY`) and the GitHub App private key somewhere safe; they are not in the dump.
