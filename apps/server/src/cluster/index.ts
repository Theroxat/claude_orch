/**
 * Several server instances behind one load balancer, with Postgres as the only shared dependency.
 *
 * One `Cluster` per app instance:
 * - membership: a `ServerInstance` row refreshed every ORCH_INSTANCE_HEARTBEAT_MS;
 * - a dedicated connection (./link) for LISTEN/NOTIFY (./bus) and advisory locks (./leadership);
 * - the agent directory (./directory): which instance holds which agent's socket;
 * - the `maintenance` leadership: one instance runs the retention purges and the cleanup below.
 *
 * Alone (a single instance), it costs a heartbeat query per period and one write per agent
 * connect / disconnect; no message is sent and nothing is added to request paths.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import type { PrismaClient } from '../db';
import type { Metrics } from '../observability';
import { ClusterBus } from './bus';
import { AgentDirectory } from './directory';
import { Leadership, type LeaseName } from './leadership';
import { ClusterLink } from './link';

export { RpcError } from './bus';
export type { ClusterBus } from './bus';
export type { AgentDirectory, LocalSockets, Presence } from './directory';
export type { LeaseName } from './leadership';

/** Large-message rows are read within seconds; anything older is garbage. */
const CLUSTER_MESSAGE_TTL_MS = 10 * 60_000;
/** An instance silent this long is deleted (with its agent connection rows). */
const INSTANCE_PURGE_MS = 10 * 60_000;
const MAINTENANCE_EVERY_MS = 60_000;

/** 31-bit FNV-1a: a stable positive int4 for the advisory lock space of a cluster name. */
export function lockClassOf(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(`orch-cluster:${name}`)) {
    h ^= ch;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}

/** LISTEN channel of a cluster name: an identifier, no quoting needed. */
export function channelOf(name: string): string {
  return name === 'orch' ? 'orch_cluster' : `orch_cluster_${lockClassOf(name).toString(36)}`;
}

export interface ClusterDeps {
  prisma: PrismaClient;
  config: Config;
  log: FastifyBaseLogger;
  metrics?: Metrics;
}

export class Cluster {
  readonly instanceId: string;
  readonly name: string;
  readonly bus: ClusterBus;
  readonly link: ClusterLink;
  readonly leadership: Leadership;
  readonly directory: AgentDirectory;
  private readonly peers = new Set<string>();
  private readonly liveWindowMs: number;
  private timer: NodeJS.Timeout | undefined;
  private lastMaintenance = 0;
  private started = false;
  private stopped = false;
  private beating: Promise<void> | null = null;
  /** Extra jobs run by the maintenance leader (registered by other modules). */
  private readonly maintenanceJobs: Array<() => Promise<unknown>> = [];

  constructor(private readonly deps: ClusterDeps) {
    const { config, prisma, log, metrics } = deps;
    this.instanceId = config.ORCH_INSTANCE_ID;
    this.name = config.ORCH_CLUSTER_NAME;
    this.liveWindowMs = 3 * config.ORCH_INSTANCE_HEARTBEAT_MS;
    const channel = channelOf(this.name);
    this.bus = new ClusterBus({
      prisma,
      instanceId: this.instanceId,
      channel,
      log,
      metrics,
      hasPeers: () => this.peers.size > 0,
    });
    this.link = new ClusterLink({
      url: config.DATABASE_URL,
      channel,
      log,
      onNotify: (payload) => this.bus.receive(payload),
    });
    this.leadership = new Leadership({
      link: this.link,
      lockClass: lockClassOf(this.name),
      retryMs: config.ORCH_LEADER_RETRY_MS,
      instanceId: this.instanceId,
      log,
      metrics,
    });
    this.directory = new AgentDirectory({
      prisma,
      bus: this.bus,
      instanceId: this.instanceId,
      cluster: this.name,
      log,
      liveWindowMs: this.liveWindowMs,
      ensureInstance: () => this.upsertInstance().then(() => undefined),
    });

    this.bus.on('instance.up', (_d, from) => {
      this.addPeer(from);
    });
    this.bus.on('instance.down', (_d, from) => {
      this.peers.delete(from);
      this.deps.metrics?.clusterPeers.set(this.peers.size);
      this.directory.dropInstance(from);
    });
    // Anything may have been missed while the connection was down: reload from the database.
    this.link.on('up', () => {
      if (this.started) void this.beat();
    });
  }

  /** Other live instances of this cluster are known. */
  hasPeers(): boolean {
    return this.peers.size > 0;
  }

  peerIds(): string[] {
    return [...this.peers];
  }

  /** Whether this instance currently holds a leadership. */
  leads(name: LeaseName): boolean {
    return this.leadership.isLeader(name);
  }

