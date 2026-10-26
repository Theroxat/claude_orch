/**
 * Agent directory: which instance holds each agent's WebSocket.
 *
 * The truth is the `AgentConnection` table (one row per helloed agent, written by the instance
 * holding the socket). Every instance keeps an in-memory copy of the rows of the OTHER live
 * instances, so the gateway's "is it online, where" questions stay synchronous and free:
 * - `presence.up` / `presence.down` messages apply a change at once;
 * - a full reload every heartbeat and after a reconnect repairs anything a message missed;
 * - rows of an instance silent for 3 heartbeats are ignored (it crashed), then purged.
 *
 * A newer connection wins: when an agent says hello on instance B while instance A still holds an
 * older socket for it, A closes its socket (SUPERSEDED), as a single instance does locally.
 */
import { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '../db';
import type { ClusterBus } from './bus';

export interface Presence {
  agentId: string;
  userId: string;
  instanceId: string;
  maxConcurrent: number;
  selfUpdate: boolean;
  agentVersion?: string;
  /** Epoch ms when the socket was accepted (newest wins). */
  connectedAt: number;
}

export interface DirectoryOptions {
  prisma: PrismaClient;
  bus: ClusterBus;
  instanceId: string;
  cluster: string;
  log: FastifyBaseLogger;
  /** An instance silent for longer is ignored. */
  liveWindowMs: number;
  /** Re-creates this instance's row when it vanished (purged while this process was stalled). */
  ensureInstance: () => Promise<void>;
}

/** What the gateway tells the directory about its own sockets. */
export interface LocalSockets {
  /** Accept time of the local helloed socket of an agent, if any. */
  localSince(agentId: string): number | undefined;
  /** Closes the local socket: a newer one exists on another instance. */
  supersede(agentId: string): void;
  /** Every local helloed socket (re-announced when this instance's rows were purged). */
  all(): Presence[];
}

export class AgentDirectory {
  private remote = new Map<string, Presence>();
  private chain: Promise<unknown> = Promise.resolve();
  private local: LocalSockets | undefined;
  private stopped = false;

  constructor(private readonly o: DirectoryOptions) {
    o.bus.on<Presence>('presence.up', (p, from) => {
      if (p.instanceId !== from) return;
      this.applyUp(p);
    });
    o.bus.on<{ agentId: string; connectedAt: number }>('presence.down', (p, from) => {
      const cur = this.remote.get(p.agentId);
      if (cur && cur.instanceId === from && cur.connectedAt <= p.connectedAt) {
        this.remote.delete(p.agentId);
      }
    });
  }

  attach(local: LocalSockets): void {
    this.local = local;
  }

  /** The agent's socket on another live instance, if any. */
  get(agentId: string): Presence | undefined {
    return this.remote.get(agentId);
  }

  remoteAgents(): IterableIterator<Presence> {
    return this.remote.values();
  }

  /** Records a local hello and tells the other instances. */
  announce(p: Omit<Presence, 'instanceId'>): Promise<void> {
    const row: Presence = { ...p, instanceId: this.o.instanceId };
    this.remote.delete(p.agentId);
    return this.serial(async () => {
      await this.upsert(row);
      await this.o.bus.publish('presence.up', row);
    });
  }

  /** Records that a local socket closed (no-op when a newer connection replaced the row). */
  withdraw(agentId: string, connectedAt: number): Promise<void> {
    return this.serial(async () => {
      await this.o.prisma.agentConnection.deleteMany({
        where: { agentId, instanceId: this.o.instanceId, connectedAt: new Date(connectedAt) },
      });
      await this.o.bus.publish('presence.down', { agentId, connectedAt });
    });
  }

  /** Reloads the other instances' rows (heartbeat, reconnect). */
  async refresh(): Promise<void> {
    const rows = await this.o.prisma.$queryRaw<
      Array<{
        agentId: string;
        userId: string;
        instanceId: string;
        maxConcurrent: number;
        selfUpdate: boolean;
        agentVersion: string | null;
        connectedAt: Date;
      }>
    >`SELECT c."agentId", c."userId", c."instanceId", c."maxConcurrent", c."selfUpdate",
             c."agentVersion", c."connectedAt"
        FROM "AgentConnection" c JOIN "ServerInstance" i ON i.id = c."instanceId"
       WHERE i.cluster = ${this.o.cluster} AND c."instanceId" <> ${this.o.instanceId}
         AND i."heartbeatAt" > now() - make_interval(secs => ${this.o.liveWindowMs / 1000})`;
    const next = new Map<string, Presence>();
    for (const r of rows) {
      const p: Presence = {
        agentId: r.agentId,
        userId: r.userId,
        instanceId: r.instanceId,
        maxConcurrent: r.maxConcurrent,
        selfUpdate: r.selfUpdate,
        ...(r.agentVersion !== null && { agentVersion: r.agentVersion }),
        connectedAt: r.connectedAt.getTime(),
      };
      const mine = this.local?.localSince(p.agentId);
      if (mine !== undefined && mine >= p.connectedAt) continue;
      next.set(p.agentId, p);
    }
    this.remote = next;
    // A newer socket of an agent elsewhere whose `presence.up` this instance missed (messages are
    // at most once): close the older local one, as applyUp would have, so the agent never stays
    // connected twice with offers and messages split between two sockets.
    for (const p of next.values()) {
      const mine = this.local?.localSince(p.agentId);
      if (mine !== undefined && mine < p.connectedAt) this.local?.supersede(p.agentId);
    }
  }

  /** Forgets every agent of an instance that left. */
  dropInstance(instanceId: string): void {
    for (const [id, p] of this.remote) if (p.instanceId === instanceId) this.remote.delete(id);
  }

  /** Writes every local socket again (this instance's rows were purged while it was stalled). */
  reannounce(): Promise<void> {
    const all = this.local?.all() ?? [];
    return this.serial(async () => {
      for (const p of all) await this.upsert(p);
    });
  }

  stop(): void {
    this.stopped = true;
    this.remote.clear();
  }

  private applyUp(p: Presence): void {
    const mine = this.local?.localSince(p.agentId);
    if (mine !== undefined) {
      if (mine > p.connectedAt) return; // ours is newer: theirs closes when it sees our row
      this.local?.supersede(p.agentId);
    }
    const cur = this.remote.get(p.agentId);
    if (!cur || cur.connectedAt <= p.connectedAt) this.remote.set(p.agentId, p);
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const p = this.chain.then(() => (this.stopped ? undefined : fn()));
    this.chain = p.catch((err) =>
      this.o.log.warn({ err }, 'cluster: agent directory write failed'),
    );
    return this.chain as Promise<void>;
  }

  private async upsert(p: Presence, retry = true): Promise<void> {
    try {
      // Only a newer connection replaces a row (two hellos racing on two instances).
      await this.o.prisma.$executeRaw`
        INSERT INTO "AgentConnection"
          ("agentId", "userId", "instanceId", "maxConcurrent", "selfUpdate", "agentVersion", "connectedAt")
        VALUES (${p.agentId}, ${p.userId}, ${p.instanceId}, ${p.maxConcurrent}, ${p.selfUpdate},
                ${p.agentVersion ?? null}, ${new Date(p.connectedAt)})
        ON CONFLICT ("agentId") DO UPDATE SET
          "userId" = EXCLUDED."userId", "instanceId" = EXCLUDED."instanceId",
          "maxConcurrent" = EXCLUDED."maxConcurrent", "selfUpdate" = EXCLUDED."selfUpdate",
          "agentVersion" = EXCLUDED."agentVersion", "connectedAt" = EXCLUDED."connectedAt"
        WHERE "AgentConnection"."connectedAt" <= EXCLUDED."connectedAt"`;
    } catch (err) {
      // The instance row is missing (purged while this process was stalled): recreate, retry once.
      const fk =
        err instanceof Prisma.PrismaClientKnownRequestError ||
        String((err as Error)?.message).includes('foreign key');
      if (!retry || !fk) throw err;
      await this.o.ensureInstance();
      await this.upsert(p, false);
    }
  }
}
