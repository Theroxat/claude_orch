# orch: Implementation Plan

Status: **Approved, 2026-10-21.**

orch spreads Claude Code development tasks across a small team. Each member runs tasks on their own
machine with their own Claude subscription. The central server sees only usage figures and task
statuses, never Claude credentials.

Ground rules this plan follows:

- **Everything in English**: code, comments, docs, README, web UI, MCP tool names.
- **Everything runs in Docker**: server, web, DB, proxy, agent, task execution, the `orch` CLI, and
  every dev/test workflow (install, build, lint, test). The only things a host needs are `docker`
  (Engine 26+) with the Compose plugin, plus `curl` and `sh` to run the installer. No host Node or pnpm.
- **Public repo**: no secrets in any file. Only `*.env.example` with placeholders. CI runs a
  secret scanner (gitleaks) on every push.

---

## 0. Threat model: trusted team

orch is for small **trusted teams who know each other** (hackathons, side projects). Teammates are never
strangers. Each member runs tasks on their own machine with their own Claude subscription, on projects they
chose to join. Think of it as a shared to-do list with automation. Priorities: simplicity, fast setup, speed.

The task sandbox protects the member's machine from accidents and from a bad prompt, not from a hostile
teammate. **Kept:** each task runs in its own container; only the task's clone is mounted; no docker socket;
no host home; non-root; isolated clone per task. **Dropped for v1:** egress allowlist proxy, devcontainer/compose
sanitizing, token-injecting proxy, snapshot export (listed in section 11).

**Who can sign in.** "Trusted" must be enforced: production requires `ORCH_ALLOWED_GITHUB_LOGINS` and/or
`ORCH_ALLOWED_GITHUB_ORGS` (the server refuses to start otherwise, unless `ORCH_ALLOW_ANY_GITHUB_USER=true`). The
visibility value `ALL_MEMBERS` means "all orch users on this server", i.e. everyone the allowlist lets in. A task
board is visible only to the owner, active participants and GitHub collaborators; owner rights follow the GitHub
ADMIN role. Enrollment tokens are passed to `install.sh` as `ORCH_TOKEN=<token>`, never as an argument.
The repo's compose file is validated by the agent (privileged, host binds, docker.sock, host network, `cap_add`
rejected), and git metadata stays outside the task container.

---

## 1. Stack decision

The proposed stack is kept. Changes and additions, with the reason for each:

| Area            | Decision                                                                                                                                  | Change?            | Reason                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| Monorepo        | pnpm workspaces, TypeScript strict, Node 22 LTS                                                                                           | kept               |                                                                                                  |
| Server          | Fastify 5 + `@fastify/websocket` (ws)                                                                                                     | kept               |                                                                                                  |
| DB              | Postgres 16 + Prisma                                                                                                                      | kept               | Raw SQL migrations only for partial unique indexes and the audit-log trigger.                    |
| Validation      | **zod** schemas in `packages/shared`, used by server, agent and MCP                                                                       | added              | One source of truth for the WSS protocol and MCP tool inputs. Both sides validate every message. |
| Job scheduling  | **No Redis.** An in-process scheduler loop. Postgres row locks (`FOR UPDATE SKIP LOCKED`) plus one advisory lock for the assignment pass. | added              | v1 runs a single server instance. One less service to run.                                       |
| Web             | React 18 + Vite + TanStack Query + React Router, **English UI**                                                                           | changed (language) | User override.                                                                                   |
| Web serving     | Caddy serves the built SPA as static files. API is under `/api`.                                                                          | clarified          | No Node process needed for the web in production.                                                |
| Reverse proxy   | Caddy 2 (automatic HTTPS)                                                                                                                 | kept               |                                                                                                  |
| GitHub          | Octokit (`@octokit/app`, `@octokit/webhooks`)                                                                                             | added              | Handles installation token minting, webhook signature verification and OAuth.                    |
| MCP             | `@modelcontextprotocol/sdk`, Streamable HTTP transport at `/mcp`                                                                          | added              | Works with `claude mcp add --transport http`.                                                    |
| Agent           | Node 22 in a container. Drives Docker through the socket with **dockerode**. Local state in **SQLite** (`better-sqlite3`) on a volume.    | kept + SQLite      | The agent needs a durable outbox and task records that survive restarts and disconnections.      |
| Task containers | Built from the repo's `Dockerfile` or the `image`/`build` of `.devcontainer.json`, started by `sandbox.ts` with fixed guarantees          | simplified         | Trusted team: no config sanitizing, no egress proxy (see section 0 and 11).                      |
| Repo checkout   | **Isolated per-task clone** from a local bare mirror, not `git worktree`                                                                  | **changed**        | A worktree's `.git` file points into the main repo, which we must not mount. See 5.1.            |
| Tests           | Vitest (unit/integration), Playwright (web e2e), bats + shellcheck (install.sh), Docker-in-Docker for agent e2e                           | added              | All run in containers.                                                                           |
| Dev tooling     | A `tools` service (node:22 + corepack pnpm) and a `./dev` wrapper script that only calls `docker compose`                                 | added              | Docker-only requirement.                                                                         |

---

## 2. Repository tree

