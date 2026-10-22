# Development and contributing

Everything goes through Docker; the host needs only `docker` with Compose and `sh`. `./dev` is a thin wrapper around `docker compose -f compose.dev.yaml`. The repository is a pnpm TypeScript monorepo: `apps/web`, `apps/server`, `apps/agent`, `packages/shared`, plus `deploy/`, `docker/` and `install.sh`.

```sh
./dev install      # pnpm install inside the tools container
./dev up           # web + API: http://localhost:8470 (Caddy), http://localhost:8471 (API direct)
./dev down
./dev lint
./dev typecheck
./dev test
./dev test:install # shellcheck + bats for install.sh
./dev test:ui      # Playwright browser tests against the e2e stack
./dev build
./dev prisma <args>
./dev logs [service]
```

Other subcommands: `format`, `e2e`, `pnpm ...`, `sh`, `ps`.

The first run copies `.env.example` to `.env`. Ports come from `ORCH_DEV_WEB_PORT` (8470) and `ORCH_DEV_API_PORT` (8471). GitHub sign-in needs a development GitHub App; the dev `.env` variables are the same `GITHUB_*` and `ORCH_ENCRYPTION_KEY` as in production, with callback `http://localhost:8470/api/auth/github/callback`.

## Database migrations

Migrations live in `apps/server/prisma/migrations/`, one folder per migration named `YYYYMMDDHHMMSS_snake_name`, applied in sort order. Create them with `./dev prisma migrate dev --create-only` (or by hand) and give each new one a unique timestamp later than the latest existing folder. Applied migrations are immutable: never edit or rename one. In particular, the two folders sharing the `20261027000000` prefix are already applied in production and must keep their names.

## Dev agent

A dev member agent is available with:

```sh
docker compose -f compose.dev.yaml --profile agent up -d --build agent
```

after setting `ORCH_DEV_ENROLL_TOKEN` in `.env`.

## CI and releases

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, installer tests, browser UI tests, production image builds, a documentation build and gitleaks. Pushing a `v*` tag runs `release.yml`, which publishes `orch-server`, `orch-web` and `orch-agent` to `ghcr.io/theroxat`.

## Building these docs

The documentation is Sphinx with MyST (Markdown), built by Read the Docs from `main`:

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r docs/requirements.txt
sphinx-build -W -b html docs docs/_build/html
```

`-W` turns warnings into errors, as in CI.

## Contributing

Use one branch and one pull request per logical change, never push to `main` directly, and make sure `./dev lint`, `./dev typecheck` and `./dev test` pass. Report vulnerabilities privately through GitHub security advisories.
