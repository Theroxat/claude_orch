/**
 * Cross-instance messages over Postgres LISTEN/NOTIFY.
 *
 * - Sent with `pg_notify` through Prisma's pool, one at a time per instance: Postgres delivers
 *   notifications in commit order, so every receiver sees one sender's messages in send order.
 * - Received on the instance's dedicated connection (./link) and handled one at a time, in order.
 * - A message larger than a NOTIFY payload allows (8000 bytes) is stored in `ClusterMessage` and
 *   the notification carries its id.
 * - Delivery is at most once: a message sent while an instance is disconnected is lost for it.
 *   Every user of the bus therefore keeps the truth in the database (or resynchronises on `up`)
 *   and uses messages only to act sooner.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '../db';
import type { Metrics } from '../observability';

/** Wire format. Short keys: the NOTIFY payload is small. */
interface Envelope {
  /** Sender instance. */
  f: string;
  /** Recipient instance; absent: every instance. */
  t?: string;
  /** Message kind. */
  k: string;
  d?: unknown;
  /** Request id (RPC); on a `_reply`, the request it answers. */
  r?: string;
  /** Id of the ClusterMessage row that holds the full envelope. */
  ref?: string;
}

export type BusHandler = (data: never, from: string) => unknown;

/** Below the 8000-byte NOTIFY limit, with room for the channel name. */
const MAX_INLINE_BYTES = 7_800;

export class RpcError extends Error {}

export interface BusOptions {
  prisma: PrismaClient;
  instanceId: string;
  channel: string;
  log: FastifyBaseLogger;
  metrics?: Metrics;
  /** Whether another live instance exists; broadcasts are skipped when not (no cost when alone). */
  hasPeers: () => boolean;
}

export class ClusterBus {
  private readonly handlers = new Map<string, BusHandler>();
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private sendChain: Promise<unknown> = Promise.resolve();
  private recvChain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly o: BusOptions) {}

  get instanceId(): string {
    return this.o.instanceId;
  }

  /** One handler per kind. Its return value (or promise) answers a `request`. */
  on<T>(kind: string, handler: (data: T, from: string) => unknown): void {
    this.handlers.set(kind, handler as BusHandler);
  }

  /** Sends to one instance (`to`) or to every other instance. Resolves once sent; never throws. */
  publish(kind: string, data?: unknown, to?: string): Promise<void> {
    if (this.stopped || (!to && !this.o.hasPeers())) return Promise.resolve();
    return this.send({ f: this.o.instanceId, k: kind, ...(to && { t: to }), d: data });
  }

  /** Asks one instance and waits for its answer (RpcError on timeout or a handler error). */
  request<T>(to: string, kind: string, data: unknown, timeoutMs = 5_000): Promise<T> {
    const r = randomUUID();
    const p = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(r);
        reject(new RpcError(`no answer from ${to} to ${kind} within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(r, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    void this.send({ f: this.o.instanceId, t: to, k: kind, d: data, r });
    return p;
  }

  /** Raw notification payload from the dedicated connection. */
  receive(raw: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (env.f === this.o.instanceId || (env.t && env.t !== this.o.instanceId)) return;
    this.recvChain = this.recvChain
      .then(async () => {
        if (env.ref) {
          const row = await this.o.prisma.clusterMessage.findUnique({ where: { id: env.ref } });
          if (!row) return;
          env = JSON.parse(row.payload) as Envelope;
        }
        this.dispatch(env);
      })
      .catch((err) => this.o.log.warn({ err }, 'cluster: message dropped'));
  }

  stop(): void {
    this.stopped = true;
    for (const [r, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError('cluster stopped'));
      this.pending.delete(r);
    }
  }

  private dispatch(env: Envelope): void {
    this.o.metrics?.clusterMessages.inc({ direction: 'in', kind: metricKind(env.k) });
    if (env.k === '_reply') {
      const p = env.r ? this.pending.get(env.r) : undefined;
      if (!p) return;
      this.pending.delete(env.r!);
      clearTimeout(p.timer);
      const d = env.d as { ok: boolean; v?: unknown; e?: string };
      if (d.ok) p.resolve(d.v);
      else p.reject(new RpcError(d.e ?? 'remote error'));
      return;
    }
    const h = this.handlers.get(env.k);
    if (!h) {
      if (env.r) void this.reply(env, { ok: false, e: `no handler for ${env.k}` });
      return;
    }
    let out: unknown;
    try {
      out = h(env.d as never, env.f);
    } catch (err) {
      this.o.log.warn({ err, kind: env.k }, 'cluster: handler failed');
      if (env.r)
        void this.reply(env, { ok: false, e: err instanceof Error ? err.message : 'error' });
      return;
    }
    if (!env.r) {
      if (out instanceof Promise) {
        out.catch((err: unknown) =>
          this.o.log.warn({ err, kind: env.k }, 'cluster: handler failed'),
        );
      }
      return;
    }
    Promise.resolve(out).then(
      (v) => this.reply(env, { ok: true, v }),
      (err: unknown) =>
        this.reply(env, { ok: false, e: err instanceof Error ? err.message : 'error' }),
    );
  }

  private reply(req: Envelope, d: { ok: boolean; v?: unknown; e?: string }): Promise<void> {
    return this.send({ f: this.o.instanceId, t: req.f, k: '_reply', r: req.r, d });
  }

  private send(env: Envelope): Promise<void> {
    const p = this.sendChain.then(async () => {
      if (this.stopped && env.k !== '_reply' && env.k !== 'instance.down') return;
      let payload = JSON.stringify(env);
      if (Buffer.byteLength(payload) > MAX_INLINE_BYTES) {
        const row = await this.o.prisma.clusterMessage.create({ data: { payload } });
        payload = JSON.stringify({ f: env.f, ...(env.t && { t: env.t }), k: env.k, ref: row.id });
      }
      await this.o.prisma.$executeRaw`SELECT pg_notify(${this.o.channel}, ${payload})`;
      this.o.metrics?.clusterMessages.inc({ direction: 'out', kind: metricKind(env.k) });
    });
    this.sendChain = p.catch((err) =>
      this.o.log.warn({ err, kind: env.k }, 'cluster: send failed'),
    );
    return this.sendChain as Promise<void>;
  }
}

/** Bounded label values: the kinds are ours, but never trust a string from the wire. */
function metricKind(k: string): string {
  return /^[a-z_][a-zA-Z.]{0,39}$/.test(k) ? k : 'other';
}
