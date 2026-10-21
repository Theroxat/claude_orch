# orch

A shared to-do list for small, trusted teams, with automation on top.

- Tasks are GitHub issues. A team member (or Claude Code, through MCP) adds them to a shared pool.
- Each member runs tasks **on their own machine, with their own Claude subscription**. Nothing is pooled across accounts.
- A task runs in a throwaway container that only sees its own git clone, then orch pushes a branch and opens a PR.
- The central server only sees usage estimates and task statuses, never Claude credentials.
- Everything runs in Docker: server, web, database, proxy, member agent, task sandboxes and all dev workflows.

Design and decisions: [docs/PLAN.md](docs/PLAN.md).

## Contents

- [Architecture](#architecture)
- [Server installation](#server-installation)
- [Creating the GitHub App](#creating-the-github-app)
- [Adding a member](#adding-a-member)
- [Day-to-day usage](#day-to-day-usage)
- [MCP setup](#mcp-setup)
- [Local development](#local-development)
- [Security model](#security-model)
- [Limitations](#limitations)
- [License](#license)

## Architecture

```
                         GitHub (App: OAuth, webhooks, issues, PRs)
                              ^  |
              REST + OAuth    |  | webhooks
                              |  v
 Browser ------ HTTPS ---->  +-------------------------------+      +----------+
 Claude Code -- /mcp ----->  |  Caddy (auto HTTPS, static    | ---> | server   | --- Postgres
                             |  web build, reverse proxy)    |      | (Fastify)|     (+ nightly
 Member agents -- wss ---->  |  /api /mcp /agent/* /install.sh      +----------+      pg_dump)
   /agent/ws                 +-------------------------------+
        ^
        | outbound WebSocket only (no inbound ports on member machines)
        |
 +------+------------------- member machine (any Docker host) -------+
 |  agent container (docker.sock, ~/.claude read-only for usage)      |
 |    - mirrors + isolated clone per task                             |
 |    - `orch` CLI, `screen` sessions for manual mode                 |
 |    - starts, per task:                                             |
 |        task container: only the clone mounted, non-root, claude    |
 +--------------------------------------------------------------------+
```

| Piece             | What it does                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `caddy`           | Automatic HTTPS for `ORCH_DOMAIN`, serves the web build, proxies the rest to the server        |
| `server`          | REST API, GitHub OAuth and webhooks, dispatcher, agent WebSocket gateway, MCP server           |
| `postgres`        | All state. Internal network only                                                               |
| `backup`          | Nightly `pg_dump` into a volume with retention                                                 |
| `agent` (members) | `ghcr.io/theroxat/orch-agent`: runs on each member's machine, drives their local Docker daemon |

## Server installation

Requirements: a Linux host with Docker Engine 26+ and the Compose plugin, ports 80 and 443 reachable from the internet, and a DNS name.

**1. DNS.** Create an `A` (and optionally `AAAA`) record for your domain, for example `orch.selfhostr.io`, pointing at the host. Caddy requests the Let's Encrypt certificate on first start, so DNS must resolve before you start the stack.

**2. Get the deployment files.**

```sh
git clone https://github.com/Theroxat/claude_orch.git
cd orch/deploy/server
cp .env.example .env
```

**3. Fill in `.env`.** Generate the secrets with the commands shown in the file:

```sh
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -base64 32   # ORCH_ENCRYPTION_KEY
openssl rand -hex 32      # GITHUB_WEBHOOK_SECRET
```

| Variable                                                                       | Required | Meaning                                                                                |
| ------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------- |
| `ORCH_DOMAIN`                                                                  | yes      | Public host name (example: `orch.selfhostr.io`)                                        |
| `HTTP_PORT`, `HTTPS_PORT`                                                      | no       | Host ports for Caddy (default 80 and 443). The only ports published                    |
| `ORCH_BASE_URL`                                                                | no       | Public URL, default `https://$ORCH_DOMAIN`. Set only for a non-standard port           |
| `ORCH_TLS_MODE`, `ORCH_BIND_ADDR`, `HTTPS_PUBLISH`, `ORCH_PUBLIC_URL`          | no       | Cloudflare Tunnel mode, see [Behind Cloudflare Tunnel](#behind-cloudflare-tunnel)      |
| `ORCH_TRUST_PROXY`                                                             | no       | Peers allowed to set `X-Forwarded-*` (default: private networks, i.e. Caddy)           |
| `ORCH_VERSION`                                                                 | no       | Image tag of `orch-server` and `orch-web` (default `latest`)                           |
| `POSTGRES_PASSWORD`                                                            | yes      | Database password (`POSTGRES_USER` and `POSTGRES_DB` default to `orch`)                |
| `ORCH_ENCRYPTION_KEY`                                                          | yes      | 32 random bytes, base64. Encrypts stored GitHub user tokens. Back it up                |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | yes      | From your GitHub App (next section)                                                    |
| `ORCH_ALLOWED_GITHUB_LOGINS`, `ORCH_ALLOWED_GITHUB_ORGS`                       | yes (\*) | Who may sign in: GitHub logins and/or organizations, comma-separated, case-insensitive |
| `ORCH_ALLOW_ANY_GITHUB_USER`                                                   | no       | `true` lets any GitHub account sign in. Only for a server that is not public           |
| `GITHUB_WEBHOOK_SECRET`                                                        | yes      | Same value as the App's webhook secret                                                 |
| `GITHUB_APP_PRIVATE_KEY_FILE`                                                  | yes      | Host path of the App private key (default `./secrets/github-app.pem`)                  |
| `LOG_LEVEL`                                                                    | no       | `info` by default                                                                      |
| `BACKUP_HOUR_UTC`, `BACKUP_RETENTION_DAYS`, `BACKUP_ON_START`                  | no       | Backup schedule (default 03:00 UTC), retention (14 days), dump at container start      |

(\*) **In production the server refuses to start** when both `ORCH_ALLOWED_GITHUB_LOGINS` and `ORCH_ALLOWED_GITHUB_ORGS` are empty, unless `ORCH_ALLOW_ANY_GITHUB_USER=true`. Without an allowlist, anyone with a GitHub account could sign in, see the projects set to "All orch users on this server" and join their pools. A user matches if their login is listed **or** they are an active member of a listed organization. Org membership is checked at login with the user's own GitHub token, and again for open sessions every `ORCH_ALLOWLIST_CACHE_SEC` seconds (default 300). Removing someone from the list or the org therefore takes effect within minutes (logins are re-checked on every request). Org checks need the GitHub App organization permission **Members: Read-only** (see below) and the App installed on, or approved by, the organization. In development and tests an empty allowlist only logs a warning.

Other server knobs (dispatcher interval, offer TTLs, budget factors) have defaults and are listed in [`apps/server/src/config/index.ts`](apps/server/src/config/index.ts). To change one, add it to the `server` service `environment` in `compose.yaml`.

**4. Put the GitHub App private key in place** (see the next section for how to get it):

```sh
mkdir -p secrets
mv ~/Downloads/<app-name>.<date>.private-key.pem secrets/github-app.pem
sudo chown 1000:1000 secrets/github-app.pem && chmod 400 secrets/github-app.pem
```

The file must exist before the first start (otherwise Docker creates a directory in its place). The server runs as uid 1000, so the file has to be readable by that user.

**5. Start.**

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

### Behind Cloudflare Tunnel

If you host behind a Cloudflare Tunnel, Cloudflare terminates TLS for your domain and `cloudflared` forwards plain HTTP to a local port. There is no ACME and ports 80 and 443 are not used. Set these in `.env`:

```sh
ORCH_DOMAIN=orch.selfhostr.io
ORCH_TLS_MODE=tunnel                      # default is acme
HTTP_PORT=8495                            # local port cloudflared connects to
ORCH_BIND_ADDR=127.0.0.1                  # keep the port off the LAN
HTTPS_PUBLISH=127.0.0.1:              # nothing serves 443; maps it to a random loopback port
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
- Do not put Cloudflare Access in front of `/api/github/webhook`, `/agent/ws`, `/mcp` or `/install.sh`: they authenticate themselves (HMAC, agent credential, personal token, public script) and Access would block GitHub and the agents.
- "Always Use HTTPS" is fine.
- Update the GitHub App URLs as in the next section; they use your public `https` domain.

### Upgrading

```sh
git pull
docker compose pull && docker compose up -d     # or: docker compose up -d --build
```

Members upgrade their agent with `docker compose -f ~/orch/compose.yaml pull && docker compose -f ~/orch/compose.yaml up -d`.

### Backups and restore

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

## Creating the GitHub App

orch signs users in with GitHub and acts on repositories through one GitHub App that you own. Create it at **GitHub -> Settings -> Developer settings -> GitHub Apps -> New GitHub App** (or under your organization's settings). Replace `<domain>` with your `ORCH_DOMAIN`.

| Field                                                  | Value                                        |
| ------------------------------------------------------ | -------------------------------------------- |
| GitHub App name                                        | Anything unique, for example `orch-yourteam` |
| Homepage URL                                           | `https://<domain>`                           |
| Callback URL                                           | `https://<domain>/api/auth/github/callback`  |
| Request user authorization (OAuth) during installation | Enabled                                      |
| Expire user authorization tokens                       | Leave the default                            |
| Webhook -> Active                                      | Enabled                                      |
| Webhook URL                                            | `https://<domain>/api/github/webhook`        |
| Webhook secret                                         | The value of `GITHUB_WEBHOOK_SECRET`         |
| Where can this App be installed?                       | "Only on this account" is enough for a team  |

**Repository permissions**

| Permission    | Access                                        |
| ------------- | --------------------------------------------- |
| Contents      | Read & write                                  |
| Pull requests | Read & write                                  |
| Issues        | Read & write                                  |
| Metadata      | Read-only (mandatory, selected automatically) |

**Organization permissions:** set **Members: Read-only** only if you use `ORCH_ALLOWED_GITHUB_ORGS`. orch then calls `GET /user/memberships/orgs/{org}` with the signed-in user's own token. Without the permission, org checks answer "not a member" and everybody is refused. A login-only allowlist (`ORCH_ALLOWED_GITHUB_LOGINS`) needs nothing extra.

**Subscribe to events:** Issues, Pull request, plus the Installation and Installation repositories events that GitHub delivers to every App (`issues`, `pull_request`, `installation`, `installation_repositories`).

After creating the App:

1. Copy the **App ID** to `GITHUB_APP_ID`, and the **slug** from the App's public URL (`github.com/apps/<slug>`) to `GITHUB_APP_SLUG`.
2. Under **Client secrets**, generate one. Put the **Client ID** in `GITHUB_CLIENT_ID` and the secret in `GITHUB_CLIENT_SECRET`.
3. Under **Private keys**, generate one and save the `.pem` as `deploy/server/secrets/github-app.pem` (see the installation steps). It is read-only inside the server container. Never commit it; `*.pem` is git-ignored.
4. Restart: `docker compose up -d`.

Because a `Contents: write` installation token can push to any branch, **enable branch protection on your default branches**: orch only pushes `orch/issue-<n>-*` branches and opens PRs, but protection keeps that guarantee even if something goes wrong.

## Adding a member

1. **Sign in.** The member opens `https://<domain>` and signs in with GitHub.
2. **Install the App on the repos** they want to use (the Projects page links to the install page). Repository owners then register a repo as a project from **Projects**.
3. **Join projects.** On **Discover**, the member joins a project and picks their participation settings: `AUTO` (tasks start automatically while they have budget) or `APPROVAL` (they get a request they accept or reject), and which models they allow (Sonnet, Opus). Their Claude plan is declared on the agent side (`ORCH_PLAN`). Private projects require the owner's approval by default.
4. **Install the agent.** On **My Server**, click to generate an install command. It is valid for 15 minutes, once:

   ```sh
   curl -fsSL https://<domain>/install.sh | ORCH_TOKEN=<one-time-token> sh
   ```

   The token travels in an environment variable, not in a command-line argument, so it does not show up in the process list. The old `sh -s -- --token <token>` form still works but is deprecated.

   This needs only Docker Engine 26+ with Compose, `curl` and `sh`. It writes `~/orch/compose.yaml` and `~/orch/.env`, enrolls the machine, starts the agent and installs an `orch` shortcut in `~/.local/bin/orch` (it tells you how to add that directory to your `PATH` if needed). Re-run it any time: it is idempotent and does not re-enroll (use `--force` for that). `--uninstall [--purge]` removes the stack and the shortcut.

5. **Link Claude.** At the end, in a terminal, the installer asks `Connect your Claude account now? [Y/n]`. Answer yes, open the URL it shows, sign in and paste the code back. `orch login` captures the long-lived token by itself; it is stored in the agent's `orch-secrets` volume on that machine (mode 0600) and never sent to the server. To do it later (or when installing without a terminal, or with `--yes`), run:

   ```sh
   orch login
   ```

   The `orch` shortcut is `docker compose -f ~/orch/compose.yaml exec agent orch "$@"` (with a terminal attached when you have one), so every command below works as written.

Agent settings (in `~/orch/.env`): `ORCH_SERVER_URL`, `ORCH_AGENT_ID`, `ORCH_AGENT_CREDENTIAL`, `ORCH_WORK_DIR`, `ORCH_CLAUDE_DIR`, `ORCH_PLAN` (`pro`, `max5` or `max20`), plus optional `ORCH_AGENT_IMAGE` and `ORCH_AGENT_TAG`. Further agent options such as `ORCH_MAX_CONCURRENT` (default 1) are defined in [`apps/agent/src/config.ts`](apps/agent/src/config.ts).

## Day-to-day usage

**Web.** Issues carrying the project's pool label (default `pool`) become tasks. **Backlog** shows tasks by status. **Pool** shows teammates' availability (estimates). **Requests** lists approval requests addressed to you. New tasks can also be created from the Backlog page or through [MCP](#mcp-setup).

**CLI** (the `orch` shortcut installed on your machine runs these inside the agent container):

| Command                  | What it does                                                     |
| ------------------------ | ---------------------------------------------------------------- |
| `orch status`            | Agent connection, pause state, your tasks                        |
| `orch list [owner/repo]` | Tasks you can take now                                           |
| `orch take <n>`          | Claim issue `<n>` (or `owner/repo#<n>`) and prepare its sandbox  |
| `orch attach <n>`        | Attach to the Claude session of issue `<n>` (detach: `Ctrl-a d`) |
| `orch shell <n>`         | Shell inside the task container                                  |
| `orch done <n>`          | Commit, push the branch; the server opens the PR; sandbox stops  |
| `orch logs <n>`          | Follow the log of an auto run (`--no-follow`, `--lines=<k>`)     |
| `orch requests`          | Approval requests waiting for you                                |
| `orch accept <id>`       | Accept a request: the task runs on your machine                  |
| `orch reject <id>`       | Decline a request                                                |
| `orch pause` / `resume`  | Stop or restart receiving work (applied locally first)           |
| `orch login`             | Store your Claude token                                          |

**Manual mode** (`orch take`): orch builds the dev container, starts an interactive Claude session in a `screen` named `issue-<n>` inside the agent container, and you attach with `orch attach <n>` (detach with `Ctrl-a d`). When you are happy, `orch done <n>` pushes and the PR is opened ready for review.

**Auto vs approval.** In `AUTO` participation, the server offers a task to a member with enough estimated budget, and the agent runs it headlessly; the PR is opened as a **draft**. In `APPROVAL` participation you get a request (web or `orch requests`) and nothing starts until you accept. Your agent can always refuse locally (`orch pause`). Limits: 1 concurrent task per machine, 20 pending tasks per creator, timeouts of 30, 90 and 180 minutes for sizes S, M and L.

Branches are named `orch/issue-<n>-*`. The project owner merges the PRs.

## MCP setup

orch exposes an MCP server so Claude Code can see the pool and submit work (the server needs no LLM key: your own Claude Code does the planning).

1. In the web UI, open the **Claude Code** page and create a token. It is shown once, hashed in the database, and revocable.
2. Add the server to Claude Code, replacing the placeholders:

   ```sh
   claude mcp add --transport http --scope user orch https://<domain>/mcp \
     --header "Authorization: Bearer <token>"
   ```

Tools: `view_pool`, `list_tasks`, `submit_task` (atomic batch with dependencies; supports dry runs), `take_task`, `task_status`.

Example prompts:

- "Use orch to show who in the pool has capacity right now."
- "Read this repo, split the work to add CSV export into small tasks with acceptance criteria, and submit them to `acme/webapp` through orch. Dry run first."
- "List my open orch tasks for `acme/webapp` and tell me which ones are blocked."
- "What is the status of issue 42 in `acme/webapp`?"

## Local development

Everything goes through Docker; the host needs only `docker` with Compose and `sh`. `./dev` is a thin wrapper around `docker compose -f compose.dev.yaml`.

```sh
./dev install      # pnpm install inside the tools container
./dev up           # web + API: http://localhost:8470 (Caddy), http://localhost:8471 (API direct)
./dev down
./dev lint
./dev typecheck
./dev test
./dev test:install # shellcheck + bats for install.sh
./dev build
./dev prisma <args>
./dev logs [service]
```

The first run copies `.env.example` to `.env`. Ports come from `ORCH_DEV_WEB_PORT` (8470) and `ORCH_DEV_API_PORT` (8471). GitHub sign-in needs a development GitHub App; the dev `.env` variables are the same `GITHUB_*` and `ORCH_ENCRYPTION_KEY` as in production, with callback `http://localhost:8470/api/auth/github/callback`.

A dev member agent is available with `docker compose -f compose.dev.yaml --profile agent up -d --build agent` after setting `ORCH_DEV_ENROLL_TOKEN` in `.env`.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, installer tests, production image builds and gitleaks. Pushing a `v*` tag runs `release.yml`, which publishes `orch-server`, `orch-web` and `orch-agent` to `ghcr.io/theroxat`.

## Security model

orch is for **small teams who trust each other**. It is a shared to-do list with automation, not a multi-tenant platform. Read this before you adopt it.

- **Trusted teams only.** Anyone who can get an issue labeled for the pool can, in effect, write a prompt that runs on a teammate's machine. Do not use orch with strangers or with public repos where outsiders can file labeled issues.
- **What the sandbox does.** Each task runs in its own container, non-root, with only that task's clone mounted. No docker socket, no host home directory. Each task gets an isolated clone, not your working copy. Git metadata (the bare mirror and the clone's `.git` bookkeeping) is kept outside the task container, so a task cannot rewrite hooks or config that the agent's own git would later run.
- **The repo's compose file is validated.** When a task uses the repository's own `compose.yaml` for its dev environment, the agent checks it before starting anything and refuses `privileged`, host bind mounts, the Docker socket, host networking and `cap_add`. This validation is being completed on the agent side; until it ships, treat a repo's compose file as trusted code. It is not a defence against a hostile teammate.
- **What the sandbox does not do.** In auto mode the agent runs `claude -p --permission-mode bypassPermissions` inside the task container. That container has **network access** and receives **the member's Claude token**. A malicious or compromised issue can therefore make Claude exfiltrate that token, call external services, or push harmful code to the task branch. There is no egress filtering in v1. The token is the member's own and can be revoked from their Claude account.
- **The agent is root-equivalent on the member's host.** The agent container mounts `/var/run/docker.sock` to start task containers. Anyone controlling the agent controls that Docker daemon. Rootless Docker is a supported way to reduce this.
- **Claude credentials never leave the member's machine.** The token lives in the agent's local volume and in that member's task containers. The server stores no Claude credentials. The agent mounts `~/.claude` read-only, only to estimate usage.
- **Usage figures are estimates.** Anthropic does not publish exact subscription limits. Budgets, margins and reset times come from local logs plus a safety reserve and may be wrong. Treat them as hints.
- **Review PRs.** Auto-mode PRs are drafts. Enable branch protection and require human review before merging. The GitHub App's `Contents: write` can push to any branch.
- **Who can sign in.** Production requires an allowlist of GitHub logins and/or organizations (see Server installation). A task board is visible only to the project owner, active participants and GitHub collaborators; owner rights are re-checked against the GitHub ADMIN role (cached a few minutes), so a former admin loses them.
- **Server side.** Only Caddy is published. Postgres and the server are internal. GitHub user tokens are encrypted with `ORCH_ENCRYPTION_KEY`. Agent credentials and personal MCP tokens are stored hashed. Webhooks are verified with HMAC and deduplicated by delivery id and by body hash. Caddy sends HSTS and a strict Content-Security-Policy, and the server never logs query strings (they carry the OAuth code). Every state change is written to an append-only audit log.

Report vulnerabilities privately through GitHub security advisories on this repository.

## Limitations

- Single server instance (in-process scheduler); no high availability. One host, nightly dumps.
- No egress control, devcontainer/compose sanitizing or token-injecting proxy for task containers (see [future hardening](docs/PLAN.md#11-future-hardening-if-pools-ever-open-to-untrusted-members)).
- Usage and budget are estimates; plans are declared by the member.
- Repos must build from a `Dockerfile` or a simple `.devcontainer.json`; complex devcontainer features are not honored.
- Manual-mode `screen` sessions end if the agent container restarts; the task container survives and `orch attach <n>` reopens a session.
- One concurrent task per machine by default.
- GitHub only. English UI only.
- The production images run TypeScript through `tsx` rather than a compiled build; the server image is therefore large (~900 MB).

## License

MIT. See [LICENSE](LICENSE).
