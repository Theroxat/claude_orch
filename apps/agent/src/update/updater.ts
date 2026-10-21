/**
 * Agent self-update, for `agent.update` (one-click update from the web) and `orch update`.
 *
 * Flow: validate the image (own repository + release version only) -> refuse when tasks are
 * running, or defer until idle when the member asked for it -> inspect the own container
 * (HOSTNAME) to find the compose project, files and working dir -> `docker pull` (a failure
 * leaves everything as it was) -> write the tag into the install dir's `.env` (backup kept) ->
 * start a detached helper container from the CURRENT image, with the docker socket and the
 * install dir mounted at the same absolute path, that runs `docker compose up -d <service>` after
 * a few seconds. The helper outlives this container; on failure it restores the backup and
 * brings the old version back. Progress is reported as `update.status`; after the restart the
 * new agent reconnects with the new version and the server marks the update done.
 */
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { UpdateStatus, UpdateStatusPayload } from '@orch/shared';
import { readJsonFile, writeJsonAtomic } from '../fsutil';
import { runOk, type CommandRunner } from '../exec/runner';
import { errorMessage, type Logger } from '../log';
import {
  UpdateError,
  chooseImageKey,
  helperRunArgs,
  imageEnvValue,
  parseSelfInspect,
  readFileArgs,
  restoreEnvArgs,
  setEnvValue,
  validateUpdateImage,
  writeEnvArgs,
} from './plan';

export interface UpdateRequest {
  updateId: string;
  targetVersion: string;
  image: string;
  whenIdle: boolean;
}

export interface UpdateState {
  updateId: string;
  targetVersion: string;
  status: UpdateStatus;
  code?: string;
  detail?: string;
}

export interface UpdaterOptions {
  runner: CommandRunner;
  /** Own container id or name (`HOSTNAME` in a container). */
  selfId: string;
  /** Allowed image repository (ORCH_AGENT_IMAGE_REPO). */
  imageRepo: string;
  currentVersion: string;
  dataDir: string;
  /** Number of tasks holding a slot right now. */
  runningTasks: () => number;
  report: (p: UpdateStatusPayload) => void;
  logger: Logger;
  dockerBin?: string;
  /** Seconds the helper waits before `docker compose up` (default 5). */
  helperDelaySec?: number;
  /** How often a deferred update checks for idleness (default 10 s). */
  idlePollMs?: number;
  pullTimeoutMs?: number;
}

const PendingSchema = z.object({
  updateId: z.string(),
  targetVersion: z.string(),
  fromVersion: z.string(),
});

export class Updater {
  private state: UpdateState | null = null;
  private deferred: UpdateRequest | null = null;
  private pollTimer: NodeJS.Timeout | undefined;
  private busy = false;
  /** The background run of the current update (tests await it). */
  inflight: Promise<void> = Promise.resolve();
  private readonly log: Logger;

  constructor(private readonly o: UpdaterOptions) {
    this.log = o.logger;
  }

  current(): UpdateState | null {
    return this.state;
  }

  /** True while an update waits for the running tasks to finish. */
  isDeferred(): boolean {
    return this.deferred !== null;
  }

  private get pendingFile(): string {
    return join(this.o.dataDir, 'update-pending.json');
  }

  private set(
    req: Pick<UpdateRequest, 'updateId' | 'targetVersion'>,
    s: Omit<UpdateState, 'updateId' | 'targetVersion'>,
  ) {
    const state: UpdateState = { updateId: req.updateId, targetVersion: req.targetVersion, ...s };
    if (state.detail) state.detail = state.detail.slice(0, 2000);
    this.state = state;
    this.o.report({ ...state });
    this.log.info('agent update', {
      status: state.status,
      targetVersion: state.targetVersion,
      ...(state.code ? { code: state.code } : {}),
    });
  }

  private fail(req: Pick<UpdateRequest, 'updateId' | 'targetVersion'>, err: unknown): void {
    const code = err instanceof UpdateError ? err.code : 'failed';
    this.set(req, { status: 'failed', code, detail: errorMessage(err) });
  }

  /**
   * Starts, defers or refuses an update. Returns the resulting state at once; the pull and the
   * restart continue in the background (`inflight`).
   */
  request(req: UpdateRequest): UpdateState {
    const target = {
      updateId: req.updateId,
      targetVersion: String(req.targetVersion).slice(0, 64),
    };
    try {
      validateUpdateImage(req.image, req.targetVersion, this.o.imageRepo);
    } catch (err) {
      this.fail(target, err);
      return this.state!;
    }
    if (this.busy) {
      // Report on the new id only; the running update keeps its state.
      this.o.report({
        ...target,
        status: 'failed',
        code: 'in_progress',
        detail: 'An update is already in progress.',
      });
      return { ...target, status: 'failed', code: 'in_progress' };
    }
    const running = this.o.runningTasks();
    if (running > 0) {
      if (!req.whenIdle) {
        this.cancelDeferred();
        this.fail(
          target,
          new UpdateError(
            'busy',
            `${running} task(s) running on this machine. Retry when they are done, or choose "update when idle".`,
          ),
        );
        return this.state!;
      }
      this.deferred = req;
      this.set(target, {
        status: 'deferred',
        detail: `Waiting for ${running} running task(s) to finish.`,
      });
      this.pollTimer ??= setInterval(() => this.checkIdle(), this.o.idlePollMs ?? 10_000);
      this.pollTimer.unref?.();
      return this.state!;
    }
    this.cancelDeferred();
    this.busy = true;
    this.set(target, { status: 'pending' });
    this.inflight = this.run(req).finally(() => {
      this.busy = false;
    });
    return this.state!;
  }