```
claude_orch/
├── README.md                      # install server, create GitHub App, add member, MCP setup
├── LICENSE                        # MIT
├── install.sh                     # member installer, served by the server at /install.sh
├── dev                            # tiny POSIX sh wrapper: ./dev test|lint|up|e2e → docker compose …
├── compose.dev.yaml               # full stack on one machine (see §8.6)
├── compose.test.yaml              # CI/test overlay (ephemeral DB, DinD, fake claude)
├── .env.example                   # dev placeholders only
├── .gitleaks.toml
├── .github/workflows/ci.yaml      # builds tools image, runs ./dev lint, test, e2e, gitleaks
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.config.js  .prettierrc
├── docker/
│   ├── tools.Dockerfile           # node:22 + pnpm + shellcheck + bats + gitleaks
│   └── fake-claude/               # test double for the `claude` binary (emits stream-json, edits files)
├── deploy/
│   ├── server/compose.yaml        # production: caddy, server, postgres (+ backup job)
│   ├── server/Caddyfile
│   ├── server/.env.example        # ORCH_DOMAIN=orch.selfhostr.io (example value), secrets placeholders
│   ├── agent/compose.yaml         # template written to ~/orch/compose.yaml by install.sh
│   ├── agent/.env.example
│   └── github-app-manifest.json   # one-click GitHub App creation (manifest flow)
├── docs/
│   ├── PLAN.md
│   ├── architecture.md  protocol.md  security.md  github-app.md  mcp.md
├── packages/
│   └── shared/
│       └── src/
│           ├── protocol/          # zod: envelope, agent↔server messages, versions
│           ├── mcp/               # zod: MCP tool inputs/outputs
│           ├── domain/            # enums (TaskStatus, Size, Model, Mode), role mapping, budget math
│           └── index.ts
└── apps/
    ├── server/
    │   ├── Dockerfile
    │   ├── prisma/schema.prisma  prisma/migrations/
    │   └── src/
    │       ├── main.ts  config.ts           # env parsing (zod), fails fast on missing secrets
    │       ├── auth/                        # GitHub OAuth, sessions, CSRF, personal tokens
    │       ├── github/                      # app client, token minting, webhooks, issue sync, PRs
    │       ├── projects/  participation/  pool/  tasks/
    │       ├── scheduler/                   # assignment pass, offers, consent expiry, leases
    │       ├── agents/                      # enrollment, WSS gateway, session registry
    │       ├── usage/                       # usage ingestion, window/budget computation
    │       ├── mcp/                         # MCP server + tools
    │       ├── audit/                       # append-only audit writer
    │       └── routes/                      # /api/*, /agent/*, /webhooks/github, /mcp, /install.sh
    │   └── test/ (unit/, integration/, fixtures/github/)
    ├── web/
    │   ├── Dockerfile                       # build stage → static files copied into the caddy image
    │   └── src/
    │       ├── pages/ MyProjects, Discover, Pool, Backlog (kanban), MyServer, Settings (MCP tokens)
    │       ├── components/  api/  hooks/
    │   └── e2e/ (Playwright)
    └── agent/
        ├── Dockerfile                       # node:22-slim + git + docker CLI + screen + claude (native)
        └── src/
            ├── main.ts                      # daemon: ws client, scheduler, local API (unix socket)
            ├── enroll.ts  credentials.ts    # token exchange, /data/agent-credential (0600)
            ├── ws/                          # connection, backoff, outbox replay, dedupe
            ├── usage/                       # jsonl scanner (ccusage-style), stream-json accounting
            ├── exec/                        # mirror, clone, sandbox spec builder, build, run, push
            │   ├── sandbox.ts               # the ONLY place container specs are built
            │   └── screen.ts                # manual-mode sessions
            ├── policy/                      # local guard: pause, budgets, concurrency, consent
            └── cli/                         # `orch` CLI (talks to the daemon over a unix socket)
        └── test/ (unit/, sandbox-conformance/, e2e/)
```

---

## 3. Database schema (Prisma-style)

Conventions: `id String @id @default(cuid())`, `createdAt`/`updatedAt` on every model. Secrets are stored
only as **SHA-256 hashes of high-entropy random tokens** (32 bytes, base64url). GitHub user tokens are
**encrypted** with AES-256-GCM using a key from env (`ORCH_ENCRYPTION_KEY`).

