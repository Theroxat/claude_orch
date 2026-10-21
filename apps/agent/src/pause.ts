/** Local pause state, persisted so `orch pause` survives restarts and works offline. */
import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from './fsutil';

const StateSchema = z.object({
  paused: z.boolean(),
  updatedAt: z.string(),
  source: z.enum(['local', 'server']),
});
export type PauseRecord = z.infer<typeof StateSchema>;

export class PauseState {
  private state: PauseRecord;

  constructor(private readonly file: string) {
    this.state = readJsonFile(file, StateSchema, () => ({
      paused: false,
      updatedAt: new Date(0).toISOString(),
      source: 'local' as const,
    }));
  }

  isPaused(): boolean {
    return this.state.paused;
  }

  get record(): Readonly<PauseRecord> {
    return this.state;
  }

  /** Returns true when the value changed. */
  set(paused: boolean, source: PauseRecord['source']): boolean {
    const changed = paused !== this.state.paused;
    this.state = { paused, source, updatedAt: new Date().toISOString() };
    writeJsonAtomic(this.file, this.state);
    return changed;
  }
}
