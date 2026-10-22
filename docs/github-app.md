# Creating the GitHub App

orch signs users in with GitHub and acts on repositories through one GitHub App that you own. Create it at **GitHub -> Settings -> Developer settings -> GitHub Apps -> New GitHub App** (or under your organization's settings). Replace `<domain>` with your `ORCH_DOMAIN`.

| Field                                                  | Value                                        |
| ------------------------------------------------------ | -------------------------------------------- |
| GitHub App name                                        | Anything unique, for example `orch-yourteam` |
| Homepage URL                                           | `https://<domain>`                           |
| Callback URL                                           | `https://<domain>/api/auth/github/callback`  |
| Request user authorization (OAuth) during installation | Enabled                                      |
| Expire user authorization tokens                       | Leave the default                            |
| Webhook -> Active                                      | Enabled                                      |
| Webhook URL                                            | `https://<domain>/api/github/webhook`        |
| Webhook secret                                         | The value of `GITHUB_WEBHOOK_SECRET`         |
| Where can this App be installed?                       | "Only on this account" is enough for a team  |

## Repository permissions

| Permission    | Access                                        |
| ------------- | --------------------------------------------- |
| Contents      | Read & write                                  |
| Pull requests | Read & write                                  |
| Issues        | Read & write                                  |
| Metadata      | Read-only (mandatory, selected automatically) |

## Organization permissions

Set **Members: Read-only** only if you use `ORCH_ALLOWED_GITHUB_ORGS`. orch then calls `GET /user/memberships/orgs/{org}` with the signed-in user's own token. Without the permission, org checks answer "not a member" and everybody is refused. A login-only allowlist (`ORCH_ALLOWED_GITHUB_LOGINS`) needs nothing extra.

## Events

Subscribe to Issues and Pull request, plus the Installation and Installation repositories events that GitHub delivers to every App (`issues`, `pull_request`, `installation`, `installation_repositories`).

## After creating the App

1. Copy the **App ID** to `GITHUB_APP_ID`, and the **slug** from the App's public URL (`github.com/apps/<slug>`) to `GITHUB_APP_SLUG`.
2. Under **Client secrets**, generate one. Put the **Client ID** in `GITHUB_CLIENT_ID` and the secret in `GITHUB_CLIENT_SECRET`.
3. Under **Private keys**, generate one and save the `.pem` as `deploy/server/secrets/github-app.pem` (see {doc}`installation`). It is read-only inside the server container. Never commit it; `*.pem` is git-ignored.
4. Restart: `docker compose up -d`.

```{important}
Because a `Contents: write` installation token can push to any branch, **enable branch protection on your default branches**: orch only pushes `orch/issue-<n>-*` branches and opens PRs, but protection keeps that guarantee even if something goes wrong.
```
