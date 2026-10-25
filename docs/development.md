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

## Dependency updates

Dependencies are kept up to date by [Renovate](https://docs.renovatebot.com/), configured in `renovate.json` at the repository root. Renovate opens grouped pull requests on Monday mornings (before 6am, Europe/Paris) for npm, GitHub Actions, Docker base images, the Sphinx requirements and Prisma, React and Vitest packages. A dependency dashboard issue lists all pending updates. Nothing is merged automatically: every Renovate pull request waits for a review. Dockerfile base images and GitHub Actions are pinned by digest; images in the compose files are not (operators pull them by tag).

Renovate only runs once its GitHub App is installed on the repository. The repository owner must install it at <https://github.com/apps/renovate> and grant access to `Theroxat/claude_orch`.

## Building these docs

The documentation is Sphinx with MyST (Markdown), built by Read the Docs from `main`:

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r docs/requirements.txt
sphinx-build -W -b html docs docs/_build/html
```

`-W` turns warnings into errors, as in CI.

## Translations

The web interface (`apps/web`) is translated with a small typed layer in `apps/web/src/i18n/`, without a runtime dependency. English is the default and the fallback; French is loaded on demand as a separate chunk.

- **Catalogs** live in `apps/web/src/i18n/locales/<locale>/<namespace>.ts`, one namespace per area of the app (`backlog`, `history`, `notifications`...). English files end with `as const`; their literal strings define the keys and the placeholders each message takes. Other locales end with `satisfies Catalog<typeof en>`, so a missing, extra or misshaped key is a type error.
- **In components**, call `const t = useT()` and write `t('backlog.empty.title')`. Placeholders are `{name}` (`t('layout.nav.pendingRequests', { count })`); TypeScript rejects a missing one. A sentence containing a link or emphasis uses `useRich()` with tags in the message (`'Read the <link>docs</link>'`) instead of being split into fragments.
- **Plurals** are objects with [CLDR plural categories](https://cldr.unicode.org/index/cldr-spec/plural-rules), chosen with `Intl.PluralRules`: `{ one: '{count} task', other: '{count} tasks' }`, plus an optional `zero`. In French, 0 takes `one`.
- **Dates and numbers** go through `apps/web/src/i18n/format.ts` (`formatDate`, `formatNumber`...), never a hard-coded `'en-US'`. Errors shown to users go through `errorMessage()` (`i18n/errors.ts`), which translates the API error codes.
- **Keys chosen at run time** are either listed in a map typed `satisfies Record<..., MessageKey>` or built with a template literal such as ``t(`backlog.status.${status}`)``.

`pnpm --filter @orch/web test` starts with `scripts/check-i18n.ts` (also `pnpm --filter @orch/web i18n:check`). It fails when a locale misses or adds a key, when a translation drops or invents a placeholder or tag, when French typography slips (no-break space before `: ; ! ?`, `’`, `…`), or when an English key is used nowhere in `src/`. Tests render in English; `switchToFrench()` from `src/test/helpers.tsx` switches one test to French.

To **add a string**: add the key to the English namespace file, use it, add the French translation, run the check. To **add a locale**: create `locales/<code>/` with the same files as `fr/`, add the code to `LOCALES`, `LOCALE_NAMES`, the `Intl` tag map and the lazy `loaders` in `i18n/index.ts`, and extend the check script.

French style: no formal "vous"; buttons and instructions use the infinitive (_Ajouter un dépôt_, _Réessayer_), descriptions are impersonal, the user's own things take "mon/mes" (_Mon serveur_), sentence case. Keep these terms consistent:

| English            | French                                         |
| ------------------ | ---------------------------------------------- |
| task               | tâche                                          |
| issue              | ticket                                         |
| pull request, PR   | pull request (f.), PR                          |
| repository         | dépôt                                          |
| branch             | branche                                        |
| pool, backlog      | pool, backlog (m.)                             |
| run                | exécution                                      |
| queued             | en file                                        |
| request (approval) | demande                                        |
| offer              | proposition                                    |
| owner, member      | propriétaire, membre                           |
| teammate           | membre de l'équipe                             |
| agent, machine     | agent, machine                                 |
| online, offline    | en ligne, hors ligne                           |
| paused, resume     | en pause, reprendre                            |
| token (auth)       | jeton                                          |
| tokens (usage)     | jetons (_jetons pondérés_ for weighted tokens) |
| usage              | consommation                                   |
| 5-hour window      | fenêtre de 5 h                                 |
| model              | modèle                                         |
| template           | modèle de tâche (_modèle_ when unambiguous)    |
| built-in, shared   | intégré, partagé                               |
| log                | journal                                        |
| settings           | paramètres                                     |
| sign in, sign out  | se connecter, se déconnecter                   |
| setup wizard       | assistant de configuration                     |
| up to date         | à jour                                         |
| review (of a PR)   | relecture                                      |
| merged             | fusionnée                                      |

## Contributing

Use one branch and one pull request per logical change, never push to `main` directly, and make sure `./dev lint`, `./dev typecheck` and `./dev test` pass. Report vulnerabilities privately through GitHub security advisories.
