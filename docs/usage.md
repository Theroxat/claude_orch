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

## Task templates

A template is a reusable task skeleton: a title, a Markdown description, acceptance criteria, a default size, model and GitHub labels. Write `{{placeholders}}` where the author of a task fills in a value, for example `Upgrade {{package}} to {{version}}`.

- **Start from a template**: in **New task**, open _Start from a template_, search, pick one. The dialog shows one field per placeholder and a live preview; empty placeholders stay highlighted until you fill them. _Edit as plain text_ turns the result into ordinary fields.
- **Built-in templates** (read-only): _Fix a bug_, _Upgrade a dependency_, _Add tests_, _Refactor module_. Copy one from **My server** to adapt it.
- **Personal templates** are managed in **My server**, under _My templates_. Only you see them.
- **Shared templates** belong to a project. The project owner creates, edits and deletes them from **My projects** (_Shared templates_ on the project card); everyone who can see the project can use them. Private repositories keep their templates private.

Values are inserted as plain text: HTML comments are neutralised (the issue body carries hidden orch metadata), the title is kept on one line and a value is never expanded a second time. Limits: 50 templates per user and per project, 20 placeholders per template, 5 000 characters per value, 5 labels. Labels may contain letters, digits, spaces and `. _ : / -`; they are added to the GitHub issue next to the pool label.

Claude Code can use the same templates through MCP ({doc}`mcp`).

## Manual mode

`orch take <n>` builds the dev container and starts an interactive Claude session in a `screen` named `issue-<n>` inside the agent container. Attach with `orch attach <n>` (detach with `Ctrl-a d`). When you are happy, `orch done <n>` commits, pushes, and the PR is opened ready for review.

## Auto and approval

In `AUTO` participation the server offers a task to a member with enough estimated budget and the agent runs it headlessly; the PR is opened as a **draft**. In `APPROVAL` participation you get a request (web or `orch requests`) and nothing starts until you accept. Your agent can always refuse locally with `orch pause`.

Follow an automatic run with `orch logs <n>`.

Limits: 1 concurrent task per machine, 20 pending tasks per creator, timeouts of 30, 90 and 180 minutes for sizes S, M and L. Branches are named `orch/issue-<n>-*`. The project owner merges the PRs.
