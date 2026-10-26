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
 * - Sealed: any database role may LISTEN or NOTIFY on any channel, so every payload (and every
 *   ClusterMessage row) is AES-256-GCM with a key derived from ORCH_ENCRYPTION_KEY and the cluster
 *   name. A payload that does not open, is malformed, too old or seen before is dropped: nobody
 *   without the key can read live logs off the channel or make an instance act (send to an agent,
 *   disconnect it...), and a captured message cannot be replayed.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
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
  /** Sender clock (epoch ms): a message older than MAX_AGE_MS is dropped (replay window). */
  ts: number;
}

export type BusHandler = (data: never, from: string) => unknown;

/** Below the 8000-byte NOTIFY limit, with room for the channel name. */
const MAX_INLINE_BYTES = 7_800;
/** Messages are read within milliseconds; this also absorbs clock skew between hosts. */
const MAX_AGE_MS = 60_000;
/** Wire format version (first character of every payload). */
const WIRE = '1';

/** The bus key of a cluster: HKDF of the server secret, one key per cluster name. */
export function busKey(secret: string | undefined, cluster: string): Buffer {
  const ikm = Buffer.from(secret ?? 'orch-cluster-unkeyed', 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, '', `orch:cluster-bus:${cluster}`, 32));
}

function parseEnvelope(v: unknown): Envelope | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  const str = (x: unknown, max: number) => typeof x === 'string' && x.length > 0 && x.length <= max;
  const opt = (x: unknown, max: number) => x === undefined || str(x, max);
  if (!str(e.f, 128) || !str(e.k, 64) || !opt(e.t, 128) || !opt(e.r, 64) || !opt(e.ref, 64)) {
    return null;
  }
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return null;
  return e as unknown as Envelope;
}

export class RpcError extends Error {}

export interface BusOptions {
  prisma: PrismaClient;
  instanceId: string;
  channel: string;
  log: FastifyBaseLogger;
  metrics?: Metrics;
  /** Whether another live instance exists; broadcasts are skipped when not (no cost when alone). */
  hasPeers: () => boolean;
  /** ORCH_ENCRYPTION_KEY: the bus key derives from it (and the cluster name). */
  secret?: string;
  /** ORCH_CLUSTER_NAME. */
  cluster: string;
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
  private readonly key: Buffer;
  private readonly aad: Buffer;
  /** IVs of the messages opened within MAX_AGE_MS (replay guard), oldest first. */
  private readonly seen = new Map<string, number>();
  private droppedWarnAt = 0;

  constructor(private readonly o: BusOptions) {
    this.key = busKey(o.secret, o.cluster);
    this.aad = Buffer.from(o.channel);
  }

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
    const head = this.open(raw);
    if (!head) return;
    if (head.f === this.o.instanceId || (head.t && head.t !== this.o.instanceId)) return;
    this.recvChain = this.recvChain
      .then(async () => {
        let env: Envelope | null = head;
        if (head.ref) {
          const row = await this.o.prisma.clusterMessage.findUnique({ where: { id: head.ref } });
          if (!row) return;
          env = this.open(row.payload);
          if (!env || env.f !== head.f || env.k !== head.k) return;
        }
        this.dispatch(env);
      })
      .catch((err) => this.o.log.warn({ err }, 'cluster: message dropped'));
  }

  /** Seals an envelope: WIRE + base64(iv | tag | AES-256-GCM(JSON)). */
  private seal(env: Envelope): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(this.aad);
    const ct = Buffer.concat([c.update(JSON.stringify(env), 'utf8'), c.final()]);
    return WIRE + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  /** The envelope of a sealed payload, or null (forged, malformed, too old, replayed). */
  private open(raw: string): Envelope | null {
    let env: Envelope | null = null;
    let iv = '';
    try {
      if (raw.startsWith(WIRE)) {
        const b = Buffer.from(raw.slice(WIRE.length), 'base64');
        if (b.length > 28) {
          const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
          d.setAAD(this.aad);
          d.setAuthTag(b.subarray(12, 28));
          const text = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
          env = parseEnvelope(JSON.parse(text));
          iv = b.subarray(0, 12).toString('base64');
        }
      }
    } catch {
      env = null;
    }
    const now = Date.now();
    if (!env || Math.abs(now - env.ts) > MAX_AGE_MS || this.seen.has(iv)) {
      this.o.metrics?.clusterMessages.inc({ direction: 'in', kind: 'rejected' });
      if (now - this.droppedWarnAt > 60_000) {
        this.droppedWarnAt = now;
        this.o.log.warn(
          { channel: this.o.channel },
          'cluster: message rejected (not sealed with this cluster key, too old or replayed)',
        );
      }
      return null;
    }
    for (const [k, exp] of this.seen) {
      if (exp > now && this.seen.size < 100_000) break;
      this.seen.delete(k);
    }
    this.seen.set(iv, now + 2 * MAX_AGE_MS);
    return env;
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
      const d = env.d as { ok?: unknown; v?: unknown; e?: string } | null | undefined;
      if (d?.ok === true) p.resolve(d.v);
      else p.reject(new RpcError(typeof d?.e === 'string' ? d.e : 'remote error'));
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

  private send(env: Omit<Envelope, 'ts'>): Promise<void> {
    const p = this.sendChain.then(async () => {
      if (this.stopped && env.k !== '_reply' && env.k !== 'instance.down') return;
      const ts = Date.now();
      let payload = this.seal({ ...env, ts });
      if (payload.length > MAX_INLINE_BYTES) {
        const row = await this.o.prisma.clusterMessage.create({ data: { payload } });
        payload = this.seal({ f: env.f, ...(env.t && { t: env.t }), k: env.k, ref: row.id, ts });
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
