# Day-to-day usage

## Web

Issues carrying the project's pool label (default `pool`) become tasks.

- **Backlog** shows tasks by status. New tasks can also be created here.
- **History** searches every task that has run ([below](#task-history)).
- **Pool** shows teammates' availability (estimates).
- **Requests** lists approval requests addressed to you.
- **Discover** lists projects you can join.
- **My Server** manages your agent: install command, status, updates.
- **Claude Code** shows the MCP command for your domain and the connected apps ({doc}`mcp`).
- **Access** (`/admin/access`, admins only) manages who can sign in.

## Task history

The **History** page lists every task that has started, finished or been cancelled, newest first, in the projects you see on the Backlog (you own them or participate in them; private repositories stay hidden from everyone else). A task that went back to the queue after a failed run is included; tasks that never ran are not.

Each row shows the status, the issue and pull request links, the model and size, the number of runs and the class of the last failure (repository setup, Claude login, rate limit, timeout or task), the total duration of finished runs, the weighted tokens used, who created the task and who ran it.

Filters:

- **Search** matches the title, an issue number (`12` or `#12`) or a pull request number. Typing is debounced.
- **Status** and **Model** chips can be combined (a task matches any selected value in a group).
- **Project**, **Created by** (GitHub login), **Run by** (a member whose agent ran it), and a **Created from / until** date range (UTC).

Filters live in the address (for example `/history?status=DONE&model=OPUS&q=login`), so you can share a view. More rows load as you scroll, or with **Load more**.

The same data is available at `GET /api/tasks/history` with the same query parameters (`status`, `project`, `model` repeat; `creator`, `executor`, `from`, `to`, `q`, `limit`) and an opaque `cursor` returned as `nextCursor`. Order is stable (creation time, then id), so new tasks never shift or repeat rows between pages.

## Manual mode

`orch take <n>` builds the dev container and starts an interactive Claude session in a `screen` named `issue-<n>` inside the agent container. Attach with `orch attach <n>` (detach with `Ctrl-a d`). When you are happy, `orch done <n>` commits, pushes, and the PR is opened ready for review.

## Auto and approval

In `AUTO` participation the server offers a task to a member with enough estimated budget and the agent runs it headlessly; the PR is opened as a **draft**. In `APPROVAL` participation you get a request (web or `orch requests`) and nothing starts until you accept. Your agent can always refuse locally with `orch pause`.

Follow an automatic run with `orch logs <n>`.

Limits: 1 concurrent task per machine, 20 pending tasks per creator, timeouts of 30, 90 and 180 minutes for sizes S, M and L. Branches are named `orch/issue-<n>-*`. The project owner merges the PRs.