  /** Registers a cleanup run about once a minute by the maintenance leader. */
  onMaintenance(job: () => Promise<unknown>): void {
    this.maintenanceJobs.push(job);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    const { prisma, log, config } = this.deps;
    try {
      // Rows left by a previous run of this instance id: it holds no socket yet.
      await this.upsertInstance();
      await prisma.agentConnection.deleteMany({ where: { instanceId: this.instanceId } });
    } catch (err) {
      // The database is unreachable: start anyway, the heartbeat retries (and /readyz says 503).
      log.warn({ err }, 'cluster: instance registration failed');
    }
    await this.link.start();
    await this.refreshPeers().catch((err) => log.warn({ err }, 'cluster: peer list load'));
    await this.directory.refresh().catch((err) => log.warn({ err }, 'cluster: directory load'));
    await this.bus.publish('instance.up');
    this.leadership.start();
    await this.leadership.want('maintenance');
    this.timer = setInterval(() => void this.beat(), config.ORCH_INSTANCE_HEARTBEAT_MS);
    this.timer.unref();
    log.info(
      { instanceId: this.instanceId, cluster: this.name, peers: this.peers.size },
      'cluster: instance started',
    );
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await this.beating;
    await this.leadership.stop();
    await this.bus.publish('instance.down');
    this.bus.stop();
    this.directory.stop();
    // Cascades to this instance's agent connection rows: the others see its agents go at once.
    try {
      await this.deps.prisma.serverInstance.deleteMany({ where: { id: this.instanceId } });
    } catch (err) {
      this.deps.log.warn({ err }, 'cluster: instance row not removed');
    }
    await this.link.stop();
  }

  /** Heartbeat, peer list, directory reload, maintenance when leader. Never throws. */
  beat(): Promise<void> {
    if (this.beating) return this.beating;
    this.beating = (async () => {
      try {
        if (this.stopped) return;
        const created = await this.upsertInstance();
        if (created) await this.directory.reannounce();
        await this.refreshPeers();
        await this.directory.refresh();
        if (
          this.leads('maintenance') &&
          Date.now() - this.lastMaintenance >= MAINTENANCE_EVERY_MS
        ) {
          this.lastMaintenance = Date.now();
          await this.maintenance();
        }
      } catch (err) {
        this.deps.log.warn({ err }, 'cluster: heartbeat failed');
      } finally {
        this.beating = null;
      }
    })();
    return this.beating;
  }

  /** Upserts this instance's row with the database clock. True when the row was (re)created. */
  private async upsertInstance(): Promise<boolean> {
    const rows = await this.deps.prisma.$queryRaw<Array<{ created: boolean }>>`
      INSERT INTO "ServerInstance" (id, cluster, version, "startedAt", "heartbeatAt")
      VALUES (${this.instanceId}, ${this.name}, ${this.deps.config.ORCH_VERSION}, now(), now())
      ON CONFLICT (id) DO UPDATE SET "heartbeatAt" = now(), cluster = EXCLUDED.cluster,
        version = EXCLUDED.version
      RETURNING (xmax = 0) AS created`;
    return rows[0]?.created === true;
  }

  private async refreshPeers(): Promise<void> {
    const rows = await this.deps.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ServerInstance"
       WHERE cluster = ${this.name} AND id <> ${this.instanceId}
         AND "heartbeatAt" > now() - make_interval(secs => ${this.liveWindowMs / 1000})`;
    const live = new Set(rows.map((r) => r.id));
    for (const id of this.peers) {
      if (!live.has(id)) {
        this.peers.delete(id);
        this.directory.dropInstance(id);
      }
    }
    for (const id of live) this.peers.add(id);
    this.deps.metrics?.clusterPeers.set(this.peers.size);
  }

  private addPeer(id: string): void {
    if (this.peers.has(id)) return;
    this.peers.add(id);
    this.deps.metrics?.clusterPeers.set(this.peers.size);
    this.deps.log.info({ peer: id }, 'cluster: instance joined');
  }

  private async maintenance(): Promise<void> {
    const { prisma } = this.deps;
    const now = Date.now();
    await prisma.clusterMessage.deleteMany({
      where: { createdAt: { lt: new Date(now - CLUSTER_MESSAGE_TTL_MS) } },
    });
    await prisma.$executeRaw`DELETE FROM "ServerInstance"
      WHERE "heartbeatAt" < now() - make_interval(secs => ${INSTANCE_PURGE_MS / 1000})`;
    await prisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE "expiresAt" < now()`;
    for (const job of this.maintenanceJobs) {
      await job().catch((err: unknown) => this.deps.log.warn({ err }, 'cluster: maintenance job'));
    }
  }
}
