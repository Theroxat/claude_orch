/**
 * Docker operations for tasks, through the docker CLI (and its compose plugin) talking to the host
 * daemon. Container create arguments come only from `sandbox.ts`.
 */
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, basename } from 'node:path';
import { childEnv, runOk, type CommandRunner, type RunResult } from './runner';

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
  /** Names and label values of containers / networks carrying `label`. */
  listLabeled(
    kind: 'container' | 'network',
    label: string,
  ): Promise<{ name: string; value: string }[]>;
  composeUp(project: string, files: string[], cwd: string): Promise<void>;
  composeDown(project: string): Promise<void>;
  composeProjects(prefix: string): Promise<string[]>;
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
    // tar keeps the absolute layout (parents created), `-h` follows symlinks.
    return new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-C', dirname(hostFile), '-chf', '-', basename(hostFile)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const cp = spawn(this.bin, ['cp', '-', `${container}:${dirname(hostFile)}`], {
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

  async listLabeled(kind: 'container' | 'network', label: string) {
    const fmt = `{{.Name}}\t{{.Label "${label}"}}`;
    const args =
      kind === 'container'
        ? [
            'ps',
            '-a',
            '--filter',
            `label=${label}`,
            '--format',
            `{{.Names}}\t{{.Label "${label}"}}`,
          ]
        : ['network', 'ls', '--filter', `label=${label}`, '--format', fmt];
    const out = await this.d(args);
    return out
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [name = '', value = ''] = l.split('\t');
        return { name, value };
      });
  }

  async composeUp(project: string, files: string[], cwd: string): Promise<void> {
    const args = ['compose', '-p', project, '--project-directory', cwd];
    for (const f of files) args.push('-f', f);
    await this.d([...args, 'up', '-d', '--remove-orphans']);
  }

  async composeDown(project: string): Promise<void> {
    await this.runner.run(this.bin, ['compose', '-p', project, 'down', '-v', '--remove-orphans'], {
      timeoutMs: 10 * 60_000,
    });
  }

  async composeProjects(prefix: string): Promise<string[]> {
    const r = await this.runner.run(this.bin, ['compose', 'ls', '-a', '--format', 'json']);
    if (r.code !== 0) return [];
    try {
      const list = JSON.parse(r.stdout) as { Name?: string }[];
      return list.map((p) => p.Name ?? '').filter((n) => n.startsWith(prefix));
    } catch {
      return [];
    }
  }
}
