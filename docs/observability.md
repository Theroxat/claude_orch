# Observability

The server can expose Prometheus metrics and OpenTelemetry traces. Both are **off by default**. An optional Compose override (`deploy/observability/`) starts Prometheus and Grafana with a ready-made dashboard.

## Health endpoints

| Endpoint       | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `GET /healthz` | Liveness: the process answers. `{"status":"ok","version":"..."}`  |
| `GET /readyz`  | Readiness: a `SELECT 1` on the database works, otherwise HTTP 503 |

`/healthz` is public (it is the Docker health check and an uptime-monitor target). `/readyz` is internal: Caddy answers 404 on it, probe it from the Docker network.

## Prometheus metrics

Set `METRICS_ENABLED=true` to serve `GET /metrics` (Prometheus text format). Without it the route answers 404. When `METRICS_TOKEN` is set (16 characters or more, for example `openssl rand -hex 24`), scrapers must send `Authorization: Bearer <token>`.

```{warning}
`/metrics` must never be reachable from the internet. The production Caddy (`deploy/server/routes.caddy`) answers 404 on `/metrics` and `/readyz` whatever the server is configured to do. Scrape `server:3000` from the internal Docker network. If you put another proxy in front, block these paths there too.
```

### Metrics

Default process and Node.js metrics (`process_*`, `nodejs_*`) plus:

| Metric                                  | Type      | Labels                            | Meaning                                                                                                                          |
| --------------------------------------- | --------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `orch_build_info`                       | gauge     | `version`                         | Server version, always 1                                                                                                         |
| `orch_http_request_duration_seconds`    | histogram | `method`, `route`, `status_class` | HTTP latency. `route` is the route template (`/api/tasks/:id`), unknown paths are `unmatched`; `status_class` is `2xx`, `4xx`... |
| `orch_agents_connected`                 | gauge     | `version`                         | Agents connected to this instance by the version they announced (at most 20 distinct, then `other`)                              |
| `orch_tasks`                            | gauge     | `status`                          | Tasks by status, one cheap `GROUP BY`, cached for 15 s                                                                           |
| `orch_dispatcher_tick_duration_seconds` | histogram |                                   | Duration of one dispatcher tick                                                                                                  |
| `orch_offers_sent_total`                | counter   | `kind`                            | Offers (`AUTO_OFFER`) and consent requests sent                                                                                  |
| `orch_offers_accepted_total`            | counter   | `kind`                            | Offers and requests accepted                                                                                                     |
| `orch_offers_refused_total`             | counter   | `reason`                          | `agent_declined`, `member_declined`, `undeliverable_<offline\|paused\|revoked\|no_consent\|access_suspended>`                    |
| `orch_assignments_finished_total`       | counter   | `outcome`, `failure_class`        | `succeeded`, `failed`, `cancelled`, `lost`; failure class (`task`, `env`, `claude_auth`, `rate_limited`, `timeout`) or `none`    |
| `orch_ws_messages_total`                | counter   | `type`                            | Messages received from agents, by protocol message type (`invalid` for unparsable frames)                                        |
| `orch_webhook_deliveries_total`         | counter   | `event`, `result`                 | GitHub webhooks (`processed`, `duplicate`, `failed`) by event name                                                               |
| `orch_notification_deliveries_total`    | counter   | `channel`, `result`               | External notification attempts (`sent`, `retry`, `failed`) by channel                                                            |
| `orch_cluster_leader`                   | gauge     | `lease`                           | 1 when this instance holds the `dispatcher` or `maintenance` leadership ({ref}`multi-instance`)                                  |
| `orch_cluster_leader_changes_total`     | counter   | `lease`, `event`                  | Leadership `acquired`, `lost` or `released` by this instance                                                                     |
| `orch_cluster_peers`                    | gauge     |                                   | Other live server instances this one knows of                                                                                    |
| `orch_cluster_messages_total`           | counter   | `direction`, `kind`               | Messages between instances (`in`, `out`) by kind                                                                                 |

Labels are bounded on purpose: no task, user, project, agent id or raw URL ever becomes a label.

Counters restart from zero when the server restarts; use `rate()` and `increase()`.

### Prometheus and Grafana

`deploy/observability/compose.yaml` adds Prometheus and Grafana to the production stack and turns `METRICS_ENABLED` on:

```sh
cd deploy/server
echo 'GRAFANA_ADMIN_PASSWORD=choose-a-long-password' >> .env
# optional: METRICS_TOKEN=$(openssl rand -hex 24) in .env, used by the server and by Prometheus
docker compose -f compose.yaml -f ../observability/compose.yaml up -d
```

- Prometheus is not published; it scrapes `server:3000/metrics` every 15 s and keeps 15 days (`PROMETHEUS_RETENTION`).
- Grafana listens on `127.0.0.1:3001` only (`GRAFANA_PORT`). Reach it through an SSH tunnel (`ssh -L 3001:127.0.0.1:3001 host`) or your own authenticated proxy.
- The datasource and the **orch overview** dashboard (`deploy/observability/grafana/dashboards/orch.json`) are provisioned automatically: request rate and latency, agents by version, tasks by status, dispatcher tick, offers, assignment outcomes, WebSocket and webhook traffic, process CPU and memory.

The Prometheus and Grafana images are pinned to exact versions in the override (kept up to date by Renovate). Grafana has no anonymous access and sign-up is disabled.

## Tracing (OpenTelemetry)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (for example `http://otel-collector:4318`, OTLP over HTTP) in the `server` environment to export traces. While it is unset the OpenTelemetry packages are never loaded, so there is no overhead.

The auto-instrumentations cover incoming and outgoing HTTP, Fastify and PostgreSQL (`pg`, which Prisma uses through its driver adapter). The health, readiness and metrics requests are not traced. The standard `OTEL_*` variables (`OTEL_SERVICE_NAME`, default `orch-server`; `OTEL_TRACES_SAMPLER`; `OTEL_EXPORTER_OTLP_HEADERS`...) are honoured by the SDK. Add them to the `server` service in `compose.yaml`.

Agents expose no metrics endpoint of their own: their version shows up in `orch_agents_connected`.