```text
model User {
  id                String   @id
  githubId          BigInt   @unique
  login             String   @unique
  name              String?
  avatarUrl         String?
  ghAccessTokenEnc  Bytes?               // user-to-server token (encrypted), used for permission sync
  ghRefreshTokenEnc Bytes?
  ghTokenExpiresAt  DateTime?
  paused            Boolean  @default(false)   // web "pause" button; also mirrored by agent
  maxConcurrent     Int      @default(1)
  maxPendingTasks   Int      @default(20)      // pending tasks this user may have created
  lastLoginAt       DateTime?
  sessions Session[]  tokens PersonalToken[]  agents Agent[]  participations Participation[]
}

model Session       { id String @id /* sha256 of cookie value */; userId String; expiresAt DateTime; userAgent String?
                      @@index([userId]) }
model PersonalToken { id String @id; userId String; name String; prefix String; tokenHash String @unique
                      scopes String[] /* ["mcp"] */; lastUsedAt DateTime?; revokedAt DateTime?
                      @@index([userId]) }

model Installation {
  id String @id; githubInstallationId BigInt @unique; accountLogin String; accountType String
  suspendedAt DateTime?; projects Project[]
}

model Project {
  id String @id; githubRepoId BigInt @unique; fullName String @unique  // "owner/repo"
  installationId String; defaultBranch String; isPrivate Boolean
  visibility         Visibility    @default(COLLABORATORS) // who sees it in Discover: ALL_MEMBERS | COLLABORATORS | ALLOWLIST
  participationPolicy Policy       @default(GITHUB)        // GITHUB (≥ read) | ALLOWLIST | ALL_MEMBERS
  submissionPolicy    Policy       @default(GITHUB)        // GITHUB (≥ write) | ALLOWLIST
  poolLabel   String   @default("pool")
  requireParticipantApproval Boolean @default(true) // owners approve participants (project setting, on by default)
  sizeBudgets Json?    // optional override of token estimates per size {S,M,L}
  addedById String; archivedAt DateTime?
  @@index([installationId])
}

model ProjectPermission {                // cache of GitHub role + owner overrides
  id String @id; projectId String; userId String
  githubRole  GithubRole   // ADMIN | MAINTAIN | WRITE | TRIAGE | READ | NONE
  canSubmit   Boolean?     // null = derive from githubRole; set only by project owner
  canParticipate Boolean?
  syncedAt DateTime
  @@unique([projectId, userId]) @@index([userId])
}

model Participation {
  id String @id; userId String; projectId String
  active    Boolean @default(false)
  approvedAt DateTime?                // set by an owner when the project requires approval; null = pending
  percent   Int                       // 0..100; app enforces sum(active) ≤ 100 per user
  mode      ParticipationMode         // AUTO | APPROVAL
  allowedModels Model[] @default([SONNET, OPUS])
  @@unique([userId, projectId]) @@index([projectId, active])
}

model Agent {                           // one per member machine
  id String @id; userId String; name String; hostname String?; os String?; arch String?
  agentVersion String?; secretHash String; secretPrefix String   // first 6 chars, for display
  lastSeenAt DateTime?; lastUsageAt DateTime?; localPaused Boolean @default(false)
  revokedAt DateTime?
  @@index([userId])
}

model EnrollmentToken {                 // one-time, 15 min
  id String @id; userId String; tokenHash String @unique
  expiresAt DateTime; usedAt DateTime?; usedByAgentId String?; createdIp String?
  @@index([userId, expiresAt])
}

model UsageReport {
  id String @id; agentId String; userId String; reportedAt DateTime
  windowStart DateTime; windowResetAt DateTime
  inputTokens BigInt; outputTokens BigInt; cacheWriteTokens BigInt; cacheReadTokens BigInt
  weightedTokens BigInt                 // model-weighted units, see §6
  byProject Json                        // { projectId | "personal": weightedTokens }
  byModel   Json
  capacityEstimate BigInt?              // estimated window capacity (weighted)
  rateLimitedUntil DateTime?            // hard signal from claude output
  source String                         // "jsonl" | "stream" | "mixed"
  @@index([agentId, reportedAt(sort: Desc)]) @@index([userId, reportedAt(sort: Desc)])
}                                        // retention: 30 days (scheduled purge)

model TaskBatch {                       // one submit_task call (split of a big task)
  id String @id; projectId String; createdById String; integrationBranch String?; title String?
}

model Task {
  id String @id; projectId String; batchId String?
  githubIssueNumber Int; githubIssueId BigInt
  title String; bodySnapshot String; bodyHash String     // prompt = snapshot, never the live issue
  acceptanceCriteria String[]
  size TaskSize; model Model                              // S|M|L ; SONNET|OPUS
  baseBranch String; integrationBranch String?            // PR base = integrationBranch ?? defaultBranch
  branchName String?                                      // orch/issue-<n>-<slug>
  status TaskStatus                                       // see state machine below
  origin TaskOrigin                                       // PLATFORM | LABEL_IMPORT | MCP
  dispatch DispatchMode                                   // POOL | TARGETED | BROADCAST
  priority Int @default(0)
  createdById String
  prNumber Int?; prUrl String?; headSha String?
  @@unique([projectId, githubIssueNumber])
  @@index([projectId, status]) @@index([createdById, status]) @@index([status, priority])
}

model TaskDependency { taskId String; dependsOnId String
                       @@id([taskId, dependsOnId]) @@index([dependsOnId]) }   // acyclic, checked on insert
model TaskTarget     { taskId String; userId String; @@id([taskId, userId]) }  // for TARGETED

model Assignment {                       // one offer / consent request / claim, and its execution
  id String @id; taskId String; userId String; agentId String?
  kind   AssignmentKind                  // AUTO_OFFER | CONSENT_REQUEST | CLAIM (orch take / take_task)
  status AssignmentStatus                // PENDING | ACCEPTED | REJECTED | EXPIRED | CANCELLED
                                         // | RUNNING | PUSHED | SUCCEEDED | FAILED | LOST
  execMode ExecMode?                     // AUTO (claude -p) | MANUAL (screen)
  reason String?                         // reject/fail reason (machine code + text)
  offeredAt DateTime; expiresAt DateTime?; respondedAt DateTime?
  startedAt DateTime?; finishedAt DateTime?; leaseExpiresAt DateTime?
  lastSeq Int @default(0)                // monotonic status sequence from agent (idempotency)
  usageWeighted BigInt?                  // tokens consumed by this attempt
  @@index([taskId, status]) @@index([userId, status]) @@index([agentId, status])
}
// raw SQL: CREATE UNIQUE INDEX one_live_assignment ON "Assignment"("taskId")
//          WHERE status IN ('ACCEPTED','RUNNING','PUSHED');

model AuditLog {                         // append-only (DB trigger rejects UPDATE/DELETE)
  id BigInt @id @default(autoincrement()); at DateTime @default(now())
  actorType ActorType                    // USER | AGENT | SYSTEM | GITHUB
  actorUserId String?; actorAgentId String?
  action String                          // e.g. task.submitted, task.offered, consent.granted,
                                         // task.started, task.finished, agent.enrolled, agent.revoked,
                                         // participation.updated, permission.override, token.minted
  projectId String?; taskId String?; targetUserId String?; agentId String?
  ip String?; data Json                  // never contains secrets (writer redacts by schema)
  @@index([projectId, at]) @@index([taskId]) @@index([actorUserId, at]) @@index([agentId, at])
}

model WebhookDelivery { deliveryId String @id; event String; receivedAt DateTime; processedAt DateTime? }
model AgentMessageSeen { agentId String; messageId String; seenAt DateTime
                         @@id([agentId, messageId]) }   // dedupe window, purged after 24 h
```

**Task status state machine:** `PROPOSED` (from a READ user, waits for a writer to approve) → `BLOCKED`
(deps not done) ↔ `READY` → `OFFERED` (live offer or consent requests) → `ASSIGNED` → `RUNNING` →
`IN_REVIEW` (PR open) → `DONE` (merged). Side exits: `FAILED` (returns to `READY` on retry),
`CANCELLED` (issue closed or creator cancels). Kanban columns: **To do** = PROPOSED/BLOCKED/READY/OFFERED,
**In progress** = ASSIGNED/RUNNING, **In review** = IN_REVIEW, **Done** = DONE.

---

## 4. Server ↔ agent protocol

### 4.1 Enrollment

1. On **My server**, the user clicks "Generate install command". The server creates an `EnrollmentToken`
   (32 random bytes, stores the SHA-256 hash, valid for 15 min) and shows the token **once**:
   `curl -fsSL https://<domain>/install.sh | ORCH_TOKEN=<token> sh`.
2. `install.sh` writes `~/orch/.env` (`ORCH_SERVER_URL`, `ORCH_ENROLL_TOKEN`) and starts the stack.
3. On first boot, the agent calls `POST /agent/enroll` over HTTPS:
   `{ "token": "...", "machine": { "hostname": "...", "os": "linux", "arch": "x64", "agentVersion": "0.1.0", "dockerVersion": "27.1" } }`.
4. In one transaction the server runs `UPDATE … SET usedAt=now() WHERE tokenHash=$1 AND usedAt IS NULL AND expiresAt>now()`.
   If no row is updated, it returns 401. Otherwise it creates the `Agent` with a fresh 32-byte secret, stores only its hash,
   writes an audit entry and returns `{ "agentId": "agt_…", "credential": "orch_agent_<agentId>.<secret>" }`.
5. The agent writes the credential to `/data/agent-credential` (mode 0600, named volume) and **blanks
   `ORCH_ENROLL_TOKEN` in its runtime config**. A replayed or expired token is useless.
6. Revocation: **My server → Revoke** sets `revokedAt`, closes the live socket with code `4003`, and every
   later auth fails. To re-enroll, the user generates a new install command.

### 4.2 Transport and auth

- `wss://<domain>/agent/ws` through Caddy (TLS). The credential goes in `Authorization: Bearer …`, never in
  the URL, so it does not land in logs. The server looks up the agent by id and compares the hash in constant time.
