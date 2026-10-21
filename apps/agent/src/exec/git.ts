/**
 * Git operations for a task (PLAN 5.1, 5.5). Every call runs with
 * `core.hooksPath=/dev/null`, `core.fsmonitor=false` and no credential helper, so nothing from a
 * task clone runs in the agent and nothing is stored.
 *
 * Auth: the installation token is given to ONE git child at a time as an `http.<base>/.extraHeader`
 * through `GIT_CONFIG_COUNT/KEY/VALUE` environment variables. It is never on the command line,
 * in a remote URL, in `.git/config` or anywhere else on disk.
 */
import { runOk, type CommandRunner } from './runner';

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitOps {
  /** Creates or refreshes the bare mirror (agent-only, never mounted). */
  syncMirror(mirrorDir: string, remoteUrl: string, token: string): Promise<void>;
  /** Isolated clone that borrows objects from the mirror then dissociates from it. */
  clone(mirrorDir: string, remoteUrl: string, dest: string, token: string): Promise<void>;
  /** New branch `branch` from `origin/<base>`, checked out. */
  createBranch(dir: string, branch: string, base: string): Promise<void>;
  setIdentity(dir: string, id: GitIdentity): Promise<void>;
  /** Commits every pending change (`git add -A`). Returns false when there was nothing. */
  commitAll(dir: string, message: string, id: GitIdentity): Promise<boolean>;
  /** Commits on HEAD that are not on `origin/<base>`. */
  commitsAhead(dir: string, base: string): Promise<number>;
  changedFiles(dir: string, base: string): Promise<number>;
  subjects(dir: string, base: string): Promise<string[]>;
  headSha(dir: string): Promise<string>;
  push(dir: string, branch: string, token: string): Promise<void>;
}

/** `-c` flags put before every git subcommand. */
export const GIT_SAFETY_FLAGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'credential.helper=',
  '-c',
  'safe.directory=*',
  '-c',
  'submodule.recurse=false',
];

/** In-memory auth env for one git child. `baseUrl` scopes the header to the git host. */
export function gitAuthEnv(baseUrl: string, token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${baseUrl.replace(/\/+$/, '')}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

export class CliGit implements GitOps {
  constructor(
    private readonly runner: CommandRunner,
    /** Git host base URL, e.g. https://github.com. */
    private readonly baseUrl: string,
  ) {}

  private git(args: string[], opts: { cwd?: string; token?: string } = {}): Promise<string> {
    return runOk(this.runner, 'git', [...GIT_SAFETY_FLAGS, ...args], {
      cwd: opts.cwd,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        ...(opts.token ? gitAuthEnv(this.baseUrl, opts.token) : {}),
      },
      timeoutMs: 30 * 60_000,
    });
  }

  async syncMirror(mirrorDir: string, remoteUrl: string, token: string): Promise<void> {
    try {
      await this.git(['-C', mirrorDir, 'rev-parse', '--git-dir']);
    } catch {
      await this.git(['clone', '--mirror', '--', remoteUrl, mirrorDir], { token });
      return;
    }
    await this.git(['-C', mirrorDir, 'remote', 'set-url', 'origin', remoteUrl]);
    await this.git(['-C', mirrorDir, 'fetch', '--prune', 'origin'], { token });
  }

  async clone(mirrorDir: string, remoteUrl: string, dest: string, token: string): Promise<void> {
    await this.git(
      ['clone', '--no-hardlinks', '--dissociate', '--reference', mirrorDir, '--', remoteUrl, dest],
      { token },
    );
  }

  async createBranch(dir: string, branch: string, base: string): Promise<void> {
    await this.git(['-C', dir, 'checkout', '-B', branch, `refs/remotes/origin/${base}`, '--']);
  }

  async setIdentity(dir: string, id: GitIdentity): Promise<void> {
    await this.git(['-C', dir, 'config', 'user.name', id.name]);
    await this.git(['-C', dir, 'config', 'user.email', id.email]);
  }

  async commitAll(dir: string, message: string, id: GitIdentity): Promise<boolean> {
    await this.git(['-C', dir, 'add', '-A']);
    const status = await this.git(['-C', dir, 'status', '--porcelain']);
    if (status.trim() === '') return false;
    await this.git([
      '-c',
      `user.name=${id.name}`,
      '-c',
      `user.email=${id.email}`,
      '-C',
      dir,
      'commit',
      '--no-verify',
      '-q',
      '-m',
      message,
    ]);
    return true;
  }

  async commitsAhead(dir: string, base: string): Promise<number> {
    const out = await this.git([
      '-C',
      dir,
      'rev-list',
      '--count',
      `refs/remotes/origin/${base}..HEAD`,
    ]);
    return Number(out.trim()) || 0;
  }

  async changedFiles(dir: string, base: string): Promise<number> {
    const out = await this.git([
      '-C',
      dir,
      'diff',
      '--name-only',
      `refs/remotes/origin/${base}...HEAD`,
    ]);
    return out.split('\n').filter((l) => l.trim() !== '').length;
  }

  async subjects(dir: string, base: string): Promise<string[]> {
    const out = await this.git([
      '-C',
      dir,
      'log',
      '--format=%s',
      `refs/remotes/origin/${base}..HEAD`,
    ]);
    return out.split('\n').filter((l) => l.trim() !== '');
  }

  async headSha(dir: string): Promise<string> {
    return (await this.git(['-C', dir, 'rev-parse', 'HEAD'])).trim();
  }

  async push(dir: string, branch: string, token: string): Promise<void> {
    await this.git(['-C', dir, 'push', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`], {
      token,
    });
  }
}
