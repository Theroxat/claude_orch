/**
 * Docker operations for tasks, through the docker CLI (and its compose plugin) talking to the host
 * daemon. Container create arguments come only from `sandbox.ts`.
 */
import { spawn } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { AGENT_LABEL } from './naming';
import { childEnv, runOk, type CommandRunner, type RunResult } from './runner';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

export interface BuildSpec {
  tag: string;
  dockerfile: string;
  context: string;
  args: Record<string, string>;
  labels: Record<string, string>;
}

export interface DockerOps {
  build(spec: BuildSpec): Promise<void>;
  pull(image: string): Promise<void>;
  createNetwork(name: string, labels: Record<string, string>): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  /** `docker create <args>`; `env` is the docker CLI child's environment (secret values). */
  create(args: string[], env: Record<string, string>): Promise<void>;
  /** Copies a host file into the container at the same absolute path (dereferences links). */
  copyIn(container: string, hostFile: string): Promise<void>;
  start(container: string): Promise<void>;
  exec(container: string, argv: string[]): Promise<RunResult>;
  /** `docker rm -f`, ignoring "no such container". */
  remove(container: string): Promise<void>;
  removeImage(tag: string): Promise<void>;
  exists(container: string): Promise<boolean>;
  /** Freezes / resumes every process of a container (used while committing). */
  pause(container: string): Promise<void>;
  unpause(container: string): Promise<void>;
  /** True when the container exists and is running (paused counts as running). */
  isRunning(container: string): Promise<boolean>;
  /** Names of the running, not paused containers of a compose project. */
  composeRunning(project: string): Promise<string[]>;
  /**
   * Names and `label` values of the containers / networks carrying `label` AND
   * `orch.agent=<agentId>` (never another agent's resources on a shared daemon).
   */
  listLabeled(
    kind: 'container' | 'network',
    label: string,
    agentId: string,
  ): Promise<{ name: string; value: string }[]>;
  /** The resolved model of `docker compose config --format json` (not trusted: validate it). */
  composeConfig(project: string, files: string[], cwd: string): Promise<unknown>;
  composeUp(project: string, files: string[], cwd: string): Promise<void>;
  /**
   * `down -v --remove-orphans`. With `target`, the same files and project directory as `up` (the
   * checked model), so compose never loads another file; without it (orphans), by name only.
   */
  composeDown(project: string, target?: { files: string[]; cwd: string }): Promise<void>;
  /** Compose projects named `<prefix>...` whose containers carry `orch.agent=<agentId>`. */
  composeProjects(prefix: string, agentId: string): Promise<string[]>;
}

const labelArgs = (labels: Record<string, string>) =>
  Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);

export class CliDocker implements DockerOps {
  constructor(
    private readonly runner: CommandRunner,
    private readonly bin = 'docker',
  ) {}

  private d(args: string[], env?: Record<string, string>, timeoutMs = 60 * 60_000) {
    return runOk(this.runner, this.bin, args, { env, timeoutMs });
  }

  async build(s: BuildSpec): Promise<void> {
    const args = ['build', '-t', s.tag, '-f', s.dockerfile, ...labelArgs(s.labels)];
    for (const [k, v] of Object.entries(s.args)) args.push('--build-arg', `${k}=${v}`);
    await this.d([...args, s.context], { DOCKER_BUILDKIT: '1' });
  }

  async pull(image: string): Promise<void> {
    await this.d(['pull', '--', image]);
  }

  async createNetwork(name: string, labels: Record<string, string>): Promise<void> {
    await this.d(['network', 'create', '--driver', 'bridge', ...labelArgs(labels), name]);
  }

  async removeNetwork(name: string): Promise<void> {
    const r = await this.runner.run(this.bin, ['network', 'rm', name]);
    if (r.code !== 0 && !/not found|No such network/i.test(r.stderr)) {
      throw new Error(`docker network rm ${name} failed: ${r.stderr.trim()}`);
    }
  }

  async create(args: string[], env: Record<string, string>): Promise<void> {
    await this.d(['create', ...args], env);
  }

