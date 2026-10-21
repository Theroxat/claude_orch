/**
 * Git operations for a task (PLAN 5.1, 5.5).
 *
 * The task container can write anything in its clone, and the agent holds the docker socket, so
 * nothing the task writes may ever be interpreted by the agent's git:
 *  - the repository's git dir is PRIVATE (`--separate-git-dir` under the agent's data dir). It is
 *    never mounted; the worktree is. The `gitdir:` file git leaves in the worktree is deleted.
 *  - every call names `--git-dir` and `--work-tree` explicitly (no discovery, so a task-written
 *    `.git` file, directory or symlink is never read), ignores the global and system config and
 *    attributes, and forces every config key that could run a program or leak a token
 *    (`GIT_SAFETY_FLAGS`). Only the allowed transport protocols are enabled.
 *  - the private config is checked against an allowlist before staging (so no filter, textconv,
 *    fsmonitor, include, ... can be configured), nested `.git` entries and staged gitlinks
 *    are refused, and every symlink of the staged tree (read from the index) must resolve
 *    inside it.
 *  - the task gets its own throwaway copy of the git dir at `<worktree>/.git` (so `git diff` and
 *    `git commit` work inside the container). The agent never reads it and deletes it before
 *    staging: the task's own commits are squashed into one agent commit.
 *
 * Auth: the installation token is given to ONE git child at a time as an `http.<base>/.extraHeader`
 * through `GIT_CONFIG_COUNT/KEY/VALUE` environment variables. It is never on the command line,
 * in a remote URL, in a git config file or anywhere else on disk.
 */
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { runOk, type CommandRunner } from './runner';

export interface GitIdentity {
  name: string;
  email: string;
}

/** A task repository: the agent-private git dir and the (mounted) worktree. */
export interface GitRepo {
  gitDir: string;
  workTree: string;
}

export interface GitOps {
  /** Creates or refreshes the bare mirror (agent-only, never mounted). */
  syncMirror(mirrorDir: string, remoteUrl: string, token: string): Promise<void>;
  /** Clone with a private git dir; objects are borrowed from the mirror then dissociated. */
  clone(mirrorDir: string, remoteUrl: string, repo: GitRepo, token: string): Promise<void>;
  /** New branch `branch` from `origin/<base>`, checked out. */
  createBranch(repo: GitRepo, branch: string, base: string): Promise<void>;
  setIdentity(repo: GitRepo, id: GitIdentity): Promise<void>;
  /** Writes the task's throwaway copy of the git dir at `<workTree>/.git`. */
  seedTaskGit(repo: GitRepo): Promise<void>;
  /** Commits every pending worktree change. Returns false when there was nothing. */
  commitAll(repo: GitRepo, message: string, id: GitIdentity): Promise<boolean>;
  /** Commits on HEAD that are not on `origin/<base>`. */
  commitsAhead(repo: GitRepo, base: string): Promise<number>;
  changedFiles(repo: GitRepo, base: string): Promise<number>;
  subjects(repo: GitRepo, base: string): Promise<string[]>;
  headSha(repo: GitRepo): Promise<string>;
  push(repo: GitRepo, branch: string, token: string): Promise<void>;
}

export class GitSafetyError extends Error {
  override name = 'GitSafetyError';
}

/** `-c` flags put before every git subcommand. */
export const GIT_SAFETY_FLAGS = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.attributesFile=/dev/null',
  'core.askPass=',
  'core.pager=cat',
  'core.editor=false',
  'core.sshCommand=false',
  'credential.helper=',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'log.showSignature=false',
  'gpg.program=false',
  'diff.external=',
  'diff.ignoreSubmodules=all',
  'status.submoduleSummary=false',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'http.sslVerify=true',
  'safe.directory=*',
  'protocol.allow=never',
].flatMap((kv) => ['-c', kv]);

/** Environment for every git child: no global/system config or attributes, no prompts. */
export const GIT_SAFETY_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
};

/** Keys allowed in a private task config (all written by `git clone` or `setIdentity`). */
const ALLOWED_CONFIG_KEY =
  /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch)|branch\..+\.(remote|merge)|user\.(name|email)|extensions\.(objectformat|refstorage))$/i;

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

/** Relative paths of every `.git` entry below the worktree root (symlinks are not followed). */
export function findNestedGit(workTree: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (/^\.git$/i.test(e.name)) {
        if (rel !== '') hits.push(r);
        continue;
      }
      if (e.isDirectory()) walk(join(dir, e.name), r);
    }
  };
  walk(workTree, '');
  return hits;
}

/** True when a symlink at `path` (repo-relative) with `target` stays inside the worktree. */
export function symlinkStaysInside(path: string, target: string): boolean {
  if (target === '' || posix.isAbsolute(target) || target.includes('\0')) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved !== '..' && !resolved.startsWith('../') && !/(^|\/)\.git(\/|$)/i.test(resolved);
}

