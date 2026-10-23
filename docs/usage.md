# Day-to-day usage

## Web

Issues carrying the project's pool label (default `pool`) become tasks.

- **Backlog** shows tasks by status. New tasks can also be created here.
- **History** searches every task that has run ([below](#task-history)).
- **Pool** shows teammates' availability (estimates).
- **Usage** charts tokens and task runs over time ({ref}`usage-dashboard`).
- **Requests** lists approval requests addressed to you.
- **Discover** lists projects you can join.
- **My Server** manages your agent: install command, status, updates.
- **Claude Code** shows the MCP command for your domain and the connected apps ({doc}`mcp`).
- **Access** (`/admin/access`, admins only) manages who can sign in.

## Task templates

A template is a reusable task skeleton: a title, a Markdown description, acceptance criteria, a default size, model and GitHub labels. Write `{{placeholders}}` where the author of a task fills in a value, for example `Upgrade {{package}} to {{version}}`.

- **Start from a template**: in **New task**, open _Start from a template_, search, pick one. The dialog shows one field per placeholder and a live preview; empty placeholders stay highlighted until you fill them. _Edit as plain text_ turns the result into ordinary fields.
- **Built-in templates** (read-only): _Fix a bug_, _Upgrade a dependency_, _Add tests_, _Refactor module_. Copy one from **My server** to adapt it.
- **Personal templates** are managed in **My server**, under _My templates_. Only you see them.
- **Shared templates** belong to a project. The project owner creates, edits and deletes them from **My projects** (_Shared templates_ on the project card); everyone who can see the project can use them. Private repositories keep their templates private.

Values are inserted as plain text: HTML comments are neutralised (the issue body carries hidden orch metadata), the title is kept on one line and a value is never expanded a second time. Limits: 50 templates per user and per project, 20 placeholders per template, 5 000 characters per value, 5 labels. Labels may contain letters, digits, spaces and `. _ : / -`; they are added to the GitHub issue next to the pool label. GitHub creates a label that does not exist yet in the repository, so use labels the repository already has; the pool label and `orch-aborted` are never added twice or by a template.

Claude Code can use the same templates through MCP ({doc}`mcp`).

## Task history

The **History** page lists every task that has started, finished or been cancelled, newest first, in the projects you see on the Backlog (you own them or participate in them; private repositories stay hidden from everyone else). A task that went back to the queue after a failed run is included; tasks that never ran are not.

Each row shows the status, the issue and pull request links, the model and size, the number of runs and the class of the last failure (repository setup, Claude login, rate limit, timeout or task), the total duration of finished runs, the weighted tokens used, who created the task and who ran it.

Filters:

- **Search** matches the title, an issue number (`12` or `#12`) or a pull request number. Typing is debounced.
- **Status** and **Model** chips can be combined (a task matches any selected value in a group).
- **Project**, **Created by** (GitHub login), **Run by** (a member whose agent ran it), and a **Created from / until** date range (UTC).

Filters live in the address (for example `/history?status=DONE&model=OPUS&q=login`), so you can share a view. More rows load as you scroll, or with **Load more**.

The same data is available at `GET /api/tasks/history` with the same query parameters (`status`, `project`, `model` repeat; `creator`, `executor`, `from`, `to`, `q`, `limit`) and an opaque `cursor` returned as `nextCursor`. Order is stable (creation time, then id), so new tasks never shift or repeat rows between pages.

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

## Install as an app

The web interface is an installable app (PWA): it opens in its own window, without browser chrome, and has its own icon.

- **Chrome, Edge (desktop)**: click the install icon at the right of the address bar, or open the menu and choose _Install orch_.
- **Chrome (Android)**: menu, then _Install app_.
- **Safari (iOS and iPadOS)**: Share, then _Add to Home Screen_.
- **Safari (macOS)**: File, then _Add to Dock_.

The app needs HTTPS (or `localhost`) and your orch server to work: only the application shell is stored on the device. API responses and sign-in are never cached, so you always see live data. When the server cannot be reached, the app shows a "Server unreachable" page with a _Try again_ link.

When a new version of orch is deployed, a "New version available" message appears with a _Reload_ button. The app keeps running the old version until you reload.

## Manual mode

`orch take <n>` builds the dev container and starts an interactive Claude session in a `screen` named `issue-<n>` inside the agent container. Attach with `orch attach <n>` (detach with `Ctrl-a d`). When you are happy, `orch done <n>` commits, pushes, and the PR is opened ready for review.

## Auto and approval

In `AUTO` participation the server offers a task to a member with enough estimated budget and the agent runs it headlessly; the PR is opened as a **draft**. In `APPROVAL` participation you get a request (web or `orch requests`) and nothing starts until you accept. Your agent can always refuse locally with `orch pause`.

Follow an automatic run with `orch logs <n>` on the machine that runs it, or from the web (below).

(live-logs)=

## Live logs

Every task card that has run, or is running, has a **Logs** button. It opens a panel that follows the run of Claude Code as it happens, on the member's machine, in auto mode:

- assistant messages, tool calls (tool name and a short form of the arguments, for example `Bash pnpm test` or `Edit src/app.ts`), a few lines of each tool result, stderr lines and the final result;
- the view follows new lines; scroll up to read and it stops following, **Jump to latest** resumes it;
- **Copy log** copies what is on screen as plain text;
- the stream reconnects on its own after a network drop and resumes where it stopped; **Reconnect** appears if the server refused it (signed out, access removed).

Live logs are best effort: they never slow a run down, and a line lost on the way is just a gap (the panel says how many lines were not kept). The server keeps the last 512 KB of each run in memory, for 30 minutes after the run ends; a server restart forgets them. The complete log stays on the member's machine (`orch logs <n>`) until the task is cleaned up. Manual mode (`orch take`) has no live logs: the session is in your terminal.

Anyone who can see the task board of the project can read its live logs (see {doc}`security`).

Limits: 1 concurrent task per machine, 20 pending tasks per creator, timeouts of 30, 90 and 180 minutes for sizes S, M and L. Branches are named `orch/issue-<n>-*`. The project owner merges the PRs.
