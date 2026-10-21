/**
 * Manual-mode sessions (PLAN 5.6): a detached `screen` session inside the agent container runs
 * `docker exec -it <task> claude ...`. The member attaches with
 * `orch attach <n>` (host shortcut that forwards to the agent container).
 */
import { runOk, type CommandRunner } from './runner';

export interface ScreenOps {
  start(name: string, argv: string[]): Promise<void>;
  exists(name: string): Promise<boolean>;
  kill(name: string): Promise<void>;
}

export class CliScreen implements ScreenOps {
  constructor(
    private readonly runner: CommandRunner,
    private readonly bin = 'screen',
  ) {}

  async start(name: string, argv: string[]): Promise<void> {
    // argv is exec'd directly by screen (no shell), so the prompt needs no quoting.
    await runOk(this.runner, this.bin, ['-dmS', name, ...argv], {
      env: { TERM: 'xterm-256color' },
    });
  }

  async exists(name: string): Promise<boolean> {
    const r = await this.runner.run(this.bin, ['-ls', name]);
    return new RegExp(`\\d+\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`).test(r.stdout);
  }

  async kill(name: string): Promise<void> {
    await this.runner.run(this.bin, ['-S', name, '-X', 'quit']);
  }
}