/**
 * True when the symlink at `path` resolves inside the tree, following the tree's OTHER symlinks
 * the way the kernel would after a checkout: text normalization alone is not enough (with
 * `s -> .`, the target `s/x/../..` normalizes to `.` but resolves to the worktree's parent).
 * `links` maps every symlink path of the tree (read from the index, never the disk) to its
 * target. Lookups ignore case, as a case-insensitive checkout (macOS, Windows) would; two links
 * differing only by case are refused. Absolute targets, a climb above the root, more than 40 hops
 * (ELOOP) and a result inside `.git` are refused.
 */
export function symlinkResolvesInTree(links: ReadonlyMap<string, string>, path: string): boolean {
  const folded = new Map<string, string | null>();
  for (const [p, t] of links) {
    const k = p.toLowerCase();
    folded.set(k, folded.has(k) && folded.get(k) !== t ? null : t);
  }
  const out: string[] = [];
  let rest = path.split('/');
  let hops = 0;
  while (rest.length > 0) {
    const c = rest.shift()!;
    if (c === '' || c === '.') continue;
    if (c === '..') {
      if (out.length === 0) return false;
      out.pop();
      continue;
    }
    out.push(c);
    const target = folded.get(out.join('/').toLowerCase());
    if (target === undefined) continue; // a directory, a file or nothing: a plain name
    if (target === null) return false; // ambiguous on a case-insensitive checkout
    if (++hops > 40) return false; // ELOOP
    if (target === '' || posix.isAbsolute(target) || target.includes('\0')) return false;
    out.pop();
    rest = [...target.split('/'), ...rest];
  }
  return !out.some((c) => /^\.git$/i.test(c));
}

export class CliGit implements GitOps {
  private readonly flags: string[];

  constructor(
    private readonly runner: CommandRunner,
    /** Git host base URL, e.g. https://github.com. Its scheme is the only enabled transport. */
    private readonly baseUrl: string,
    /** Extra transports to enable (tests use `file`). */
    extraProtocols: string[] = [],
  ) {
    const scheme = /^(https?):/i.exec(baseUrl)?.[1]?.toLowerCase() ?? 'https';
    const protocols = new Set(['https', scheme, ...extraProtocols]);
    this.flags = [
      ...GIT_SAFETY_FLAGS,
      ...[...protocols].flatMap((p) => ['-c', `protocol.${p}.allow=always`]),
    ];
  }

  private git(
    args: string[],
    opts: { repo?: GitRepo; cwd?: string; token?: string; input?: string } = {},
  ): Promise<string> {
    const repoArgs = opts.repo
      ? [`--git-dir=${opts.repo.gitDir}`, `--work-tree=${opts.repo.workTree}`]
      : [];
    return runOk(this.runner, 'git', [...this.flags, ...repoArgs, ...args], {
      cwd: opts.cwd ?? opts.repo?.workTree,
      input: opts.input,
      env: {
        ...GIT_SAFETY_ENV,
        ...(opts.token ? gitAuthEnv(this.baseUrl, opts.token) : {}),
      },
      timeoutMs: 30 * 60_000,
    });
  }

  async syncMirror(mirrorDir: string, remoteUrl: string, token: string): Promise<void> {
    if (!existsSync(join(mirrorDir, 'HEAD'))) {
      await this.git(['clone', '--mirror', '--', remoteUrl, mirrorDir], { token });
      return;
    }
    await this.git([`--git-dir=${mirrorDir}`, 'remote', 'set-url', 'origin', remoteUrl]);
    await this.git([`--git-dir=${mirrorDir}`, 'fetch', '--prune', 'origin'], { token });
  }

  async clone(mirrorDir: string, remoteUrl: string, repo: GitRepo, token: string): Promise<void> {
    await this.git(
      [
        'clone',
        '--no-hardlinks',
        '--dissociate',
        '--reference',
        mirrorDir,
        `--separate-git-dir=${repo.gitDir}`,
        '--',
        remoteUrl,
        repo.workTree,
      ],
      { token, cwd: '/' },
    );
    // The `gitdir: <private path>` file: the worktree must not point at the private git dir.
    rmSync(join(repo.workTree, '.git'), { recursive: true, force: true });
    await this.assertPrivateConfig(repo);
  }

  async createBranch(repo: GitRepo, branch: string, base: string): Promise<void> {
    await this.git(['checkout', '-q', '-B', branch, `refs/remotes/origin/${base}`, '--'], {
      repo,
    });
  }

  async setIdentity(repo: GitRepo, id: GitIdentity): Promise<void> {
    const file = join(repo.gitDir, 'config');
    await this.git(['config', '--file', file, 'user.name', id.name], { cwd: '/' });
    await this.git(['config', '--file', file, 'user.email', id.email], { cwd: '/' });
  }

