/**
 * The one dedicated Postgres connection of an instance (outside Prisma's pool): it LISTENs on the
 * cluster channel and holds the session-level advisory locks of the leaderships. Both die with
 * the connection, so a lost connection means "no leadership, maybe missed messages": listeners of
 * `down` step down at once, listeners of `up` resynchronise after a reconnect.
 */
import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';

export interface LinkOptions {
  url: string;
  channel: string;
  log: FastifyBaseLogger;
  /** Called for every notification on the channel, in arrival order. */
  onNotify: (payload: string) => void;
  /** First reconnect delay; doubles up to 10 s. */
  retryMs?: number;
  /** A query on this connection slower than this resets it (half-open TCP, stuck backend). */
  queryTimeoutMs?: number;
}

export class ClusterLink extends EventEmitter<{ up: []; down: [] }> {
  private client: pg.Client | undefined;
  private isUp = false;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private backoff: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: LinkOptions) {
    super();
    this.backoff = o.retryMs ?? 500;
  }

  get up(): boolean {
    return this.isUp;
  }

  /** Connects once (never throws); later failures reconnect in the background. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const c = this.client;
    this.client = undefined;
    const was = this.isUp;
    this.isUp = false;
    if (was) this.emit('down');
    if (c) await c.end().catch(() => undefined);
  }

  /** Runs a query on the dedicated connection. Throws when it is down or too slow (and resets it). */
  query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<R[]> {
    // One query at a time on the connection (pg 9 refuses concurrent ones).
    const p = this.queue.then(() => this.run<R>(text, values));
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async run<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<R[]> {
    const c = this.client;
    if (!c || !this.isUp) throw new Error('cluster connection is down');
    const ms = this.o.queryTimeoutMs ?? 5_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const res = await Promise.race([
        c.query<R>(text, values),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`cluster query timed out after ${ms} ms`)), ms);
        }),
      ]);
      return res.rows;
    } catch (err) {
      this.fail(c, err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drops the connection (and with it every advisory lock), then reconnects. */
  reset(reason: string): void {
    if (this.client) this.fail(this.client, new Error(reason));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const c = new pg.Client({
      connectionString: this.o.url,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'orch-cluster',
    });
    this.client = c;
    c.on('error', (err) => this.fail(c, err));
    c.on('end', () => this.fail(c, new Error('connection ended')));
    c.on('notification', (n) => {
      if (this.client === c && n.channel === this.o.channel && n.payload)
        this.o.onNotify(n.payload);
    });
    try {
      await c.connect();
      // Postgres must notice quickly when this process vanishes without closing the socket (host
      // crash, partition): only then does it release the advisory locks for another instance.
      // ~25 s instead of the OS default of 2 h. No-ops on a Unix socket.
      await c
        .query(
          'SET tcp_keepalives_idle = 10; SET tcp_keepalives_interval = 5; SET tcp_keepalives_count = 3',
        )
        .catch(() => undefined);
      // The channel name is generated (letters, digits, underscore), never user input.
      await c.query(`LISTEN ${this.o.channel}`);
    } catch (err) {
      this.fail(c, err);
      return;
    }
    if (this.client !== c || this.stopped) {
      await c.end().catch(() => undefined);
      return;
    }
    this.isUp = true;
    this.backoff = this.o.retryMs ?? 500;
    this.emit('up');
  }

  private fail(c: pg.Client, err: unknown): void {
    if (this.client !== c) return;
    this.client = undefined;
    const was = this.isUp;
    this.isUp = false;
    c.end().catch(() => undefined);
    if (was) {
      this.o.log.warn({ err }, 'cluster: dedicated database connection lost');
      this.emit('down');
    } else if (!this.stopped) {
      this.o.log.warn({ err }, 'cluster: cannot open the dedicated database connection');
    }
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.backoff);
    this.retryTimer.unref();
    this.backoff = Math.min(this.backoff * 2, 10_000);
  }
}