  copyIn(container: string, hostFile: string): Promise<void> {
    if (!isAbsolute(hostFile)) return Promise.reject(new Error(`${hostFile} must be absolute`));
    // The archive holds the path relative to `/` and is extracted at the container's `/`, so the
    // missing parent directories (e.g. /opt/orch/bin in a repo image) are created. Copying into
    // `<container>:<dirname>` instead fails when that directory does not exist. `-h` follows links.
    return new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-C', '/', '-chf', '-', '--', relative('/', hostFile)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const cp = spawn(this.bin, ['cp', '-', `${container}:/`], {
        env: childEnv(),
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let err = '';
      tar.stderr.on('data', (c: Buffer) => (err += c.toString()));
      cp.stderr.on('data', (c: Buffer) => (err += c.toString()));
      tar.stdout.pipe(cp.stdin);
      tar.on('error', reject);
      cp.on('error', reject);
      cp.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`docker cp failed: ${err.trim()}`)),
      );
    });
  }

  async start(container: string): Promise<void> {
    await this.d(['start', container]);
  }

  exec(container: string, argv: string[]): Promise<RunResult> {
    return this.runner.run(this.bin, ['exec', container, ...argv], { timeoutMs: 60 * 60_000 });
  }

  async remove(container: string): Promise<void> {
    const r = await this.runner.run(this.bin, ['rm', '-f', '-v', container]);
    if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
      throw new Error(`docker rm ${container} failed: ${r.stderr.trim()}`);
    }
  }

  async removeImage(tag: string): Promise<void> {
    await this.runner.run(this.bin, ['image', 'rm', '-f', tag]);
  }

  async exists(container: string): Promise<boolean> {
    const r = await this.runner.run(this.bin, [
      'container',
      'inspect',
      '--format',
      '{{.Id}}',
      container,
    ]);
    return r.code === 0;
  }

  async pause(container: string): Promise<void> {
    await this.d(['pause', container], undefined, 60_000);
  }

  async unpause(container: string): Promise<void> {
    await this.d(['unpause', container], undefined, 60_000);
  }

  async isRunning(container: string): Promise<boolean> {
    const r = await this.runner.run(this.bin, [
      'container',
      'inspect',
      '--format',
      '{{.State.Running}}',
      container,
    ]);
    return r.code === 0 && r.stdout.trim() === 'true';
  }

  async composeRunning(project: string): Promise<string[]> {
    // status=running excludes paused containers.
    const out = await this.d([
      'ps',
      '--filter',
      `label=${COMPOSE_PROJECT_LABEL}=${project}`,
      '--filter',
      'status=running',
      '--format',
      '{{.Names}}',
    ]);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  }

  async listLabeled(kind: 'container' | 'network', label: string, agentId: string) {
    const filters = ['--filter', `label=${label}`, '--filter', `label=${AGENT_LABEL}=${agentId}`];
    const args =
      kind === 'container'
        ? ['ps', '-a', ...filters, '--format', `{{.Names}}\t{{.Label "${label}"}}`]
        : ['network', 'ls', ...filters, '--format', `{{.Name}}\t{{.Label "${label}"}}`];
    const out = await this.d(args);
    return out
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [name = '', value = ''] = l.split('\t');
        return { name, value };
      });
  }

  async composeConfig(project: string, files: string[], cwd: string): Promise<unknown> {
    const args = ['compose', '-p', project, '--project-directory', cwd];
    for (const f of files) args.push('-f', f);
    // Minimal environment: the repo file must not interpolate or pass through agent variables.
    const out = await runOk(this.runner, this.bin, [...args, 'config', '--format', 'json'], {
      timeoutMs: 5 * 60_000,
      composeEnv: true,
    });
    try {
      return JSON.parse(out) as unknown;
    } catch {
      throw new Error('docker compose config did not print JSON');
    }
  }

  async composeUp(project: string, files: string[], cwd: string): Promise<void> {
    const args = ['compose', '-p', project, '--project-directory', cwd];
    for (const f of files) args.push('-f', f);
    await runOk(this.runner, this.bin, [...args, 'up', '-d', '--remove-orphans'], {
      timeoutMs: 60 * 60_000,
      composeEnv: true,
    });
  }

  async composeDown(project: string, target?: { files: string[]; cwd: string }): Promise<void> {
    const down = ['down', '-v', '--remove-orphans', '--rmi', 'local'];
    const opts = { timeoutMs: 10 * 60_000, composeEnv: true };
    if (target && target.files.length > 0) {
      const args = ['compose', '-p', project, '--project-directory', target.cwd];
      for (const f of target.files) args.push('-f', f);
      const r = await this.runner.run(this.bin, [...args, ...down], opts);
      if (r.code === 0) return;
      // The checked model no longer loads (e.g. the clone is gone): fall back to the name.
    }
    await this.runner.run(this.bin, ['compose', '-p', project, ...down], opts);
  }

  async composeProjects(prefix: string, agentId: string): Promise<string[]> {
    const out = await this.d([
      'ps',
      '-a',
      '--filter',
      `label=${AGENT_LABEL}=${agentId}`,
      '--filter',
      `label=${COMPOSE_PROJECT_LABEL}`,
      '--format',
      `{{.Label "${COMPOSE_PROJECT_LABEL}"}}`,
    ]);
    const names = out.split('\n').map((l) => l.trim());
    return [...new Set(names)].filter((n) => n !== '' && n.startsWith(prefix));
  }
}
