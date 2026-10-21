/** In-memory fakes for the executor's git, docker, screen and filesystem interfaces. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TaskOfferPayload } from '@orch/shared';
import type { ProcessOps, RunningProcess } from '../../src/exec/claude-run';
import type { BuildSpec, DockerOps } from '../../src/exec/docker';
import type { GitIdentity, GitOps } from '../../src/exec/git';
import type { RunResult } from '../../src/exec/runner';
import type { ScreenOps } from '../../src/exec/screen';
import { nodeWorkspaceFs, type WorkspaceFs } from '../../src/exec/workspace';

export type Call = [string, ...unknown[]];

export class FakeGit implements GitOps {
  calls: Call[] = [];
  /** Files written into every clone (relative path -> content). */
  files: Record<string, string> = { 'README.md': '# fixture\n' };
  ahead = 2;
  failPush = false;

  async syncMirror(mirrorDir: string, remoteUrl: string, token: string) {
    this.calls.push(['syncMirror', mirrorDir, remoteUrl, token]);
  }
  async clone(mirrorDir: string, remoteUrl: string, dest: string, token: string) {
    this.calls.push(['clone', mirrorDir, remoteUrl, dest, token]);
    mkdirSync(join(dest, '.git'), { recursive: true });
    for (const [rel, content] of Object.entries(this.files)) {
      mkdirSync(dirname(join(dest, rel)), { recursive: true });
      writeFileSync(join(dest, rel), content);
    }
  }
  async createBranch(dir: string, branch: string, base: string) {
    this.calls.push(['createBranch', dir, branch, base]);
  }
  async setIdentity(dir: string, id: GitIdentity) {
    this.calls.push(['setIdentity', dir, id]);
  }
  async commitAll(dir: string, message: string) {
    this.calls.push(['commitAll', dir, message]);
    return true;
  }
  async commitsAhead() {
    return this.ahead;
  }
  async changedFiles() {
    return 3;
  }
  async subjects() {
    return ['feat: one', 'fix: two'];
  }
  async headSha() {
    return 'a'.repeat(40);
  }
  async push(dir: string, branch: string, token: string) {
    this.calls.push(['push', dir, branch, token]);
    if (this.failPush) throw new Error('remote rejected');
  }
}

export class FakeDocker implements DockerOps {
  calls: Call[] = [];
  containers = new Set<string>();
  networks = new Set<string>();
  labeled: { kind: 'container' | 'network'; name: string; value: string }[] = [];
  projects: string[] = [];
  createEnv: Record<string, string>[] = [];
  usageJsonl = '';

  async build(spec: BuildSpec) {
    this.calls.push(['build', spec]);
  }
  async pull(image: string) {
    this.calls.push(['pull', image]);
  }
  async createNetwork(name: string) {
    this.calls.push(['createNetwork', name]);
    this.networks.add(name);
  }
  async removeNetwork(name: string) {
    this.calls.push(['removeNetwork', name]);
    this.networks.delete(name);
  }
  async create(args: string[], env: Record<string, string>) {
    this.calls.push(['create', args]);
    this.createEnv.push(env);
    const name = args[args.indexOf('--name') + 1] as string;
    this.containers.add(name);
  }
  async copyIn(container: string, hostFile: string) {
    this.calls.push(['copyIn', container, hostFile]);
  }
  async start(container: string) {
    this.calls.push(['start', container]);
  }
  async exec(container: string, argv: string[]): Promise<RunResult> {
    this.calls.push(['exec', container, argv]);
    const isUsage = argv.join(' ').includes('.jsonl');
    return { code: 0, stdout: isUsage ? this.usageJsonl : '', stderr: '' };
  }
  async remove(container: string) {
    this.calls.push(['remove', container]);
    this.containers.delete(container);
  }
  async removeImage(tag: string) {
    this.calls.push(['removeImage', tag]);
  }
  async exists(container: string) {
    return this.containers.has(container);
  }
  async listLabeled(kind: 'container' | 'network') {
    return this.labeled.filter((l) => l.kind === kind);
  }
  async composeUp(project: string, files: string[], cwd: string) {
    this.calls.push(['composeUp', project, files, cwd]);
  }
  async composeDown(project: string) {
    this.calls.push(['composeDown', project]);
  }
  async composeProjects() {
    return this.projects;
  }
  names(): string[] {
    return this.calls.map((c) => c[0]);
  }
}

export class FakeScreen implements ScreenOps {
  sessions = new Map<string, string[]>();
  async start(name: string, argv: string[]) {
    this.sessions.set(name, argv);
  }
  async exists(name: string) {
    return this.sessions.has(name);
  }
  async kill(name: string) {
    this.sessions.delete(name);
  }
}

/** Real fs (temp dirs) with recorded removals. */
export function recordingFs(): WorkspaceFs & { removed: string[] } {
  const removed: string[] = [];
  return {
    ...nodeWorkspaceFs,
    removed,
    remove: async (p) => {
      removed.push(p);
      await nodeWorkspaceFs.remove(p);
    },
  };
}

export function offer(
  over: Partial<Omit<TaskOfferPayload, 'task'>> & {
    issueNumber?: number;
    task?: Partial<TaskOfferPayload['task']>;
  } = {},
): TaskOfferPayload {
  const issueNumber = over.issueNumber ?? 42;
  return {
    assignmentId: over.assignmentId ?? 'asg_1',
    kind: over.kind ?? 'CLAIM',
    expiresAt: over.expiresAt ?? null,
    ...(over.execMode !== undefined ? { execMode: over.execMode } : {}),
    ...(over.accepted !== undefined ? { accepted: over.accepted } : {}),
    ...(over.timeoutSec !== undefined ? { timeoutSec: over.timeoutSec } : {}),
    task: {
      taskId: 'tsk_1',
      project: over.task?.project ?? {
        id: 'prj_1',
        fullName: 'acme/widgets',
        defaultBranch: 'main',
      },
      issueNumber,
      title: 'Add a dark mode toggle!',
      prompt: 'Please add a toggle.',
      bodyHash: 'h',
      acceptanceCriteria: ['toggle works'],
      size: 'S',
      model: 'SONNET',
      baseBranch: 'main',
      branchName: `orch/issue-${issueNumber}-add-a-dark-mode-toggle`,
      createdBy: { login: 'alice' },
      ...over.task,
    },
  };
}

export interface FakeRun {
  argv: string[];
  input: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Ends the process with this exit code. */
  finish: (code: number) => void;
  killed: boolean;
}

/** Fake `claude -p` launcher. `script` runs right after spawn (e.g. emit a result and exit). */
export class FakeProc implements ProcessOps {
  runs: FakeRun[] = [];
  script: ((run: FakeRun) => void) | undefined;

  spawnLines(
    argv: string[],
    input: string,
    stdout: (line: string) => void,
    stderr: (line: string) => void,
  ): RunningProcess {
    let resolve!: (code: number) => void;
    const exit = new Promise<number>((r) => (resolve = r));
    const run: FakeRun = { argv, input, stdout, stderr, finish: (c) => resolve(c), killed: false };
    this.runs.push(run);
    const script = this.script;
    if (script) queueMicrotask(() => script(run));
    return {
      exit,
      kill: () => {
        run.killed = true;
        resolve(137);
      },
    };
  }
}

/** A stream-json `result` event like `claude -p --output-format stream-json` prints last. */
export function resultLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 7,
    result: 'Added the toggle and its tests.',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 1000,
    },
    ...over,
  });
}
