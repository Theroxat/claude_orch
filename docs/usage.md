# Day-to-day usage

## Web

Issues carrying the project's pool label (default `pool`) become tasks.

- **Backlog** shows tasks by status. New tasks can also be created here.
- **Pool** shows teammates' availability (estimates).
- **Requests** lists approval requests addressed to you.
- **Discover** lists projects you can join.
- **My Server** manages your agent: install command, status, updates.
- **Claude Code** shows the MCP command for your domain and the connected apps ({doc}`mcp`).
- **Access** (`/admin/access`, admins only) manages who can sign in.

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
