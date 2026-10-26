/**
 * Rate-limit counters shared by every server instance (table `RateLimitBucket`).
 *
 * One atomic upsert per hit: a fixed window per key, started by the first hit, reset by the first
 * hit after it expired. Used where a limit must hold for the whole deployment (sign-in, OAuth,
 * enrollment, access requests, test notifications: brute force and spam), not for the high-volume
 * tiers whose limits protect one process (see ./rate-limit).
 *
 * The database being unreachable never opens the gate nor fails the request: the hit is counted
 * in this process instead (per-instance limits until the database answers again).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '../db';

export interface Hit {
  /** Hits in the current window, this one included. */
  current: number;
  /** Milliseconds until the window resets. */
  ttl: number;
}

/** In-process fixed windows (the fallback, and the store of the per-instance tiers). */
export class LocalCounter {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly maxKeys = 20_000) {}

  hit(key: string, windowMs: number, now = Date.now()): Hit {
    let h = this.hits.get(key);
    if (!h || h.reset <= now) {
      if (!h && this.hits.size >= this.maxKeys) this.evict(now);
      h = { n: 0, reset: now + windowMs };
    }
    h.n++;
    this.hits.delete(key); // re-inserted last: Map order is the eviction order
    this.hits.set(key, h);
    return { current: h.n, ttl: h.reset - now };
  }

  private evict(now: number): void {
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next().value as string;
      this.hits.delete(oldest);
    }
  }
}

export class SharedCounter {
  private readonly fallback = new LocalCounter();
  private warnedAt = 0;

  constructor(
    private readonly prisma: PrismaClient,
    /** ORCH_CLUSTER_NAME: separate deployments on one database count separately. */
    private readonly namespace: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async hit(key: string, windowMs: number): Promise<Hit> {
    const k = `${this.namespace}:${key}`;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ count: number; ttl: number }>>`
        INSERT INTO "RateLimitBucket" (key, count, "expiresAt")
        VALUES (${k}, 1, now() + make_interval(secs => ${windowMs / 1000}))
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN "RateLimitBucket"."expiresAt" <= now() THEN 1
                       ELSE "RateLimitBucket".count + 1 END,
          "expiresAt" = CASE WHEN "RateLimitBucket"."expiresAt" <= now() THEN EXCLUDED."expiresAt"
                             ELSE "RateLimitBucket"."expiresAt" END
        RETURNING count,
          GREATEST(0, ceil(extract(epoch FROM ("expiresAt" - now())) * 1000))::int AS ttl`;
      const r = rows[0];
      if (r) return { current: r.count, ttl: r.ttl };
    } catch (err) {
      if (Date.now() - this.warnedAt > 60_000) {
        this.warnedAt = Date.now();
        this.log.warn({ err }, 'shared rate limit unavailable: counting in this instance only');
      }
    }
    return this.fallback.hit(k, windowMs);
  }
}

/** `allow(key)`: true while the key stayed within `max` hits in the window, on every instance. */
export class SharedRateLimiter {
  constructor(
    private readonly counter: SharedCounter,
    private readonly name: string,
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  async allow(key: string): Promise<boolean> {
    const r = await this.counter.hit(`${this.name}:${key}`, this.windowMs);
    return r.current <= this.max;
  }
}

type StoreCallback = (err: Error | null, res?: { current: number; ttl: number }) => void;

/**
 * Store for @fastify/rate-limit: keys for which `shared(key)` is true are counted in Postgres,
 * the others in this process. (A class: the plugin instantiates it.)
 */
export function hybridRateLimitStore(counter: SharedCounter, shared: (key: string) => boolean) {
  const local = new LocalCounter();
  return class HybridStore {
    incr(key: string, cb: StoreCallback, timeWindow: number): void {
      if (!shared(key)) {
        cb(null, local.hit(key, timeWindow));
        return;
      }
      counter.hit(key, timeWindow).then(
        (r) => cb(null, r),
        (err: Error) => cb(err),
      );
    }

    child(): HybridStore {
      return this;
    }
  };
}
