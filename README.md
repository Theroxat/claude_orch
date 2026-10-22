# orch

A shared to-do list for small, trusted teams, with automation on top: tasks are GitHub issues, and each member runs them on their own machine with their own Claude subscription.

[![CI](https://github.com/Theroxat/claude_orch/actions/workflows/ci.yml/badge.svg)](https://github.com/Theroxat/claude_orch/actions/workflows/ci.yml)
[![Documentation](https://readthedocs.org/projects/claude-orch/badge/?version=latest)](https://claude-orch.readthedocs.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it does

- Turns labeled GitHub issues into a shared pool of tasks, created from the web UI or by Claude Code through MCP.
- Runs each task on a teammate's machine, in a throwaway container that only sees its own git clone, then pushes a branch and opens a PR.
- Offers tasks automatically (or on approval) based on each member's estimated Claude budget.
- Keeps Claude credentials on the member's machine: the server only sees usage estimates and task statuses.
- Runs entirely in Docker: server, web, database, proxy, agent and sandboxes.

## Install

Self-host the server (Linux, Docker Engine 26+, a DNS name), then each member installs the agent with one command generated on the **My Server** page:

```sh
curl -fsSL https://<your-domain>/install.sh | ORCH_TOKEN=<one-time-token> sh
```

Server setup, the GitHub App and configuration are covered in the [documentation](https://claude-orch.readthedocs.io).

## Usage

```sh
orch list          # tasks you can take now
orch take 42       # claim issue 42 and prepare its sandbox
orch attach 42     # talk to Claude in the sandbox
orch done 42       # push the branch and open the PR
```

Or let orch offer tasks to the pool automatically. To submit work from Claude Code:

```sh
claude mcp add --transport http --scope user orch https://<your-domain>/mcp
```

## Documentation

Full documentation: **https://claude-orch.readthedocs.io** (quickstart, server installation, concepts, CLI and MCP reference, configuration, security model, FAQ). The sources are in [`docs/`](docs/).

orch is meant for teams who trust each other; read the security model before adopting it.

## Development

Everything runs through Docker; the host needs only `docker` with Compose.

```sh
./dev install && ./dev up    # web on http://localhost:8470, API on :8471
./dev lint && ./dev typecheck
./dev test
```

More in the [development guide](https://claude-orch.readthedocs.io/en/latest/development.html).

## License

MIT. See [LICENSE](LICENSE).
