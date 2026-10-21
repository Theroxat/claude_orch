/**
 * Bounded, persisted set of processed server message ids (PLAN 4.5 idempotency).
 * Keeps at most `max` ids and drops ids older than `ttlMs`.
 */
import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from './fsutil';

const FileSchema = z.array(z.tuple([z.string(), z.number()]));

export class InboundDedup {
  private readonly ids = new Map<string, number>();

  constructor(
    private readonly file: string,
    private readonly max = 1_000,
    private readonly ttlMs = 24 * 3_600_000,
  ) {
    for (const [id, at] of readJsonFile(file, FileSchema, () => [])) this.ids.set(id, at);
    this.prune(Date.now());
  }

  has(id: string): boolean {
    const at = this.ids.get(id);
    return at !== undefined && Date.now() - at < this.ttlMs;
  }

  remember(id: string, now = Date.now()): void {
    this.ids.delete(id);
    this.ids.set(id, now);
    this.prune(now);
    writeJsonAtomic(this.file, [...this.ids.entries()]);
  }

  get size(): number {
    return this.ids.size;
  }

  private prune(now: number): void {
    for (const [id, at] of this.ids) {
      if (this.ids.size > this.max || now - at >= this.ttlMs) this.ids.delete(id);
      else break;
    }
  }
}