- One live socket per agent. A new connection replaces the old one (old closed with `4001 superseded`).
- The protocol version is in the envelope. On a major mismatch the server closes with `4010` and a message
  telling the user to run `docker compose pull`.

### 4.3 Envelope

```json
{
  "v": 1,
  "id": "01J…(ulid)",
  "type": "task.status",
  "ts": "2026-10-21T10:00:00Z",
  "replyTo": "01J…optional",
  "payload": {}
}
```

Every message that changes state needs an `ack {replyTo}`. Senders retry unacked messages with the
**same id**. Receivers dedupe on `(agentId, id)`.

### 4.4 Message types

Agent → server:

| type                   | payload                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`                | `{ agentVersion, capabilities: ["auto","manual","devcontainer"], localPaused, maxConcurrent, running: [{ assignmentId, taskId, state, lastSeq }] }`                                                                    |
| `heartbeat` (30 s)     | `{ running: number, localPaused, load: { cpu, memFreeMb, diskFreeMb } }`                                                                                                                                               |
| `usage.report` (5 min) | `{ windowStart, windowResetAt, tokens: { input, output, cacheWrite, cacheRead }, weighted, byModel: {sonnet, opus}, byProject: { "<projectId>": n, "personal": n }, capacityEstimate, rateLimitedUntil?: ts, source }` |
| `offer.accept`         | `{ assignmentId, execMode }`                                                                                                                                                                                           |
| `offer.reject`         | `{ assignmentId, reason: "paused"\|"budget"\|"concurrency"\|"model_not_allowed"\|"not_participating"\|"user_declined"\|"error", detail? }`                                                                             |
| `task.claim`           | `{ projectFullName, issueNumber }`: from `orch take`                                                                                                                                                                   |
| `task.status`          | `{ assignmentId, seq, state: "preparing"\|"building"\|"running"\|"pushing"\|"finished", detail?, progress? }`                                                                                                          |
| `task.pushed`          | `{ assignmentId, seq, branch, headSha, changedFiles, summary }`                                                                                                                                                        |
| `task.finished`        | `{ assignmentId, seq, outcome: "succeeded"\|"failed"\|"cancelled"\|"no_changes", usage: { weighted, input, output }, error? }`                                                                                         |
| `token.request`        | `{ requestId, assignmentId, purpose: "clone"\|"push" }`                                                                                                                                                                |
| `done.request`         | `{ assignmentId }`: from `orch done <n>` (manual mode: export, push, PR)                                                                                                                                               |
| `pause.set`            | `{ paused: boolean }`: from `orch pause/resume`, applied locally first                                                                                                                                                 |

Server → agent:

| type            | payload                                                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `welcome`       | `{ agentId, serverTime, heartbeatSec: 30, usageSec: 300, paused, participations: [{ projectId, fullName, percent, mode, allowedModels }] }`                                                                                                                    |
| `config.update` | same shape as the config part of `welcome` (pause button, participation edits)                                                                                                                                                                                 |
| `task.offer`    | `{ assignmentId, kind: "AUTO_OFFER"\|"CONSENT_REQUEST"\|"CLAIM", expiresAt, task: { taskId, project: { id, fullName, defaultBranch }, issueNumber, title, prompt, bodyHash, acceptanceCriteria, size, model, baseBranch, branchName, createdBy: { login } } }` |
| `task.cancel`   | `{ assignmentId, reason }`                                                                                                                                                                                                                                     |
| `token.grant`   | `{ requestId, token, expiresAt, repository, permissions }` (installation token, see §5.5)                                                                                                                                                                      |
| `token.deny`    | `{ requestId, reason }`                                                                                                                                                                                                                                        |
| `pr.opened`     | `{ assignmentId, prNumber, prUrl }`                                                                                                                                                                                                                            |
| `cleanup`       | `{ assignmentId }`: after merge or cancel. Agent removes the clone and images.                                                                                                                                                                                 |
| `error`         | `{ code, message, replyTo? }`                                                                                                                                                                                                                                  |

### 4.5 Liveness, reconnection, idempotency

- **Heartbeat:** the server marks an agent offline after 90 s without a heartbeat. Running assignments get a
  `leaseExpiresAt = lastHeartbeat + 30 min`. After the lease expires an assignment becomes `LOST`, the
  task goes back to `READY` and the creator is notified. An agent that comes back and still reports the task as
  running gets `task.cancel` if the task was reassigned. Otherwise the lease is renewed.
- **Reconnection:** exponential backoff 1 s → 60 s with full jitter. Tasks keep running while
  disconnected. Status messages go to a **SQLite outbox** and are replayed in order on reconnect.
- **Reconciliation on `hello`:** the server compares `running[]` with its `RUNNING`/`ACCEPTED` assignments for
  this agent, then sends a cancel for unknown or cancelled ones and re-sends unacked offers.
- **Idempotency:** `(agentId, messageId)` dedupe table (24 h). `task.*` updates carry a per-assignment
  monotonic `seq`. The server ignores `seq ≤ lastSeq`. Accepting an offer goes through the partial unique index
  `one_live_assignment`, so the server answers a second accept for the same task with
  `offer.cancel(reason:"taken")`.
- Offers expire (`AUTO_OFFER` 60 s, `CONSENT_REQUEST` 30 min by default). After that the scheduler moves on to the next candidate.

---

## 5. Task execution on the member machine

### 5.1 Checkout: mirror + isolated clone (instead of `git worktree`)

- The agent keeps a bare mirror per repo in `/data/mirrors/<repoId>.git` (agent-only, never mounted
  into a task). It refreshes the mirror with `git fetch` using a short-lived read token.
- Per task: `git clone --no-hardlinks --dissociate --reference <mirror> … ` into
  `$ORCH_WORK_DIR/<assignmentId>/src`, branch `orch/issue-<n>-<slug>` from `baseBranch`. The clone has
  its own `.git` with no path outside itself, so it is safe to mount alone.
- **Export = a normal push of the task branch.** The squashed-snapshot export is dropped. Its only reason was a
  hostile task rewriting `.git/config` or hooks so that the agent's git would run attacker code. With trusted
  members that is no longer the threat, and the snapshot cost real history (one squashed commit). The agent
  commits any leftover changes (`git add -A`) and pushes, keeping Claude's own commits. Cheap hygiene kept: the
  agent runs git with `-c core.hooksPath=/dev/null -c core.fsmonitor=false`. Snapshot export comes back only if
  pools open to untrusted members (section 11).
- `ORCH_WORK_DIR` is a host directory (`~/orch/work`) bind-mounted into the agent **at the same absolute
  path**. The Docker daemon resolves bind paths on the host, so the agent can then mount `…/<id>/src` into the task container.

### 5.2 Dev container build (simple)

Precedence: `.devcontainer/devcontainer.json` → `Dockerfile` at the root → the project's default image (`node:22`).

- **devcontainer.json:** honored keys are `image`, `build.{dockerfile,context,args}`, `containerEnv`,
  `remoteUser`, `postCreateCommand`, `workspaceFolder`. Other keys (`runArgs`, `mounts`, `privileged`, `capAdd`,
  `securityOpt`, `features`, `initializeCommand`, `forwardPorts`) are not supported in v1 and are ignored with a
  warning in the task log. This is a simplicity choice, not a sanitizer: `sandbox.ts` always builds the container spec itself.
- **compose.yaml sidecars** (DB, cache): v1 supports the repo's own `compose.yaml` for the task's dev environment,
  used as-is (teams are trusted, section 0). Only the task's clone is mounted into the dev container. Sanitizing
  compose files is future hardening (section 11).
- The image build uses BuildKit with the clone as the build context and normal network access.

### 5.3 Sandbox guarantees (built only in `exec/sandbox.ts`)

Every task container is created with:

- Mounts: **only** `/workspace` (the task clone, rw), `/opt/orch/bin` (read-only volume holding the pinned
  native `claude` binary, so the repo image doesn't need Node) and a per-task `CLAUDE_CONFIG_DIR`
  (`/orch/claude`, rw, holds the session jsonl for usage accounting). It never mounts the docker socket, `$HOME`,
  `/data`, mirrors or other tasks.
- `User` = a non-root uid (the member's uid, so files in `~/orch/work` stay owned by them). `CapDrop: ALL`,
  `no-new-privileges`, `Privileged: false`, default seccomp/AppArmor, `PidsLimit`, memory/CPU limits by size,
  `/tmp` as tmpfs.
- Network: a per-task Docker bridge network with normal outbound access, no published ports. The env sets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_TELEMETRY=1`.
- Hard timeout by size (S 30 min, M 90 min, L 180 min, configurable). Containers, networks and volumes are labeled
  `orch.assignment=<id>` and garbage-collected on finish and on agent start.
