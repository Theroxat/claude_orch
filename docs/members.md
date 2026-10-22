# Adding a member and the agent

## Adding a member

1. **Get access, then sign in.** The member opens `https://<domain>` and signs in with GitHub. If they are not allowed yet, they click **Request access** and an admin approves them on the **Access** page (`/admin/access`); or an admin pre-approves their login or sends them an invite link first (see {ref}`Managing access <access-control>`). No `.env` edit or restart is needed.
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

   If a task fails because the Claude login expired or was revoked (`401 ... OAuth access token is invalid`), the agent remembers it in `claude-auth.json` in its data directory, tells the server (`claudeAuthValid: false`), refuses new AUTO offers and shows "Claude login expired" in `orch status`. The agent cannot check a token without calling Anthropic, so `orch login` simply marks the login valid again once the new token is stored; the running agent picks that up without a restart.

   The `orch` shortcut is `docker compose -f ~/orch/compose.yaml exec agent orch "$@"` (with a terminal attached when you have one), so every command in the {doc}`CLI reference <cli>` works as written.

### Installer options

`install.sh` accepts:

| Option           | Meaning                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| `--token <t>`    | One-time enrollment token (15 min). Deprecated: visible in `ps`; prefer `ORCH_TOKEN` |
| `--server <url>` | Server URL (default: the URL the script was served from, or `$ORCH_SERVER_URL`)      |
| `--dir <path>`   | Install directory (default `~/orch`)                                                 |
| `--force`        | Re-enroll even if already enrolled                                                   |
| `--uninstall`    | Stop and remove containers and volumes (and the `~/.local/bin/orch` shortcut)        |
| `--purge`        | With `--uninstall`: also delete the install directory                                |
| `--yes`          | Do not ask for confirmation (also skips the Claude login offer)                      |

(updating-agents)=

## Updating agents

The server knows its own release (`ORCH_VERSION`) and the version each agent reports when it connects. When one of your agents runs an older release, the web app shows a banner at the top of every page, for example "Your agent on laptop is out of date (v0.4.1 → v0.4.3)", and the **My Server** page shows the state of each agent. Local `dev` builds are never reported as outdated.

**One click.** Press **Update now**. The server sends the agent an `agent.update` message naming the target version and the image `ghcr.io/theroxat/orch-agent:<version>`. The server decides the image from its own release and `ORCH_AGENT_IMAGE_REPO`; the request cannot choose it. The agent then:

1. refuses when tasks are running (choose **Update when idle** to wait until they finish; meanwhile it takes no new automatic offers);
2. checks that the image is exactly `<its configured repository>:<release>` (`ORCH_AGENT_IMAGE_REPO`, from `ORCH_AGENT_IMAGE` in `~/orch/.env`); anything else is refused;
3. finds its compose project, files and directory from its own container labels, and pulls the image. If the pull fails, nothing changes and the old version keeps running;
4. writes `ORCH_AGENT_TAG=<version>` into `~/orch/.env` (or `ORCH_AGENT_IMAGE`, if your compose file uses only that), keeping a backup;
5. starts a short-lived helper container from its current image, with the Docker socket and `~/orch` mounted at the same path. After a few seconds the helper runs `docker compose up -d agent`. If that fails, it restores the backup and starts the old version again.

The page follows the steps (requested, waiting for tasks, downloading, restarting). The update is marked done when the agent reconnects with the new version. Only the owner of an agent can update it, and every request is audited (`agent.update_requested`, `agent.update_done`, `agent.update_failed`).

**From the machine.** `orch update` does the same thing locally, for the version the server announces (`orch update --when-idle` waits for running tasks; `orch update --version=0.4.3` picks a release). `orch status` shows the latest version and the update progress. If the agent container is stopped, the `orch` shortcut falls back to `docker compose pull agent && docker compose up -d agent`.

**Manually**, for agents too old for one-click updates, or for installs not made with `install.sh`:

```sh
cd ~/orch
# pin a release: echo ORCH_AGENT_TAG=0.4.3 >> .env   (or leave the default tag, latest)
docker compose pull && docker compose up -d
```
