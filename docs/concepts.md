# Concepts

## Projects

A **project** is a GitHub repository registered in orch by its owner (the App must be installed on it). Issues carrying the project's pool label (default `pool`) become tasks. Members discover projects on the **Discover** page and join them. Private projects require the owner's approval by default.

## Participation

Joining a project creates a **participation** with:

- a **mode**: `AUTO` (the server may start tasks on your machine while you have budget) or `APPROVAL` (you get a request and nothing starts until you accept);
- the **models** you allow (Sonnet, Opus);
- a **budget percentage**: the share of your Claude capacity you give this project.

Nobody, including project owners and admins, can set someone else's participation or bypass the mode.

## The pool

The **pool** is the set of members who participate in a project and whose agents are online. The **Pool** page shows their availability (estimates). Tasks are offered to pool members; a member can also take a task directly with `orch take`.

## Budgets

Anthropic does not publish exact subscription limits, so orch works with **estimates**, measured over the 5-hour window only (a weekly estimate is shown for information and never used for scheduling).

- Capacity `C` per window starts from the plan declared on the agent (`ORCH_PLAN`: `pro`, `max5`, `max20`) and is calibrated downward when a real limit is hit.
- A safety margin (20 % by default) is held back.
- The project budget is `percent x C x (1 - margin)`. Usage attributed to the project and the estimates of accepted or running tasks are subtracted.
- A task estimate is its size (S, M, L = 0.1, 0.25, 0.5 of a Pro window by default) times a model factor (Opus counts 5x by default, `OPUS_FACTOR`). Once at least 5 past attempts exist for a (project, size), the median is used.
- Personal use of Claude counts toward the global check.

Only usage figures leave the member's machine, never credentials. A usage report older than 15 minutes (`USAGE_STALE_SEC`) makes the member ineligible for automatic offers.

## Task lifecycle

```{mermaid}
stateDiagram-v2
    [*] --> PROPOSED: submitted by a READ user
    PROPOSED --> READY: approved by a writer
    [*] --> BLOCKED: dependencies not done
    [*] --> READY
    BLOCKED --> READY: dependencies DONE
    READY --> OFFERED: live offer or consent requests
    OFFERED --> ASSIGNED: accepted
    OFFERED --> READY: rejected / expired, next candidate
    ASSIGNED --> RUNNING
    RUNNING --> IN_REVIEW: PR open
    IN_REVIEW --> DONE: merged
    RUNNING --> FAILED
    FAILED --> READY: retry
    READY --> CANCELLED: issue closed or creator cancels
```

Kanban columns on the Backlog page: **To do** = PROPOSED, BLOCKED, READY, OFFERED. Dependencies are re-checked on every merge webhook. Branches are named `orch/issue-<n>-*` and the project owner merges the PRs. Multi-task submissions with dependencies run the first task, and when it merges the dependent ones become READY; their PRs target an integration branch which the owner merges into the default branch.

## Offers and dispatch

For each READY task the dispatcher (every 5 s by default) picks eligible candidates:

1. all dependencies are `DONE`;
2. the user has an active participation, is allowed in the project, and, for a targeted task, is among the targets;
3. their agent is online, not revoked and not paused, below its concurrency limit, and the model is allowed;
4. their budget margin covers the task estimate, they are not rate limited, and they have not rejected or failed this task in the last 24 hours.

Candidates are ranked by remaining budget fraction, then fewest running tasks, then soonest reset, then least recently assigned. The creator is not excluded.

Dispatch modes:

- **Pool**: the top candidate gets the offer. In `AUTO` mode it is an **auto offer** (expires after 60 s by default, `AUTO_OFFER_TTL_SEC`); in `APPROVAL` mode it is a **consent request** (30 minutes, `CONSENT_REQUEST_TTL_SEC`), shown in the web app and in `orch requests`. A reject or an expiry moves the offer to the next candidate.
- **Targeted**: the same flow, limited to chosen members.
- **Broadcast** (owner only): offered to every eligible member at once; the first to accept wins and the other offers are cancelled.
- **Claim** (`orch take`, MCP `take_task`): the same eligibility checks without ranking. Taking a task yourself counts as consent.

Each tick reads its state once (participations, recent history, latest usage reports, runs holding a slot or budget) and decides in memory; the offers it makes are counted for the following tasks of the same tick. Before an auto offer is written, the member's row is locked and their slots and held runs are read again, so a run accepted meanwhile (from any server instance) is counted for both the concurrency limit and the budget. Only the usage report and the usage of finished runs can be up to one tick old, which is far below the usage report staleness limit.

Consent is enforced twice: the server never creates an auto offer for someone who is not `active` and in `AUTO` mode, and the agent re-checks its latest participation, local pause, concurrency and its own budget before every start. `orch pause` applies locally before the server knows, so an offer cannot win the race against the pause button.

Limits: at most 20 pending tasks per creator (an error is returned beyond that), 1 concurrent task per machine by default, and execution timeouts of 30, 90 and 180 minutes for sizes S, M and L.

## Server architecture

The server is one Node process (Fastify) with all its state in Postgres. In memory it only keeps what belongs to a connection or a cache: the agents' WebSockets, the live output of running tasks, short-lived caches (access decisions, GitHub clients) and per-process rate-limit counters.

It can run as several instances behind a load balancer, with Postgres as the only shared dependency ({ref}`multi-instance`):

- **Leadership.** Singleton loops (the dispatcher tick, retention purges) run on one instance, elected with a Postgres advisory lock held on a dedicated connection. Losing that connection means losing the lock, so a leader that cannot reach the database steps down and another instance takes over. The dispatcher is safe to overlap anyway: offers are created under row locks and unique indexes (see above).
- **Messaging.** Each instance listens on a Postgres `LISTEN/NOTIFY` channel. An instance that needs to reach an agent connected elsewhere (offer, cancel, config push, disconnect) relays the message to the instance holding the socket, found in the agent directory table. The same channel forwards dispatcher kicks to the leader, access-cache invalidations and live output to instances whose users watch a task.
- **Durable work.** Notification deliveries are rows claimed with `FOR UPDATE SKIP LOCKED`, so retries survive restarts and each delivery has one owner at a time.

## Execution and sandbox

On the member machine the agent keeps a bare **mirror** of each repository and makes an **isolated clone** per task, not a worktree of your working copy. Each task runs in its own container: non-root, with only that clone mounted, no Docker socket and no host home directory. Git metadata (the mirror and the clone's `.git` bookkeeping) stays outside the task container so a task cannot rewrite hooks or config that the agent's git would run later.

The task image comes from the repository's `Dockerfile` or a simple `.devcontainer.json`, otherwise a default image (`ORCH_DEFAULT_IMAGE`). In auto mode the agent runs `claude -p --permission-mode bypassPermissions` inside the container and the PR is opened as a **draft**. In manual mode (`orch take`) it starts an interactive Claude session in a `screen` and you finish with `orch done`.

### The compose guard

When a task uses the repository's own `compose.yaml` for its development environment, the agent validates it before starting anything and refuses `privileged`, host bind mounts, the Docker socket, host networking and `cap_add`. This validation is being completed on the agent side; until it ships, treat a repository's compose file as trusted code. It is not a defence against a hostile teammate.

For the complete design see {doc}`PLAN`.