- A small **conformance test suite** (`apps/agent/test/sandbox-conformance`) runs _inside_ a real task container
  and asserts each guarantee (see M3).

### 5.4 Claude credentials

- **Storage:** the member runs `orch login` once. It wraps `claude setup-token`, which
  produces a long-lived OAuth token for the member's own subscription. The agent stores it in the `orch-secrets`
  named volume (`/secrets/claude-token`, 0600), mounted only in the `agent` container. No protocol message has a
  field for it, and a test scans every outbound frame for the token's pattern. It never leaves the machine.
- **Use:** the agent passes the token into the task container as the `CLAUDE_CODE_OAUTH_TOKEN` env var when it
  creates the container (not baked in an image, not written into the clone, not logged). Outbound traffic is not
  filtered, so a malicious prompt could read it: accepted for trusted teams (R4).
- **We never mount** the agent's or the host's `~/.claude` into a task.

### 5.5 GitHub access (App installation tokens)

- The **App private key exists only on the server.** For each git operation the agent sends `token.request`.
  The server checks that a live assignment exists for that agent and repo, then mints an installation token
  limited with `repositories: [<repo>]` and `permissions: { contents: "read" }` (clone/fetch) or
  `{ contents: "write" }` (push). TTL ≤ 1 h. Every grant is audited (`token.minted`).
- The agent passes the token to git through an in-memory credential helper (`GIT_ASKPASS` reading an
  env var for that one child process). It never writes the token to disk or to `.git/config`.
- **The server opens the PR**, not the agent: on `task.pushed` it creates the PR with its own App auth
  (`head = branch`, `base = integrationBranch ?? defaultBranch`, `draft = execMode == AUTO`, body
  `Closes #<n>` plus the acceptance criteria and a provenance block). It then sends `pr.opened`. This way the
  agent never needs `pull_requests:write`.
- Recommendation in the docs: branch protection on the default branch and on integration branches, because an
  installation token with `contents:write` can push to any branch of that repo.

### 5.6 Auto mode vs manual mode

