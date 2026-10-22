# Day-to-day usage

## Web

Issues carrying the project's pool label (default `pool`) become tasks.

- **Backlog** shows tasks by status. New tasks can also be created here.
- **Pool** shows teammates' availability (estimates).
- **Usage** charts tokens and task runs over time ({ref}`usage-dashboard`).
- **Requests** lists approval requests addressed to you.
- **Discover** lists projects you can join.
- **My Server** manages your agent: install command, status, updates.
- **Claude Code** shows the MCP command for your domain and the connected apps ({doc}`mcp`).
- **Access** (`/admin/access`, admins only) manages who can sign in.

(usage-dashboard)=

## Usage dashboard

The **Usage** page shows where tokens went. Pick a range (7, 30 or 90 days, in UTC days) at the top right. Every figure is an estimate.

- **Tiles**: weighted tokens, task runs, success rate and the busiest project budget of your current 5-hour window.
- **Tokens per day**: one bar per day. Hover, touch, or focus the chart and use the left and right arrow keys to read a day; _View as a table_ lists the same numbers.
- **Budget in this 5-hour window**: for each project you take part in, what it has used of the share of capacity you gave it. The bar turns ochre from 70 % and red from 90 %.
- **By project**, **By member**, **Most expensive tasks**: runs, failed runs and tokens.
- **Token types**: input, output, cache write and cache read, as counted by your agents.

"Tokens" are _weighted_ tokens, the same unit as budgets: the agent applies a model factor (Opus counts more than Sonnet). A run counts on the day it finished, whether it succeeded or failed; runs still in progress are not included.

Who sees what:

- You always see your own runs, in any project.
- Owners of a project also see every member's runs in it, so the member table lists them.
- Admins see all projects and members.
- Token types come from agent usage reports, which cover the whole machine including personal use. They are only shown for your own agents (all agents for admins), never to a project owner for someone else's machine.

Usage reports are kept for 30 days, so _Token types_ cannot go further back, whatever the range. Runs and their weighted tokens are kept for as long as the task.

The data comes from `GET /api/usage?range=7d|30d|90d` (cookie session).

## Manual mode

`orch take <n>` builds the dev container and starts an interactive Claude session in a `screen` named `issue-<n>` inside the agent container. Attach with `orch attach <n>` (detach with `Ctrl-a d`). When you are happy, `orch done <n>` commits, pushes, and the PR is opened ready for review.

## Auto and approval

In `AUTO` participation the server offers a task to a member with enough estimated budget and the agent runs it headlessly; the PR is opened as a **draft**. In `APPROVAL` participation you get a request (web or `orch requests`) and nothing starts until you accept. Your agent can always refuse locally with `orch pause`.

Follow an automatic run with `orch logs <n>`.

Limits: 1 concurrent task per machine, 20 pending tasks per creator, timeouts of 30, 90 and 180 minutes for sizes S, M and L. Branches are named `orch/issue-<n>-*`. The project owner merges the PRs.
