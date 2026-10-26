import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '../db';

/** The task statuses of the `orch_tasks` gauge, set to 0 when empty so the series never vanish. */
const TASK_STATUSES = [
  'PROPOSED',
  'TODO',
  'BLOCKED',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
  'CANCELLED',
] as const;

/** `orch_tasks` is refreshed at most this often, however often Prometheus scrapes. */
export const TASK_GAUGE_TTL_MS = 15_000;
/** Distinct agent versions exported before the rest is folded into `other` (bounded labels). */
const MAX_VERSION_LABELS = 20;

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface MetricsSources {
  prisma?: PrismaClient;
  log: FastifyBaseLogger;
  /** Live agents per reported version (see AgentGateway.connectedByVersion). */
  agentVersions?: () => Map<string, number>;
}

/**
 * Per-app Prometheus registry. Labels are bounded on purpose: route templates (never raw URLs),
 * status classes, enum values, agent versions. Never ids, paths, users or free text.
 */
export class Metrics {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<'method' | 'route' | 'status_class'>;
  readonly dispatcherTick: Histogram;
  readonly offersSent: Counter<'kind'>;
  readonly offersAccepted: Counter<'kind'>;
  readonly offersRefused: Counter<'reason'>;
  readonly assignmentsFinished: Counter<'outcome' | 'failure_class'>;
  readonly wsMessages: Counter<'type'>;
  readonly webhookDeliveries: Counter<'event' | 'result'>;
  readonly clusterLeader: Gauge<'lease'>;
  readonly clusterLeaderChanges: Counter<'lease' | 'event'>;
  readonly clusterMessages: Counter<'direction' | 'kind'>;
  readonly clusterPeers: Gauge;
  readonly notificationJobs: Counter<'channel' | 'result'>;
  readonly repoAccessChecks: Counter<'result'>;
  private sources: MetricsSources | undefined;
  private tasksFetchedAt = 0;
  private tasksCache: Record<string, number> = {};

  constructor(version: string) {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry });

    new Gauge({
      name: 'orch_build_info',
      help: 'Server version (always 1).',
      labelNames: ['version'],
      registers,
    }).set({ version }, 1);

    this.httpDuration = new Histogram({
      name: 'orch_http_request_duration_seconds',
      help: 'HTTP request duration by route template, method and status class.',
      labelNames: ['method', 'route', 'status_class'],
      buckets: SECONDS,
      registers,
    });
    this.dispatcherTick = new Histogram({
      name: 'orch_dispatcher_tick_duration_seconds',
      help: 'Duration of one dispatcher tick.',
      buckets: SECONDS,
      registers,
    });
    this.offersSent = new Counter({
      name: 'orch_offers_sent_total',
      help: 'Offers and consent requests created and sent, by kind.',
      labelNames: ['kind'],
      registers,
    });
    this.offersAccepted = new Counter({
      name: 'orch_offers_accepted_total',
      help: 'Offers and consent requests accepted, by kind.',
      labelNames: ['kind'],
      registers,
    });
    this.offersRefused = new Counter({
      name: 'orch_offers_refused_total',
      help: 'Offers declined by the member or agent, or undeliverable, by reason.',
      labelNames: ['reason'],
      registers,
    });
    this.assignmentsFinished = new Counter({
      name: 'orch_assignments_finished_total',
      help: 'Finished assignments by outcome (succeeded, failed, cancelled, lost) and failure class.',
      labelNames: ['outcome', 'failure_class'],
      registers,
    });
    this.wsMessages = new Counter({
      name: 'orch_ws_messages_total',
      help: 'Messages received from agents over WebSocket, by message type.',
      labelNames: ['type'],
      registers,
    });
    this.webhookDeliveries = new Counter({
      name: 'orch_webhook_deliveries_total',
      help: 'GitHub webhook deliveries by event and result.',
      labelNames: ['event', 'result'],
      registers,
    });

    this.clusterLeader = new Gauge({
      name: 'orch_cluster_leader',
      help: 'Leaderships held by this instance (1) or not (0), by lease (dispatcher, maintenance).',
      labelNames: ['lease'],
      registers,
    });
    this.clusterLeaderChanges = new Counter({
      name: 'orch_cluster_leader_changes_total',
      help: 'Leadership changes on this instance, by lease and event (acquired, lost, released).',
      labelNames: ['lease', 'event'],
      registers,
    });
    this.clusterMessages = new Counter({
      name: 'orch_cluster_messages_total',
      help: 'Cross-instance messages sent (out) and received (in), by kind.',
      labelNames: ['direction', 'kind'],
      registers,
    });
    this.clusterPeers = new Gauge({
      name: 'orch_cluster_peers',
      help: 'Other live server instances this instance knows of.',
      registers,
    });
    this.notificationJobs = new Counter({
      name: 'orch_notification_deliveries_total',
      help: 'External notification delivery attempts, by channel and result (sent, retry, failed).',
      labelNames: ['channel', 'result'],
      registers,
    });
    this.repoAccessChecks = new Counter({
      name: 'orch_repo_access_checks_total',
      help: 'Repository access checks that went to GitHub, by result (refreshed, denied, grace, outage_denied, invalidated).',
      labelNames: ['result'],
      registers,
    });

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    new Gauge({
      name: 'orch_agents_connected',
      help: 'Agents connected to this instance, by reported agent version.',
      labelNames: ['version'],
      registers,
      collect() {
        this.reset();
        const byVersion = self.sources?.agentVersions?.();
        if (!byVersion) return;
        const out = new Map<string, number>();
        for (const [v, n] of byVersion) {
          const key = out.has(v) || out.size < MAX_VERSION_LABELS ? v : 'other';
          out.set(key, (out.get(key) ?? 0) + n);
        }
        for (const [v, n] of out) this.set({ version: v }, n);
      },
    });
    new Gauge({
      name: 'orch_tasks',
      help: 'Tasks by status (refreshed at most every 15 s).',
      labelNames: ['status'],
      registers,
      async collect() {
        const counts = await self.taskCounts();
        this.reset();
        for (const s of TASK_STATUSES) this.set({ status: s }, counts[s] ?? 0);
      },
    });
  }

  /** Wires the data sources once the app is built (the gauges read them at scrape time). */
  attach(sources: MetricsSources): void {
    this.sources = sources;
  }

  private async taskCounts(): Promise<Record<string, number>> {
    const prisma = this.sources?.prisma;
    if (!prisma) return {};
    if (Date.now() - this.tasksFetchedAt < TASK_GAUGE_TTL_MS) return this.tasksCache;
    try {
      const rows = await prisma.task.groupBy({ by: ['status'], _count: { _all: true } });
      this.tasksCache = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
      this.tasksFetchedAt = Date.now();
    } catch (err) {
      this.sources?.log.warn({ err }, 'metrics: task counts failed');
    }
    return this.tasksCache;
  }
}

/** `2xx`, `4xx`, ... : never the exact status code. */
export function statusClass(code: number): string {
  return `${Math.floor(code / 100)}xx`;
}

/** Agent versions come from the agent itself: keep only a sane, short, version-like value. */
export function versionLabel(v: string | undefined): string {
  return v && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(v) ? v : 'unknown';
}