  async seedTaskGit(repo: GitRepo): Promise<void> {
    await this.assertPrivateConfig(repo);
    const dest = join(repo.workTree, '.git');
    rmSync(dest, { recursive: true, force: true });
    cpSync(repo.gitDir, dest, { recursive: true, verbatimSymlinks: true });
  }

  /** Refuses any private config key outside the allowlist (filters, includes, programs, ...). */
  async assertPrivateConfig(repo: GitRepo): Promise<void> {
    const out = await this.git(
      ['config', '--file', join(repo.gitDir, 'config'), '--no-includes', '--null', '--list'],
      { cwd: '/' },
    );
    const bad = out
      .split('\0')
      .filter((e) => e !== '')
      .map((e) => e.split('\n', 1)[0] ?? '')
      .filter((k) => !ALLOWED_CONFIG_KEY.test(k));
    if (bad.length > 0) {
      throw new GitSafetyError(`Unexpected key(s) in the task git config: ${bad.join(', ')}`);
    }
  }

  async commitAll(repo: GitRepo, message: string, id: GitIdentity): Promise<boolean> {
    // The task's throwaway git dir (or whatever the task put there) is never read nor committed.
    rmSync(join(repo.workTree, '.git'), { recursive: true, force: true });
    const nested = findNestedGit(repo.workTree);
    if (nested.length > 0) {
      throw new GitSafetyError(
        `Refusing to commit nested git repositories: ${nested.slice(0, 10).join(', ')}`,
      );
    }
    await this.assertPrivateConfig(repo);
    await this.git(['add', '-A'], { repo });
    const changed = (
      await this.git(['diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD', '--'], {
        repo,
      })
    )
      .split('\0')
      .filter((p) => p !== '');
    if (changed.length === 0) return false;
    try {
      await this.checkStaged(repo, new Set(changed));
    } catch (err) {
      await this.git(['reset', '-q'], { repo }).catch(() => undefined);
      throw err;
    }
    await this.git(
      [
        '-c',
        `user.name=${id.name}`,
        '-c',
        `user.email=${id.email}`,
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '-q',
        '-m',
        message,
      ],
      { repo },
    );
    return true;
  }

  /**
   * The staged tree, read from the index (never the disk, which a task process may still
   * change): changed entries may not be a `.git` path or a gitlink, and EVERY symlink of the tree,
   * not only the changed ones, must resolve inside it through the tree's other symlinks.
   * Otherwise a link committed earlier (`esc -> s/x/../..` while `s/` is a directory) escapes
   * once a later commit turns `s` into `s -> .`.
   */
  private async checkStaged(repo: GitRepo, changed: Set<string>): Promise<void> {
    const problems: string[] = [];
    const links = new Map<string, string>();
    const entries = (await this.git(['ls-files', '-s', '-z'], { repo })).split('\0');
    for (const entry of entries) {
      const m = /^(\d{6}) ([0-9a-f]{40,64}) \d\t([\s\S]+)$/.exec(entry);
      if (!m) continue;
      const [, mode, sha, path] = m as unknown as [string, string, string, string];
      if (changed.has(path)) {
        if (path.split('/').some((c) => /^\.git$/i.test(c))) problems.push(`${path}: .git path`);
        else if (mode === '160000') problems.push(`${path}: nested repository (gitlink)`);
      }
      if (mode === '120000') links.set(path, await this.git(['cat-file', 'blob', sha], { repo }));
    }
    for (const [path, target] of links) {
      if (!symlinkStaysInside(path, target) || !symlinkResolvesInTree(links, path)) {
        problems.push(
          `${path}: symlink to ${JSON.stringify(target.slice(0, 200))} leaves the tree`,
        );
      }
    }
    if (problems.length > 0) {
      throw new GitSafetyError(`Refusing to commit: ${problems.slice(0, 10).join('; ')}`);
    }
  }

  async commitsAhead(repo: GitRepo, base: string): Promise<number> {
    const out = await this.git(['rev-list', '--count', `refs/remotes/origin/${base}..HEAD`], {
      repo,
    });
    return Number(out.trim()) || 0;
  }

  async changedFiles(repo: GitRepo, base: string): Promise<number> {
    const out = await this.git(
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        '-z',
        `refs/remotes/origin/${base}...HEAD`,
        '--',
      ],
      { repo },
    );
    return out.split('\0').filter((l) => l !== '').length;
  }

  async subjects(repo: GitRepo, base: string): Promise<string[]> {
    const out = await this.git(
      ['log', '--no-show-signature', '--format=%s', `refs/remotes/origin/${base}..HEAD`, '--'],
      { repo },
    );
    return out.split('\n').filter((l) => l.trim() !== '');
  }

  async headSha(repo: GitRepo): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'], { repo })).trim();
  }

  async push(repo: GitRepo, branch: string, token: string): Promise<void> {
    await this.git(['push', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`], {
      repo,
      token,
    });
  }
}
