# Agent CLI reference

The `orch` shortcut installed on your machine (`~/.local/bin/orch`) runs `docker compose -f ~/orch/compose.yaml exec agent orch "$@"`, so these commands run inside the agent container. `<n>` is an issue number, or `owner/repo#<n>` when several projects are involved.

| Command                  | What it does                                                                   |
| ------------------------ | ------------------------------------------------------------------------------ |
| `orch status`            | Agent connection, pause state, your tasks, latest version and update progress  |
| `orch list [owner/repo]` | Tasks you can take now                                                         |
| `orch take <n>`          | Claim issue `<n>` and prepare its sandbox                                      |
| `orch attach <n>`        | Attach to the Claude session of issue `<n>` (detach: `Ctrl-a d`)               |
| `orch shell <n>`         | Shell inside the task container                                                |
| `orch done <n>`          | Commit, push the branch; the server opens the PR; sandbox stops                |
| `orch logs <n>`          | Follow the log of an auto run (`--no-follow`, `--lines=<k>`)                   |
| `orch requests`          | Approval requests waiting for you                                              |
| `orch accept <id>`       | Accept a request: the task runs on your machine                                |
| `orch reject <id>`       | Decline a request                                                              |
| `orch pause` / `resume`  | Stop or restart receiving work (applied locally first)                         |
| `orch update`            | Update the agent to the announced version (`--when-idle`, `--version=<x.y.z>`) |
| `orch login`             | Store your Claude token (also marks an expired login valid again)              |
| `orch doctor`            | Check the Claude binary, the stored token and a live login check               |
| `orch help`              | List the commands                                                              |

If the agent container is stopped, the shortcut falls back to `docker compose pull agent && docker compose up -d agent` for `update`.

## Agent settings

Set in `~/orch/.env` (written by `install.sh`):

| Variable                                 | Meaning                                               |
| ---------------------------------------- | ----------------------------------------------------- |
| `ORCH_SERVER_URL`                        | Server URL                                            |
| `ORCH_AGENT_ID`, `ORCH_AGENT_CREDENTIAL` | Identity written at enrollment                        |
| `ORCH_WORK_DIR`                          | Where mirrors and clones live on the host             |
| `ORCH_CLAUDE_DIR`                        | Host `~/.claude`, mounted read-only to estimate usage |
| `ORCH_PLAN`                              | `pro` (default), `max5` or `max20`                    |
| `ORCH_MAX_CONCURRENT`                    | Concurrent tasks, 1 to 16 (default 1)                 |
| `ORCH_AGENT_IMAGE`, `ORCH_AGENT_TAG`     | Agent image and tag, used by updates                  |

More options (`ORCH_DEFAULT_IMAGE`, `ORCH_MACHINE_NAME`, `ORCH_USAGE_INTERVAL_SEC`, `ORCH_GIT_AUTHOR_NAME`, ...) are defined in `apps/agent/src/config.ts`.
