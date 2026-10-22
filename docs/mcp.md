# Claude Code and MCP

orch exposes an MCP server so Claude Code can see the pool and submit work. The server needs no LLM key: your own Claude Code does the planning.

## Setup

1. Add the server to Claude Code (no token to copy):

   ```sh
   claude mcp add --transport http --scope user orch https://<domain>/mcp
   ```

2. In Claude Code, run `/mcp`, choose **orch**, then **Authenticate**.
3. Your browser opens: sign in with GitHub (the same orch login and allowlist) and approve. Done.

The **Claude Code** page of the web UI shows the command pre-filled with your domain and lists the connected apps, each with a **Revoke** button.

Under the hood this is MCP OAuth 2.1: discovery (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`), dynamic client registration, the authorization code flow with PKCE (S256), access tokens (`orch_oat_...`, 1 hour) bound to `https://<domain>/mcp`, and rotating refresh tokens. Everything is stored hashed and audited. A member removed from the allowlist loses every token.

## Personal access tokens (scripts and CI)

Create a personal access token on the **Claude Code** page (shown once, hashed, revocable) and send it as a header:

```sh
claude mcp add --transport http --scope user orch https://<domain>/mcp \
  --header "Authorization: Bearer <orch_pat_token>"
```

## Tools

| Tool          | Purpose                                                    |
| ------------- | ---------------------------------------------------------- |
| `view_pool`   | Who has capacity right now                                 |
| `list_tasks`  | Tasks of a project                                         |
| `submit_task` | Atomic batch of tasks with dependencies; supports dry runs |
| `take_task`   | Claim a task (same checks as `orch take`)                  |
| `task_status` | Status of a task                                           |

## Example prompts

- "Use orch to show who in the pool has capacity right now."
- "Read this repo, split the work to add CSV export into small tasks with acceptance criteria, and submit them to `acme/webapp` through orch. Dry run first."
- "List my open orch tasks for `acme/webapp` and tell me which ones are blocked."
- "What is the status of issue 42 in `acme/webapp`?"
