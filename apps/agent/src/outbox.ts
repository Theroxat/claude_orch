/**
 * Persistent outbox for acked agent -> server messages (PLAN 4.3, 4.5).
 *
 * - `enqueue` assigns an id and a monotonic seq and persists BEFORE trying to send.
 * - `setOnline(true)` (after `welcome`) replays every pending entry in seq order with its ORIGINAL id.
 * - While online, entries not acked within `retryMs` are resent with the same id.
 * - `ack(id)` removes the entry. The file survives restarts (JSON, atomic tmp + rename).
 */
import { z } from 'zod';
import {
  agentMessage,
  newMessageId,
  type AgentMessage,
  type AgentMessageType,
  type PayloadOf,
} from '@orch/shared';
import { readJsonFile, writeJsonAtomic } from './fsutil';
import { silentLogger, type Logger } from './log';

export type OutboxType = Exclude<AgentMessageType, 'hello' | 'heartbeat' | 'ack'>;

const EntrySchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  type: z.string(),
  ts: z.string(),
  payload: z.unknown(),
});
export type OutboxEntry = z.infer<typeof EntrySchema>;

const FileSchema = z.object({
  nextSeq: z.number().int().nonnegative(),
  entries: z.array(EntrySchema),
});

export interface OutboxOptions {
  retryMs?: number;
  /** Oldest entries are dropped beyond this many. */
  maxEntries?: number;
  logger?: Logger;
}

export interface EnqueueOptions {
  /** Drop older pending entries of the same type first (latest value wins, e.g. usage.report). */
  replaceSameType?: boolean;
}

export class Outbox {
  private nextSeq: number;
  private entries: OutboxEntry[];
  private readonly lastSent = new Map<string, number>();
  private sender: ((m: AgentMessage) => boolean) | undefined;
  private online = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly retryMs: number;
  private readonly maxEntries: number;
  private readonly log: Logger;

  constructor(
    private readonly file: string,
    opts: OutboxOptions = {},
  ) {
    this.retryMs = opts.retryMs ?? 30_000;
    this.maxEntries = opts.maxEntries ?? 5_000;
    this.log = opts.logger ?? silentLogger;
    const data = readJsonFile(
      file,
      FileSchema,
      () => ({ nextSeq: 1, entries: [] }),
      (moved) => this.log.warn('outbox file was corrupt, moved aside', { movedTo: moved }),
    );
    this.entries = [...data.entries].sort((a, b) => a.seq - b.seq);
    const maxSeq = this.entries.reduce((m, e) => Math.max(m, e.seq), 0);
    this.nextSeq = Math.max(data.nextSeq, maxSeq + 1);
  }

  /** Function used to put a message on the wire; returns false when it could not be sent. */
  setSender(sender: (m: AgentMessage) => boolean): void {
    this.sender = sender;
  }

  setOnline(online: boolean): void {
    this.online = online;
    this.lastSent.clear();
    clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    if (!online) return;
    this.flush();
    this.retryTimer = setInterval(
      () => this.retryStale(),
      Math.max(10, Math.floor(this.retryMs / 2)),
    );
    this.retryTimer.unref();
  }

  enqueue<T extends OutboxType>(
    type: T,
    payload: PayloadOf<AgentMessage, T>,
    opts: EnqueueOptions = {},
  ): OutboxEntry {
    const now = new Date();
    const entry: OutboxEntry = {
      id: newMessageId(now.getTime()),
      seq: this.nextSeq++,
      type,
      ts: now.toISOString(),
      payload,
    };
    if (opts.replaceSameType) {
      for (const e of this.entries.filter((x) => x.type === type)) this.lastSent.delete(e.id);
      this.entries = this.entries.filter((x) => x.type !== type);
    }
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      const dropped = this.entries.splice(0, this.entries.length - this.maxEntries);
      this.log.warn('outbox full, dropped oldest entries', { dropped: dropped.length });
    }
    this.persist();
    if (this.online) this.sendEntry(entry);
    return entry;
  }

  /** Removes an acked entry. Returns true when it was pending. */
  ack(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    this.lastSent.delete(id);
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }

  pending(): readonly OutboxEntry[] {
    return this.entries;
  }

  hasPending(type: OutboxType): boolean {
    return this.entries.some((e) => e.type === type);
  }

  close(): void {
    clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    this.online = false;
  }

  /** Sends every pending entry in seq order. */
  flush(): void {
    for (const e of this.entries) if (!this.sendEntry(e)) break;
  }

  private retryStale(): void {
    const now = Date.now();
    for (const e of this.entries) {
      const at = this.lastSent.get(e.id);
      if (at !== undefined && now - at < this.retryMs) continue;
      this.log.debug('resending unacked message', { id: e.id, type: e.type });
      if (!this.sendEntry(e)) break;
    }
  }

  private sendEntry(e: OutboxEntry): boolean {
    if (!this.sender) return false;
    const msg = agentMessage(e.type as OutboxType, e.payload as never, {
      id: e.id,
      seq: e.seq,
      now: new Date(e.ts),
    });
    const ok = this.sender(msg);
    if (ok) this.lastSent.set(e.id, Date.now());
    return ok;
  }

  private persist(): void {
    writeJsonAtomic(this.file, { nextSeq: this.nextSeq, entries: this.entries });
  }
}