  /** Starts a deferred update once no task holds a slot. */
  checkIdle(): void {
    const req = this.deferred;
    if (!req || this.busy || this.o.runningTasks() > 0) return;
    this.cancelDeferred();
    this.request({ ...req, whenIdle: false });
  }

  private cancelDeferred(): void {
    this.deferred = null;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private docker(args: string[], input?: string, timeoutMs = 60_000): Promise<string> {
    return runOk(this.o.runner, this.o.dockerBin ?? 'docker', args, { input, timeoutMs });
  }

  private async run(req: UpdateRequest): Promise<void> {
    const repo = this.o.imageRepo;
    try {
      const self = parseSelfInspect(
        await this.docker(['inspect', '--type', 'container', '--', this.o.selfId]).catch(() => {
          throw new UpdateError(
            'not_compose',
            'Could not find the agent container (is the docker socket mounted?).',
          );
        }),
      );
      let template = '';
      for (const f of self.configFiles) template += `${await this.docker(readFileArgs(self, f))}\n`;
      const key = chooseImageKey(template);

      this.set(req, { status: 'pulling', detail: `Pulling ${req.image}` });
      try {
        await this.docker(
          ['pull', '--', req.image],
          undefined,
          this.o.pullTimeoutMs ?? 30 * 60_000,
        );
      } catch (err) {
        throw new UpdateError('pull_failed', `Could not pull ${req.image}: ${errorMessage(err)}`);
      }

      let envText: string;
      try {
        envText = await this.docker(readFileArgs(self, self.envFile));
      } catch (err) {
        throw new UpdateError(
          'env_write_failed',
          `Could not read ${self.envFile}: ${errorMessage(err)}`,
        );
      }
      const next = setEnvValue(envText, key, imageEnvValue(key, repo, req.targetVersion));
      try {
        await this.docker(writeEnvArgs(self), next);
      } catch (err) {
        throw new UpdateError(
          'env_write_failed',
          `Could not write ${self.envFile}: ${errorMessage(err)}`,
        );
      }

      writeJsonAtomic(this.pendingFile, {
        updateId: req.updateId,
        targetVersion: req.targetVersion,
        fromVersion: this.o.currentVersion,
      });
      const env: Record<string, string> = {};
      if (self.hostClaudeDir && !/^\s*(export\s+)?ORCH_CLAUDE_DIR\s*=/m.test(envText)) {
        env.ORCH_CLAUDE_DIR = self.hostClaudeDir;
      }
      const delay = this.o.helperDelaySec ?? 5;
      const name = `${self.project}-update-${randomBytes(4).toString('hex')}`;
      try {
        await this.docker(helperRunArgs(self, name, delay, env));
      } catch (err) {
        rmSync(this.pendingFile, { force: true });
        await this.docker(restoreEnvArgs(self)).catch((e: unknown) =>
          this.log.warn('could not restore the .env backup', { error: errorMessage(e) }),
        );
        throw new UpdateError(
          'helper_failed',
          `Could not start the update helper: ${errorMessage(err)}`,
        );
      }
      // Hand-off done: the helper recreates this container in `delay` seconds.
      this.set(req, {
        status: 'restarting',
        detail: `Restarting on ${req.image} in ${delay} s (${key} updated in ${self.envFile}).`,
      });
    } catch (err) {
      this.fail(req, err);
    }
  }

  /**
   * After a start: if an update was handed off before the restart, report its outcome. The new
   * version reports `done`; the old one (the helper rolled back) reports `failed`.
   */
  resumeAfterRestart(): void {
    const p = readJsonFile(this.pendingFile, PendingSchema.nullable(), () => null);
    if (!p) return;
    rmSync(this.pendingFile, { force: true });
    if (this.o.currentVersion === p.targetVersion) {
      this.set(p, { status: 'done', detail: `Running v${p.targetVersion}.` });
    } else {
      this.set(p, {
        status: 'failed',
        code: 'not_applied',
        detail: `The agent restarted on v${this.o.currentVersion} instead of v${p.targetVersion}.`,
      });
    }
  }

  close(): void {
    this.cancelDeferred();
  }
}