- **Auto:** the agent runs `docker exec <task> /opt/orch/bin/claude -p --model <sonnet|opus>
--output-format stream-json --verbose --permission-mode bypassPermissions --max-turns <by size>`. The
  prompt goes through **stdin**: a fixed orch preamble (rules: stay in /workspace, satisfy the acceptance
  criteria, run the tests, don't commit secrets) followed by the snapshotted issue body inside clear delimiters.
  Running with bypassed permissions is acceptable only because of the sandbox in 5.3. Progress and
  per-task usage come from the stream-json `result` event. Usage-limit errors set `rateLimitedUntil`. On exit:
  push → draft PR → cleanup of the container (the clone is kept until merge).
- **Manual (`orch take <n>`):** the same prepare/build steps, then the agent starts a **`screen` session inside the
  agent container** called `issue-<n>`. Its command is `docker exec -it orch-task-<n> /opt/orch/bin/claude --model <m>
"<prompt>"` (interactive, prompt pre-filled). The member attaches with:
  `orch attach <n>`.
  Detach with `Ctrl-a d`. `orch done <n>` then pushes and opens a ready-for-review PR. Screen lives in the agent
  container, which has the docker CLI, so nothing runs on the host. If the agent container restarts, the screen
  session is lost but the task container survives, and `orch attach <n>` recreates the session. If the member
  wants a shell in the sandbox: `orch shell <n>` (`docker exec -it … bash`).
- **The CLI** runs inside the agent container and talks to the daemon over `/run/orch.sock`. Usage:
  `orch list|take|status|done|pause|resume|attach|login`.
  `install.sh` installs a tiny `orch` shortcut in `~/.local/bin` that forwards to the agent container; nothing else
  is installed on the host.
- **Cleanup:** after the merge webhook, the server sends `cleanup`. The agent then deletes the clone, the task images and the volumes.
  If the agent is offline, cleanup runs at the next `hello`.

### 5.7 Usage measurement on the agent

- Primary source for orch tasks: stream-json `result.usage`, plus the per-task `CLAUDE_CONFIG_DIR` jsonl,
  attributed to the task's project.
- Personal usage (the member's own sessions on the host): **optional, opt-in** read-only mount of the host's
  `~/.claude/projects` into the agent. It's parsed ccusage-style: assistant messages deduped by `message.id + requestId`,
  grouped into 5-hour blocks that start at the first message, with reset = block start + 5 h.
- Model weighting: `weighted = (input + output + cacheWrite + 0.1·cacheRead) × modelFactor` (opus factor
  configurable, default 5). The weights are only estimates, and the UI always labels them as such ("≈").

---

## 6. Assignment algorithm, consent and budget rules

**Capacity:** `C_u` = estimated weighted capacity per 5-hour window for user u. It starts from the plan the member
declares (Pro / Max 5x / Max 20x presets, editable) and is **calibrated downward** every time a real usage limit
is hit (`C_u ← min(C_u, usedAtLimit)`, slowly decaying back up). Safety margin `s = 20 %` (configurable). Budget percentages are measured over the **5-hour window** only. A weekly estimate is shown in the UI for information and never used for scheduling.

**Project budget for user u on project p in the current window:**
`B(u,p) = percent(u,p)/100 × C_u × (1 − s)`. `used(u,p)` = weighted usage attributed to p in this window.
`margin(u,p) = B(u,p) − used(u,p) − reserved(u,p)`, where `reserved` is the estimate of their accepted/running tasks.
Global check: `C_u·(1−s) − totalUsed(u) > 0` (personal use counts as well).

**Task estimate:** `E(task) = sizeBudget[size] × modelFactor`. Defaults are S/M/L = 0.1/0.25/0.5 of a Pro window,
then the median of past attempts per (project, size) once ≥ 5 samples exist.

**Eligible candidates for a READY task:**

1. All dependencies are `DONE` (otherwise the task stays `BLOCKED`. The scheduler re-checks it on every merge webhook).
2. The user has an active participation in p and is allowed to participate (policy and override; approved by an owner when `requireParticipantApproval` is set), and if the
   task is `TARGETED`, the user is in `TaskTarget`.
3. The agent is online, not revoked and not paused (`User.paused` or `Agent.localPaused`). The user has
   `running < maxConcurrent` and the model is in `allowedModels`.
4. `margin(u,p) ≥ E(task)`, `rateLimitedUntil` has passed, and the user has not rejected or failed this task
   in the last 24 h.

**Ranking:** highest `margin(u,p)/B(u,p)`, then fewest running tasks, then reset soonest, then least recently assigned.
The creator is not excluded.

**Dispatch:**

- `POOL`: the top candidate gets the offer. Mode AUTO → `AUTO_OFFER`. Mode APPROVAL → `CONSENT_REQUEST`, shown on the web
  (Pool page badge) and in `orch list`. A reject or expiry moves the offer to the next candidate.
- `TARGETED`: same flow, limited to the targets.
- `BROADCAST` (owner only): AUTO_OFFER to every eligible AUTO-mode member at the same time, and CONSENT_REQUEST to
  every eligible APPROVAL-mode member. **First accept wins** (partial unique index). The other offers are cancelled.
  One execution per task (first AUTO-mode member with margin to accept starts it; see section 10).
- `CLAIM` (`orch take`, MCP `take_task`): goes through the same eligibility checks except ranking. Taking a task yourself
  counts as consent.

**Consent invariants (enforced twice):**

- _Server:_ it never creates an `AUTO_OFFER` for a user whose participation isn't `active ∧ mode=AUTO`. No API
  path, including those for project owners and admins, can set someone else's `Participation` or bypass `mode`. Tests prove it.
- _Agent:_ the local policy guard re-checks the latest synced participation, local pause, concurrency and its own
  budget estimate before every start. If anything fails it rejects with a reason. `orch pause` applies locally before the
  server even knows, so an offer can't win the race against the pause button.

**Limits:** a user may have at most `maxPendingTasks` (default 20) of their own tasks in a pre-run state. Over that
limit, `submit_task` and the web form return an error.

---

## 7. MCP server

- **Transport:** Streamable HTTP at `https://<domain>/mcp`. Auth: `Authorization: Bearer orch_pat_<…>`, a
  personal token the user creates under **Settings → MCP tokens** (hashed, revocable, shown once, scope `mcp`).
  It's separate from the agent credential.
- **Setup command** (in the README and on the Settings page, pre-filled with the domain):
  ```
  claude mcp add --transport http --scope user orch https://<domain>/mcp \
    --header "Authorization: Bearer <your-orch-token>"
  ```
- **Tools** (input schemas from `packages/shared/mcp`). Each one runs the same authorization checks as the web API:

| tool          | input                                                                                                                                                                                                                                                          | output                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `view_pool`   | `{ project?: "owner/repo" }`                                                                                                                                                                                                                                   | members: login, online, paused, mode, ≈margin %, resetAt, running tasks (flagged as estimates)      |
| `list_tasks`  | `{ project?, status?: [...], mine?: bool, limit? }`                                                                                                                                                                                                            | tasks with number, title, status, size, model, assignee, deps, PR                                   |
| `submit_task` | `{ project, dispatch: "pool"\|"targeted"\|"broadcast", targets?: [login], integrationBranch?, dryRun?: bool, tasks: [{ ref: "a", title, description, acceptanceCriteria: [..], size: "S"\|"M"\|"L", model: "sonnet"\|"opus", dependsOn?: [ref \| "#123"] }] }` | created tasks with issue URLs, or validation errors (cycle, unknown dep, permission, pending limit) |
| `take_task`   | `{ project, issueNumber }`                                                                                                                                                                                                                                     | assignment id and how to attach (`orch attach <n>`)                                                 |
| `task_status` | `{ project, issueNumber }`                                                                                                                                                                                                                                     | status, assignee, attempts, PR, last progress line                                                  |

- `submit_task` is **atomic**: it validates the whole DAG (Kahn's algorithm), then creates a `TaskBatch`, the issues
  (labeled `pool`, with a hidden metadata block), `Task` and `TaskDependency` rows, and audits everything. If GitHub
  fails partway through, the issues already created are closed and labeled `orch-aborted`. If `integrationBranch`
  doesn't exist, the server creates it from the default branch. The **caller's own Claude Code** splits the work. The
  server needs no LLM key. The tool descriptions tell the calling model to read the repo and keep tasks small and testable.

---

## 8. Milestones

Each milestone ends with a demo to the user and is only accepted when its test suite passes in CI (all in Docker).

### M1: Server, GitHub login, My projects, Discover, participation

- **Scope:** monorepo scaffold, tools image, `./dev`, CI with gitleaks, Prisma schema (full), Fastify app,
  GitHub OAuth (App user auth), sessions + CSRF, installations/webhook ingestion (installation events only),
  role mapping from the user's own `GET /repos/{o}/{r}` permissions, project add/settings, Discover with
  participation (active, percent, auto/approval, owner approval of participants), audit log, the prod `deploy/server/compose.yaml` + Caddy,
  and the GitHub App manifest.
- **Deliverables:** pages My projects, Discover, a Settings stub. `docs/github-app.md`.
- **Tests:** unit tests for role → rights mapping and percent-sum validation. Integration tests (Postgres service, GitHub
  mocked with msw and recorded fixtures) for OAuth callback, user creation, project add without installation →
  install link, permission sync, and a check that a user cannot edit another user's participation (a 403 test for admins too).
  Webhook signature tests. Audit row checks. Playwright: login (mock OAuth) → add project → participate 30 % approval → pending until the owner approves. A test shows nobody is eligible for offers before approval.
  The CI gitleaks step must pass.

### M2: install.sh, agent enrollment, usage, My server, pause

- **Scope:** `install.sh` (checks docker and compose, creates `~/orch/{compose.yaml,.env,work}`, runs `docker
compose up -d`, is idempotent, has `--uninstall` with an optional `--purge`, and prints the `orch login` step and the alias).
  Agent image, enrollment, WSS gateway, heartbeat, outbox, usage scanner, the `orch` CLI (`status`, `pause`, `resume`, `login`),
  the My server page (install command, online status/version/last report, pause button, revoke), and the Pool page (read-only).
- **Tests:** concurrent use of the same enrollment token: exactly one wins. Expired tokens are rejected. The secret is
  stored hashed. Revocation closes the socket in < 2 s. A reconnection test that kills the server and checks outbox replay
  and dedupe. Pause on the web reaches the agent in < 2 s, and `orch pause` works offline. The usage parser is checked against
  fixture jsonl files (duplicates, multiple models, window boundaries) and compared with ccusage on the same fixtures. `install.sh`:
  shellcheck plus bats tests running in a DinD container (fresh install, re-run without changes, uninstall leaves nothing
  behind, missing docker produces a clear error).

### M3: Tasks from issues, manual mode, sandbox, PR

- **Scope:** issue sync (label `pool` import, platform-created issues, snapshot + hash, `PROPOSED` for READ users),
  the Backlog kanban, `orch take` / `task.claim`, mirror + clone, the sandbox (5.3), the Claude token passed as an env
  var, the screen session in the agent container, `orch attach|shell|done`, a plain push of the task branch with a scoped
  installation token, PR opened by the server, cleanup. No auth spike, egress proxy, sanitizers or snapshot export.
- **Tests:** small **sandbox conformance suite** run inside a real task container in DinD: no `/var/run/docker.sock`, no
  Docker API reachable, no host `$HOME` content, `mount` shows only the expected mounts, `CapEff` = 0, non-root. The Claude
  token is present only as an env var in the task container (not in any protocol frame, log or file of the clone). Hooks in a
  task clone are not run by the agent's git on push. Token minting asks for the right repo/permissions. E2E with
  fake-claude: take → edit → done → PR created on the mocked GitHub.

### M4: Auto mode, budgets, consent, webhooks

- **Scope:** `claude -p` runner with stream-json, per-task usage, rate-limit detection, the scheduler (section 6), offers,
  consent requests (web + `orch list`), broadcast, leases/LOST handling, webhooks (`pull_request` opened/closed+merged,
  `issues` closed/edited/labeled), the Done → `cleanup` flow, and editing an issue after import → re-approval. Budgets use the 5-hour window only. Starts directly on the M3 sandbox, with no auth spike to wait for.
- **Tests:** property-based tests (fast-check) on the scheduler over random pools: it never offers AUTO to a non-auto user,
  never exceeds `B(u,p)`, never offers when paused or at max concurrency, and never offers a task with unfinished deps.
  Broadcast race: N simultaneous accepts → exactly one live assignment. Agent guard rejects when local state disagrees
  with the server. Webhook signature + `X-GitHub-Delivery` dedupe. E2E in DinD with two agents and fake-claude:
  submit → auto-run on agent A → draft PR → merge webhook → Done → cleanup. Agent B (approval mode) receives a request and
  nothing starts there until it accepts.

### M5: MCP, submission from Claude Code, splitting and dependencies

- **Scope:** MCP endpoint, personal tokens UI, the five tools, batches, integration branches, dependency unblocking on
  merge, the README (server install, GitHub App creation, adding a member, MCP setup), and docs.
- **Tests:** MCP tests with the SDK client (auth required, revoked token rejected, schema validation). DAG validation
  (cycles, unknown refs, cross-project deps rejected). Atomic rollback when GitHub fails partway. E2E: `submit_task` with
  3 subtasks a→b, a→c → only `a` runs → merge → `b` and `c` become READY and PRs target the integration branch; the project owner merges all PRs (subtask PRs into the integration branch, and the integration branch into the default branch).
  A manual check of the `claude mcp add` command with a real Claude Code session.

### 8.6 Dev compose (one machine, Docker only)

`compose.dev.yaml` services:

- `tools`: node:22 + pnpm (store in a named volume), with the repo mounted. Used by `./dev install|lint|typecheck|test|build`.
- `postgres` (internal only, plus a separate `postgres-test` DB created at start), `server` (tsx watch, debug port `${ORCH_DEV_API_PORT:-8471}`), `web` (Vite dev server, port internal to its container).
- `caddy` (host port `${ORCH_DEV_WEB_PORT:-8470}`, see 8.7) with `tls internal`, so the agent uses real `wss://` locally (the agent trusts Caddy's local CA via a mounted cert).
- `agent-a`, `agent-b`: each one runs inside its own **`docker:dind`** sidecar (`dind-a`, `dind-b`), simulating two member
  machines with separate Docker daemons. The host socket is never exposed to them.
- `fake-claude` binary mounted instead of the real one (env `ORCH_CLAUDE_BIN`), so the e2e tests use no subscription.
- `github-mock` (msw-based) by default. With `--profile real-github`, a real test GitHub App is used and webhooks are
  delivered through a `smee-client` container.
- `playwright` (mcr.microsoft.com/playwright) for web e2e.
  `./dev e2e` = `docker compose -f compose.dev.yaml -f compose.test.yaml up --abort-on-container-exit`.

### 8.7 Host ports

Every published host port is set in `.env`. The defaults below avoid ports already used on the dev machine
(22, 111, 2283, 3010, 3050, 5173, 6666, 6680, 8001, 8069, 8080, 8090, 8765, 8767, 9200, 9300, 9445, 9980, 47823).

| Context                  | Service                                   | Env var             | Default | Notes                                                                                 |
| ------------------------ | ----------------------------------------- | ------------------- | ------- | ------------------------------------------------------------------------------------- |
| Prod (`deploy/server`)   | Caddy HTTP                                | `HTTP_PORT`         | 80      | ACME HTTP challenge + redirect                                                        |
| Prod                     | Caddy HTTPS                               | `HTTPS_PORT`        | 443     | Web, `/api`, `/agent/ws`, `/mcp`, `/install.sh`                                       |
| Dev (`compose.dev.yaml`) | Caddy (web + proxied API, `tls internal`) | `ORCH_DEV_WEB_PORT` | 8470    | The single entry point used by browser and agents                                     |
| Dev                      | Server API (direct, for debugging)        | `ORCH_DEV_API_PORT` | 8471    |                                                                                       |
| Dev                      | Postgres                                  | `ORCH_DEV_PG_PORT`  | 8472    | **Not published by default.** Internal network only, enabled with `--profile pg-host` |

Postgres, the server and the Vite dev server listen only on the internal Compose network in production. Vite keeps its
default port **inside its container** (never published, and 5173 is never bound on the host). Caddy proxies to it.
The agent compose publishes **no host ports**. The agent's unix socket is internal only.
If 80/443 are changed in production, ACME needs a DNS challenge or an upstream proxy (documented in the README).

---

## 9. Risks

**R1 Anthropic terms.** Resolved: each member uses their own subscription for their own work on a shared project.
Nothing is pooled across accounts and no credential leaves the member's machine.

**R2 Usage estimation.** Anthropic doesn't publish exact subscription limits. They vary by plan and model, include
weekly caps, and count usage from every device and claude.ai chat, while the jsonl files show only local Claude Code
usage. The 5-hour block boundaries from ccusage are themselves a guess. The margin shown is a rough estimate. The plan
relies on calibration from real limit hits and a 20 % safety margin, and the UI marks every figure as an estimate.

**R3 Prompt injection.** An issue is still a prompt that a teammate (or anyone, on a public repo) can write.
Mitigations kept: only issues labeled by a write+ user are imported, the body is snapshotted (later edits need
re-approval), comments are never included, the sandbox applies, and auto-mode PRs are draft and need human review.
There is no egress control in v1 (section 11).

**R4 Claude credentials in the task container.** The member's token is an env var in the task container, so a
malicious prompt could read or send it. Accepted for trusted teams. It is the member's own token and can be revoked
from their Claude account.

**R5 Docker socket.** The agent container holds the docker socket, which is root on the member's host. Accepted for
trusted teams. The agent image is pinned by digest and tasks never get the socket. Rootless Docker is documented as an option.

**R6 Repo-defined containers.** Only simple devcontainer keys are honored in v1, so some repos will need tweaks to run under orch.
The repo's own `compose.yaml` is used as-is.

**R7** Moot: there is no egress control in v1, so build-time network is not a separate concern.

**R8 Screen inside the agent container.** Sessions die when the agent restarts or upgrades (the task container survives and `orch attach` re-opens
a session).

**R9 Docker-only dev.** DinD in dev/CI needs `privileged: true`. That's acceptable for test environments only and never
appears in the production compose files. Bind-mounted `node_modules` volumes can be slow on some hosts.

**R10 GitHub App permissions** (proposed): Repository: Contents RW, Pull requests RW, Issues RW, Metadata R.
Account: Email R. Events: installation, installation_repositories, issues, pull_request, label. A `contents:write`
installation token can push to any branch, so branch protection is required. Org installations need an org admin.

## 10. Decisions

- **Budget (Q2):** percent is measured over the 5-hour window. The weekly estimate is informational. Member-declared plan plus calibration is kept.
- **Claude login (Q4):** `orch login` wraps `claude setup-token`; the token lives in the agent's local volume.
- **Docker socket (Q5):** the agent holds it; accepted for trusted teams. Rootless Docker is documented as optional.
- **Sandbox (Q3, Q6, Q7, Q20):** moot with the trusted-team model (no auth proxy, no sanitizing, no egress allowlist, no build-network control).
- **Manual attach (Q8):** `screen` in the agent container, as proposed.
- **Checkout/export (Q9):** isolated clone, normal push of the task branch, no snapshot.
- **Broadcast (Q10):** one execution. The first auto-mode member with margin starts it, approval-mode members get a request, the first acceptance wins.
- **Private repos (Q11):** owners approve participants by default (`requireParticipantApproval`, a project setting).
- **Read = can propose (Q12):** `PROPOSED` tasks wait for a write+ user.
- **Limits (Q13):** 20 pending tasks per creator, 1 concurrent task per machine, timeouts S/M/L = 30/90/180 min.
- **Integration branches (Q14):** subtask PRs target the integration branch. The project owner (its creator) merges ALL PRs: subtask PRs into integration branches and PRs into the default branch. Write-access members do not merge.
- **PRs (Q15):** manual-mode PRs ready for review, auto-mode PRs draft.
- **Personal usage (Q16):** opt-in, read-only mount of `~/.claude/projects`.
- **Hosting (Q17):** single server plus nightly `pg_dump`. The production domain is `orch.selfhostr.io`, set via env (`ORCH_DOMAIN`, used as the `.env.example` and docs example value) and never hardcoded in code.
- **Sign-in allowlist:** logins and/or GitHub orgs, case-insensitive. Org membership is checked at login with the user token (App permission Members: read) and cached for open sessions; the login list is checked on every request. Empty in production = refuse to start.
- **Language (Q18):** English only, no i18n scaffolding.
- **License (Q19):** MIT.

## 11. Future hardening (if pools ever open to untrusted members)

- Egress allowlist proxy container for task containers (default registries plus a per-project `egressAllow`).
- Token-injecting proxy so the Claude credential never enters the task container.
- Sanitizing devcontainer and compose files (the repo's own compose.yaml is used as-is in v1).
- Restricted `buildkitd` for build-time network.
- Snapshot export into a fresh trusted checkout instead of pushing the task's own `.git`.
- Rootless Docker or gVisor as a required option.

**Open questions:** none.
