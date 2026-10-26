/**
 * Live output across instances. A run lives in the store of the instance holding the agent's
 * socket; a browser's SSE stream may land on any instance. On demand only:
 *
 * 1. An instance with viewers of a task broadcasts `logs.watch` (renewed while they stay);
 * 2. every instance remembers who watches which task, and answers with `logs.snapshot`: the run it
 *    owns for that task (lines after the watcher's resume point) or nothing;
 * 3. while a task is watched elsewhere, its owner broadcasts each change (`logs.event`), and the
 *    watchers mirror it in their own store (`LiveLogStore.ingest`), which their SSE streams read.
 *
 * Nothing is sent for a task nobody watches on another instance, and nothing at all when alone.
 * Delivery is best effort like the rest of live output: a renewal repairs a missed message.
 */
import type { LiveLogLine } from '@orch/shared';
import type { Cluster } from '../cluster';
import type { LiveLogStore, LiveRunInfo } from './store';

interface Watch {
  viewers: number;
  timer: NodeJS.Timeout;
  /** Resolves once every known peer answered the first `logs.watch` (or on timeout). */
  ready: Promise<void>;
}

interface Waiter {
  pending: Set<string>;
  done: () => void;
}

export interface RelayOptions {
  store: LiveLogStore;
  cluster: Cluster;
  /** How often a watch is renewed; watchers silent for 3 periods are forgotten. */
  renewMs?: number;
  /** How long a new stream waits for the other instances' snapshots before it starts. */
  snapshotWaitMs?: number;
}

export class LiveLogRelay {
  /** taskId -> watching instance -> expiry (epoch ms). */
  private readonly watchers = new Map<string, Map<string, number>>();
  /** Tasks with viewers on this instance. */
  private readonly watching = new Map<string, Watch>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly renewMs: number;
  private readonly waitMs: number;

  constructor(private readonly o: RelayOptions) {
    this.renewMs = o.renewMs ?? 30_000;
    this.waitMs = o.snapshotWaitMs ?? 750;
    const { bus } = o.cluster;
    o.store.onOwnedChange = (taskId, run, lines) => this.forward(taskId, run, lines);

    bus.on<{ taskId: string; assignmentId?: string; after?: number }>('logs.watch', (d, from) => {
      let w = this.watchers.get(d.taskId);
      if (!w) this.watchers.set(d.taskId, (w = new Map()));
      w.set(from, Date.now() + 3 * this.renewMs);
      const owned = o.store.ownedRun(d.taskId);
      const after = owned && owned.run.assignmentId === d.assignmentId ? (d.after ?? 0) : 0;
      const snap = o.store.ownedRun(d.taskId, after);
      void bus.publish('logs.snapshot', { taskId: d.taskId, ...(snap ?? {}) }, from);
    });
    bus.on<{ taskId: string }>('logs.unwatch', ({ taskId }, from) => {
      const w = this.watchers.get(taskId);
      w?.delete(from);
      if (w?.size === 0) this.watchers.delete(taskId);
    });
    bus.on<{ taskId: string; run: LiveRunInfo; lines: LiveLogLine[] }>('logs.event', (d) => {
      if (this.watching.has(d.taskId)) o.store.ingest(d.run, d.lines);
    });
    bus.on<{ taskId: string; run?: LiveRunInfo; lines?: LiveLogLine[] }>(
      'logs.snapshot',
      (d, from) => {
        if (d.run && this.watching.has(d.taskId)) o.store.ingest(d.run, d.lines ?? []);
        for (const waiter of this.waiters.get(d.taskId) ?? []) {
          waiter.pending.delete(from);
          if (waiter.pending.size === 0) waiter.done();
        }
      },
    );
  }

  /**
   * A viewer opened a stream for this task: mirror the other instances' run for it until the
   * returned function is called. Resolves once the current state is in the local store.
   */
  async watch(taskId: string): Promise<() => void> {
    let w = this.watching.get(taskId);
    if (!w) {
      const timer = setInterval(() => void this.ask(taskId), this.renewMs);
      timer.unref();
      w = { viewers: 0, timer, ready: Promise.resolve() };
      this.watching.set(taskId, w);
      w.ready = this.ask(taskId, true);
    }
    w.viewers++;
    await w.ready;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.watching.get(taskId);
      if (!cur || --cur.viewers > 0) return;
      clearInterval(cur.timer);
      this.watching.delete(taskId);
      void this.o.cluster.bus.publish('logs.unwatch', { taskId });
    };
  }

  /** Broadcasts `logs.watch`; with `wait`, until every known peer answered (bounded). */
  private ask(taskId: string, wait = false): Promise<void> {
    const peers = this.o.cluster.peerIds();
    if (peers.length === 0) return Promise.resolve();
    const latest = this.o.store.latest(taskId);
    const data = {
      taskId,
      ...(latest && { assignmentId: latest.assignmentId, after: latest.lastId }),
    };
    if (!wait) return this.o.cluster.bus.publish('logs.watch', data);
    return new Promise<void>((resolve) => {
      let set = this.waiters.get(taskId);
      if (!set) this.waiters.set(taskId, (set = new Set()));
      const waiter: Waiter = {
        pending: new Set(peers),
        done: () => {
          clearTimeout(timer);
          set.delete(waiter);
          if (set.size === 0) this.waiters.delete(taskId);
          resolve();
        },
      };
      const timer = setTimeout(waiter.done, this.waitMs);
      timer.unref();
      set.add(waiter);
      void this.o.cluster.bus.publish('logs.watch', data);
    });
  }

  /** Owner side: forwards a change when another instance watches the task. */
  private forward(taskId: string, run: LiveRunInfo, lines: LiveLogLine[]): void {
    const w = this.watchers.get(taskId);
    if (!w) return;
    const now = Date.now();
    for (const [id, exp] of w) if (exp < now) w.delete(id);
    if (w.size === 0) {
      this.watchers.delete(taskId);
      return;
    }
    void this.o.cluster.bus.publish('logs.event', { taskId, run, lines });
  }

  stop(): void {
    for (const w of this.watching.values()) clearInterval(w.timer);
    this.watching.clear();
    this.watchers.clear();
    for (const set of this.waiters.values()) for (const w of [...set]) w.done();
  }
}
