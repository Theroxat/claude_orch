/**
 * Leader election for the singleton loops, with session-level Postgres advisory locks held on the
 * instance's dedicated connection (./link): `pg_try_advisory_lock(cluster key, lease)`.
 *
 * - A follower tries every ORCH_LEADER_RETRY_MS (and at once after a reconnect).
 * - The leader checks on the same schedule that its connection still holds the lock. A failed or
 *   slow check resets the connection, which releases the lock server-side, then steps down:
 *   the instance never keeps acting as leader on a connection it cannot vouch for.
 * - A lost connection steps down at once. Postgres releases the lock when the backend notices the
 *   client is gone; until then nobody else can take it (a delayed failover, never two leaders
 *   holding the lock). The loops behind it are safe to overlap anyway (row locks, unique indexes).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Metrics } from '../observability';
import type { ClusterLink } from './link';

/** Second half of the lock key, one per singleton job. */
export const LEASES = { dispatcher: 1, maintenance: 2 } as const;
export type LeaseName = keyof typeof LEASES;

export interface LeaseCallbacks {
  onAcquire?: () => void;
  onLose?: () => void;
}

interface Lease {
  name: LeaseName;
  held: boolean;
  callbacks: LeaseCallbacks[];
}

export interface LeadershipOptions {
  link: ClusterLink;
  /** First half of the lock key (from ORCH_CLUSTER_NAME): one lock space per cluster. */
  lockClass: number;
  retryMs: number;
  instanceId: string;
  log: FastifyBaseLogger;
  metrics?: Metrics;
}

export class Leadership {
  private readonly leases = new Map<LeaseName, Lease>();
  private timer: NodeJS.Timeout | undefined;
  private round: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly o: LeadershipOptions) {
    o.link.on('down', () => this.loseAll('connection lost'));
    o.link.on('up', () => void this.runRound());
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.runRound(), this.o.retryMs);
    this.timer.unref();
  }

  /** Competes for a lease from now on; resolves after the first attempt. */
  async want(name: LeaseName, callbacks: LeaseCallbacks = {}): Promise<void> {
    let lease = this.leases.get(name);
    if (!lease) {
      lease = { name, held: false, callbacks: [] };
      this.leases.set(name, lease);
      this.o.metrics?.clusterLeader.set({ lease: name }, 0);
    }
    lease.callbacks.push(callbacks);
    if (lease.held) callbacks.onAcquire?.();
    else await this.runRound();
  }

  isLeader(name: LeaseName): boolean {
    return this.leases.get(name)?.held === true;
  }

  /**
   * Fencing before a leader acts: true only after the database confirmed, just now, that this
   * instance's connection still holds the lease. Between two periodic checks the lock may be gone
   * (backend terminated, connection half-open and killed by Postgres' keepalives, an unlock):
   * a check that fails or comes back without the lock steps down at once, so the leader never
   * starts a round of work on a lease another instance may already hold.
   */
  async confirm(name: LeaseName): Promise<boolean> {
    const lease = this.leases.get(name);
    if (!lease?.held || this.stopped) return false;
    try {
      const [row] = await this.o.link.query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
              AND classid = $1::int::oid AND objid = $2::int::oid AND objsubid = 2) AS ok`,
        [this.o.lockClass, LEASES[name]],
      );
      if (row?.ok === true) return lease.held;
      this.setHeld(lease, false, 'lost', 'fencing check');
    } catch (err) {
      this.o.log.warn({ err }, 'cluster: leadership check failed');
      this.loseAll('check failed');
    }
    return false;
  }

  /** Releases every lease (another instance takes over within its retry delay). */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.round;
    for (const lease of this.leases.values()) {
      if (!lease.held) continue;
      await this.o.link
        .query('SELECT pg_advisory_unlock($1::int, $2::int)', [
          this.o.lockClass,
          LEASES[lease.name],
        ])
        .catch(() => undefined);
      this.setHeld(lease, false, 'released');
    }
  }

  private runRound(): Promise<void> {
    if (this.round) return this.round;
    this.round = this.attempt().finally(() => {
      this.round = null;
    });
    return this.round;
  }

  private async attempt(): Promise<void> {
    if (this.stopped || !this.o.link.up || this.leases.size === 0) return;
    const { link, lockClass } = this.o;
    try {
      if ([...this.leases.values()].some((l) => l.held)) {
        const rows = await link.query<{ objid: number }>(
          `SELECT objid::int AS objid FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
              AND classid = $1::int::oid AND objsubid = 2`,
          [lockClass],
        );
        const have = new Set(rows.map((r) => r.objid));
        for (const lease of this.leases.values()) {
          if (lease.held && !have.has(LEASES[lease.name])) this.setHeld(lease, false, 'lost');
        }
      }
      for (const lease of this.leases.values()) {
        if (lease.held || this.stopped) continue;
        const [row] = await link.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock($1::int, $2::int) AS ok',
          [lockClass, LEASES[lease.name]],
        );
        if (row?.ok) {
          if (this.stopped) {
            await link.query('SELECT pg_advisory_unlock($1::int, $2::int)', [
              lockClass,
              LEASES[lease.name],
            ]);
          } else {
            this.setHeld(lease, true, 'acquired');
          }
        }
      }
    } catch (err) {
      // link.query already reset the connection: the locks are gone with it.
      this.o.log.warn({ err }, 'cluster: leadership check failed');
      this.loseAll('check failed');
    }
  }

  private loseAll(why: string): void {
    for (const lease of this.leases.values()) {
      if (lease.held) this.setHeld(lease, false, 'lost', why);
    }
  }

  private setHeld(
    lease: Lease,
    held: boolean,
    event: 'acquired' | 'lost' | 'released',
    why?: string,
  ): void {
    if (lease.held === held) return;
    lease.held = held;
    this.o.metrics?.clusterLeader.set({ lease: lease.name }, held ? 1 : 0);
    this.o.metrics?.clusterLeaderChanges.inc({ lease: lease.name, event });
    const ctx = { lease: lease.name, instanceId: this.o.instanceId, ...(why && { why }) };
    if (event === 'lost') this.o.log.warn(ctx, 'cluster: leadership lost');
    else this.o.log.info(ctx, `cluster: leadership ${event}`);
    for (const cb of lease.callbacks) {
      try {
        if (held) cb.onAcquire?.();
        else cb.onLose?.();
      } catch (err) {
        this.o.log.error({ err, lease: lease.name }, 'cluster: leadership callback failed');
      }
    }
  }
}
