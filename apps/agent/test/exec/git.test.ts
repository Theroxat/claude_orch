import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CliGit,
  GIT_SAFETY_ENV,
  GIT_SAFETY_FLAGS,
  GitSafetyError,
  findNestedGit,
  gitAuthEnv,
  symlinkResolvesInTree,
  symlinkStaysInside,
  type GitRepo,
} from '../../src/exec/git';
import { spawnRunner, type CommandRunner, type RunOptions } from '../../src/exec/runner';
import { redact } from '../../src/log';
import { tempDir } from '../helpers/util';

const TOKEN = 'ghs_' + 'T0kenValue'.repeat(4);
const B64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const ID = { name: 'orch test', email: 'orch@example.com' };

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => (tmp = tempDir()));
afterEach(() => tmp.cleanup());

function sh(args: string[], cwd?: string) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    cwd: cwd ?? tmp.dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** Every file under `dir` whose content contains `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && statSync(p).size < 5_000_000 && readFileSync(p).includes(needle)) {
        hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

class RecordingRunner implements CommandRunner {
  calls: { cmd: string; args: readonly string[]; opts?: RunOptions }[] = [];
  async run(cmd: string, args: readonly string[], opts?: RunOptions) {
    this.calls.push({ cmd, args, opts });
    return { code: 0, stdout: args.includes('--list') ? '' : '0\n', stderr: '' };
  }
}

/** Origin with one commit on main, a mirror and a task repo (private git dir + worktree). */
async function realRepo(extraProtocols = ['file']) {
  const origin = join(tmp.dir, 'origin.git');
  const seed = join(tmp.dir, 'seed');
  sh(['init', '-q', '--bare', '-b', 'main', origin]);
  sh(['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  sh(['add', '-A'], seed);
  sh(['commit', '-q', '-m', 'init'], seed);
  sh(['push', '-q', origin, 'main'], seed);
  const git = new CliGit(spawnRunner, 'https://github.com', extraProtocols);
  const mirror = join(tmp.dir, 'data', 'mirrors', 'p.git');
  const repo: GitRepo = {
    gitDir: join(tmp.dir, 'data', 'git', 'asg.git'),
    workTree: join(tmp.dir, 'work', 'asg', 'src'),
  };
  mkdirSync(join(tmp.dir, 'data', 'git'), { recursive: true });
  await git.syncMirror(mirror, origin, TOKEN);
  await git.clone(mirror, origin, repo, TOKEN);
  await git.createBranch(repo, 'orch/issue-1-x', 'main');
  await git.setIdentity(repo, ID);
  await git.seedTaskGit(repo);
  return { git, origin, mirror, repo };
}

/** A git config that runs `touch <sentinel>` from every hook-like key we know of. */
function evilConfig(sentinel: string): string {
  const run = `touch ${sentinel}`;
  return [
    '[core]',
    '\trepositoryformatversion = 0',
    '\tbare = false',
    `\tfsmonitor = ${run}`,
    `\tpager = ${run}`,
    `\teditor = ${run}`,
    `\taskPass = ${run}`,
    `\tsshCommand = ${run}`,
    `\thooksPath = ${join(tmp.dir, 'evil-hooks')}`,
    '[filter "evil"]',
    `\tclean = sh -c '${run}; cat'`,
    `\tsmudge = sh -c '${run}; cat'`,
    `\tprocess = ${run}`,
    '\trequired = true',
    '[diff "evil"]',
    `\ttextconv = ${run}`,
    `\tcommand = ${run}`,
    '[diff]',
    `\texternal = ${run}`,
    '[commit]',
    '\tgpgSign = true',
    '[log]',
    '\tshowSignature = true',
    '[gpg]',
    `\tprogram = ${run}`,
    '[credential]',
    `\thelper = !${run}`,
    '[http]',
    '\tsslVerify = false',
    '\tproxy = http://127.0.0.1:9',
    '',
  ].join('\n');
}

function evilHooks(sentinel: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'post-checkout']) {
    writeFileSync(join(dir, hook), `#!/bin/sh\ntouch "${sentinel}"\n`);
    chmodSync(join(dir, hook), 0o755);
  }
}

/** Runs every agent-side operation of a finished task. */
async function finishTask(git: CliGit, repo: GitRepo) {
  const committed = await git.commitAll(repo, 'orch: changes', ID);
  await git.commitsAhead(repo, 'main');
  await git.changedFiles(repo, 'main');
  await git.subjects(repo, 'main');
  await git.headSha(repo);
  await git.push(repo, 'orch/issue-1-x', TOKEN);
  return committed;
}

describe('git auth and hygiene', () => {
  it('redacts GitHub tokens and auth headers from logs and errors', () => {
    const line = redact(`push failed ${TOKEN} Authorization: Basic ${B64} done`);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(B64);
    expect(line).toContain('Authorization: Basic [REDACTED] done');
  });

  it('passes the token only through the child env, with safety flags, env and an explicit git dir', async () => {
    const r = new RecordingRunner();
    const git = new CliGit(r, 'https://github.com/');
    const repo = { gitDir: join(tmp.dir, 'g.git'), workTree: join(tmp.dir, 'w') };
    await git.clone('/data/mirrors/p.git', 'https://github.com/acme/w.git', repo, TOKEN);
    await git.push(repo, 'orch/issue-1-x', TOKEN);
    await git.commitAll(repo, 'msg', ID);
    for (const c of r.calls) {
      expect(c.args.join(' ')).not.toContain(TOKEN);
      expect(c.args.join(' ')).not.toContain(B64);
      expect(c.args.slice(0, GIT_SAFETY_FLAGS.length)).toEqual(GIT_SAFETY_FLAGS);
      expect(c.args).toContain('protocol.https.allow=always');
      expect(c.args).not.toContain('protocol.file.allow=always');
      expect(c.opts?.env).toMatchObject(GIT_SAFETY_ENV);
    }
    const repoCalls = r.calls.filter((c) =>
      ['add', 'push', 'commit'].some((s) => c.args.includes(s)),
    );
    for (const c of repoCalls) {
      expect(c.args).toContain(`--git-dir=${repo.gitDir}`);
      expect(c.args).toContain(`--work-tree=${repo.workTree}`);
    }
    const authed = r.calls.filter((c) => c.opts?.env?.GIT_CONFIG_VALUE_0);
    expect(authed.map((c) => c.args.find((a) => a === 'clone' || a === 'push'))).toEqual([
      'clone',
      'push',
    ]);
    expect(authed[0]?.opts?.env).toMatchObject(gitAuthEnv('https://github.com', TOKEN));
    expect(authed[0]?.opts?.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    expect(r.calls.find((c) => c.args.includes('add'))?.opts?.env?.GIT_CONFIG_VALUE_0).toBe(
      undefined,
    );
  });

  it('only enables the transport of the git host: a local path clone is refused', async () => {
    await expect(realRepo([])).rejects.toThrow(/transport 'file' not allowed|not allowed/);
  });

  it('real git: private git dir, throwaway task copy, commit and push never leak the token', async () => {
    const { git, origin, mirror, repo } = await realRepo();
    // The worktree has no pointer to the private git dir, only the task's own copy.
    expect(lstatSync(join(repo.workTree, '.git')).isDirectory()).toBe(true);
    expect(readFileSync(join(repo.workTree, '.git', 'config'), 'utf8')).not.toContain(repo.gitDir);
    expect(existsSync(join(repo.gitDir, 'objects', 'info', 'alternates'))).toBe(false);
    // The task commits in its copy: the agent ignores it and squashes the worktree state.
    const marker = join(tmp.dir, 'hook-ran');
    evilHooks(marker, join(repo.workTree, '.git', 'hooks'));
    writeFileSync(join(repo.workTree, 'feature.txt'), 'work\n');
    sh(['-c', 'core.hooksPath=/dev/null', 'add', '-A'], repo.workTree);
    sh(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'task commit'], repo.workTree);
    expect(await git.commitAll(repo, 'feat: work', ID)).toBe(true);
    expect(existsSync(join(repo.workTree, '.git'))).toBe(false);
    expect(await git.commitAll(repo, 'nothing', ID)).toBe(false);
    expect(await git.commitsAhead(repo, 'main')).toBe(1);
    expect(await git.changedFiles(repo, 'main')).toBe(1);
    expect(await git.subjects(repo, 'main')).toEqual(['feat: work']);
    await git.push(repo, 'orch/issue-1-x', TOKEN);
    expect(existsSync(marker)).toBe(false);
    expect(sh(['--git-dir', origin, 'rev-parse', 'refs/heads/orch/issue-1-x']).trim()).toBe(
      await git.headSha(repo),
    );
    const config = readFileSync(join(repo.gitDir, 'config'), 'utf8');
    expect(config).not.toMatch(/extraheader/i);
    for (const dir of [repo.workTree, repo.gitDir, mirror]) {
      expect(filesContaining(dir, TOKEN)).toEqual([]);
      expect(filesContaining(dir, B64)).toEqual([]);
    }
  });

  it('real git: the task creator is the author, the agent stays the committer', async () => {
    const { git, repo } = await realRepo();
    writeFileSync(join(repo.workTree, 'credited.txt'), 'work\n');
    const author = { name: 'alice', email: '4242+alice@users.noreply.github.com' };
    expect(await git.commitAll(repo, 'feat: credited', ID, author)).toBe(true);
    const who = sh(['--git-dir', repo.gitDir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>']).trim();
    expect(who).toBe(`alice <4242+alice@users.noreply.github.com>|${ID.name} <${ID.email}>`);
  });
});

describe('push of a task branch', () => {
  /** A later attempt: a fresh clone of the same project, on the same task branch. */
  async function retry(git: CliGit, origin: string, mirror: string, name: string) {
    const repo: GitRepo = {
      gitDir: join(tmp.dir, 'data', 'git', `${name}.git`),
      workTree: join(tmp.dir, 'work', name, 'src'),
    };
    await git.syncMirror(mirror, origin, TOKEN);
    await git.clone(mirror, origin, repo, TOKEN);
    await git.createBranch(repo, 'orch/issue-1-x', 'main');
    await git.setIdentity(repo, ID);
    await git.seedTaskGit(repo);
    return repo;
  }
  const head = (origin: string) =>
    sh(['--git-dir', origin, 'rev-parse', 'refs/heads/orch/issue-1-x']).trim();

  it('a re-run replaces what an earlier attempt pushed to the task branch', async () => {
    const { git, origin, mirror, repo } = await realRepo();
    writeFileSync(join(repo.workTree, 'first.txt'), 'attempt 1\n');
    await git.commitAll(repo, 'attempt 1', ID);
    await git.push(repo, 'orch/issue-1-x', TOKEN);

    const again = await retry(git, origin, mirror, 'asg2');
    writeFileSync(join(again.workTree, 'second.txt'), 'attempt 2\n');
    await git.commitAll(again, 'attempt 2', ID);
    await git.push(again, 'orch/issue-1-x', TOKEN);
    expect(head(origin)).toBe(await git.headSha(again));
  });

  it('still refuses to overwrite commits pushed to the branch after the clone', async () => {
    const { git, origin, mirror, repo } = await realRepo();
    const again = await retry(git, origin, mirror, 'asg2');
    // Someone pushes to the task branch while this attempt runs.
    writeFileSync(join(repo.workTree, 'other.txt'), 'meanwhile\n');
    await git.commitAll(repo, 'meanwhile', ID);
    await git.push(repo, 'orch/issue-1-x', TOKEN);
    const theirs = head(origin);
    writeFileSync(join(again.workTree, 'mine.txt'), 'mine\n');
    await git.commitAll(again, 'mine', ID);
    await expect(git.push(again, 'orch/issue-1-x', TOKEN)).rejects.toThrow();
    expect(head(origin)).toBe(theirs);
  });

  it('never forces a branch outside orch/ (e.g. the base branch)', async () => {
    const { git, origin, mirror, repo } = await realRepo();
    const again = await retry(git, origin, mirror, 'asg2');
    writeFileSync(join(repo.workTree, 'a.txt'), 'a\n');
    await git.commitAll(repo, 'a', ID);
    await git.push(repo, 'main', TOKEN);
    const main = sh(['--git-dir', origin, 'rev-parse', 'refs/heads/main']).trim();
    writeFileSync(join(again.workTree, 'b.txt'), 'b\n');
    await git.commitAll(again, 'b', ID);
    await expect(git.push(again, 'main', TOKEN)).rejects.toThrow();
    expect(sh(['--git-dir', origin, 'rev-parse', 'refs/heads/main']).trim()).toBe(main);
  });
});

describe('a hostile task cannot make the agent run anything through git', () => {
  it('control: the same evil .git/config + .gitattributes DO run with a plain git', async () => {
    const { repo } = await realRepo();
    const sentinel = join(tmp.dir, 'control-ran');
    writeFileSync(join(repo.workTree, '.git', 'config'), evilConfig(sentinel));
    writeFileSync(join(repo.workTree, '.gitattributes'), '* filter=evil diff=evil\n');
    writeFileSync(join(repo.workTree, 'feature.txt'), 'work\n');
    try {
      execFileSync('git', ['add', '-A'], { cwd: repo.workTree, stdio: 'ignore' });
    } catch {
      // the evil filter may make it fail; the sentinel is what matters
    }
    expect(existsSync(sentinel)).toBe(true);
  });

  it('ignores a malicious .git/config and .gitattributes written in the worktree', async () => {
    const { git, repo } = await realRepo();
    const sentinel = join(tmp.dir, 'sentinel');
    evilHooks(sentinel, join(tmp.dir, 'evil-hooks'));
    evilHooks(sentinel, join(repo.workTree, '.git', 'hooks'));
    writeFileSync(join(repo.workTree, '.git', 'config'), evilConfig(sentinel));
    writeFileSync(join(repo.workTree, '.git', 'info', 'attributes'), '* filter=evil diff=evil\n');
    writeFileSync(join(repo.workTree, '.gitattributes'), '* filter=evil diff=evil\n');
    writeFileSync(join(repo.workTree, 'feature.txt'), 'work\n');
    expect(await finishTask(git, repo)).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
    expect(sh(['--git-dir', repo.gitDir, 'show', 'HEAD:feature.txt'])).toBe('work\n');
  });

  it('ignores a `gitdir:` file and a .git symlink pointing at a hostile git dir', async () => {
    for (const kind of ['gitfile', 'symlink'] as const) {
      const { git, repo } = await realRepo();
      const sentinel = join(tmp.dir, `sentinel-${kind}`);
      const evil = join(tmp.dir, `evil-${kind}.git`);
      sh(['init', '-q', '--bare', evil]);
      writeFileSync(join(evil, 'config'), evilConfig(sentinel));
      evilHooks(sentinel, join(evil, 'hooks'));
      evilHooks(sentinel, join(tmp.dir, 'evil-hooks'));
      const dotGit = join(repo.workTree, '.git');
      execFileSync('rm', ['-rf', dotGit]);
      if (kind === 'gitfile') writeFileSync(dotGit, `gitdir: ${evil}\n`);
      else symlinkSync(evil, dotGit);
      writeFileSync(join(repo.workTree, '.gitattributes'), '* filter=evil\n');
      writeFileSync(join(repo.workTree, `f-${kind}.txt`), 'x\n');
      expect(await finishTask(git, repo)).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(evil)).toBe(true); // the link was removed, not its target
      execFileSync('rm', [
        '-rf',
        join(tmp.dir, 'origin.git'),
        join(tmp.dir, 'seed'),
        join(tmp.dir, 'data'),
        join(tmp.dir, 'work'),
      ]);
    }
  });

  it('refuses to stage when the private config gained a filter driver', async () => {
    const { git, repo } = await realRepo();
    const sentinel = join(tmp.dir, 'sentinel');
    sh(['config', '--file', join(repo.gitDir, 'config'), 'filter.evil.clean', `touch ${sentinel}`]);
    writeFileSync(join(repo.workTree, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(repo.workTree, 'feature.txt'), 'work\n');
    await expect(git.commitAll(repo, 'x', ID)).rejects.toBeInstanceOf(GitSafetyError);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('refuses nested .git repositories (a submodule config could run code)', async () => {
    const { git, repo } = await realRepo();
    const sentinel = join(tmp.dir, 'sentinel');
    const nested = join(repo.workTree, 'vendor', 'lib');
    mkdirSync(nested, { recursive: true });
    sh(['init', '-q', nested]);
    writeFileSync(join(nested, '.git', 'config'), evilConfig(sentinel));
    writeFileSync(join(nested, 'a.txt'), 'a\n');
    await expect(git.commitAll(repo, 'x', ID)).rejects.toThrow(
      /nested git repositories: vendor\/lib\/.git/,
    );
    expect(existsSync(sentinel)).toBe(false);
  });

  it('refuses to commit a symlink out of the worktree, accepts one inside', async () => {
    const { git, repo } = await realRepo();
    symlinkSync('README.md', join(repo.workTree, 'inside-link'));
    expect(await git.commitAll(repo, 'ok link', ID)).toBe(true);
    symlinkSync('/etc/passwd', join(repo.workTree, 'abs-link'));
    await expect(git.commitAll(repo, 'bad', ID)).rejects.toThrow(/abs-link: symlink/);
    execFileSync('rm', [join(repo.workTree, 'abs-link')]);
    symlinkSync('../../../../secrets', join(repo.workTree, 'up-link'));
    await expect(git.commitAll(repo, 'bad', ID)).rejects.toThrow(/up-link: symlink/);
    // Unstaged again after a refusal.
    expect(sh(['--git-dir', repo.gitDir, 'diff', '--cached', '--name-only'])).toBe('');
  });

  it('refuses a symlink that escapes through another symlink (text normalization is not enough)', async () => {
    const { git, repo } = await realRepo();
    mkdirSync(join(repo.workTree, 'x'));
    writeFileSync(join(repo.workTree, 'x', 'keep'), '');
    symlinkSync('.', join(repo.workTree, 's'));
    // "s/x/../.." normalizes to "." but the kernel resolves s first: it is the worktree's parent.
    symlinkSync('s/x/../..', join(repo.workTree, 'esc'));
    await expect(git.commitAll(repo, 'bad', ID)).rejects.toThrow(/esc: symlink/);
    execFileSync('rm', [join(repo.workTree, 'esc')]);
    // a chain that stays inside is fine
    symlinkSync('s/x/keep', join(repo.workTree, 'ok'));
    expect(await git.commitAll(repo, 'ok chain', ID)).toBe(true);
  });

  it('two-commit bypass: a link committed earlier is re-checked when another link changes', async () => {
    const { git, repo } = await realRepo();
    // Commit A: s/ is a real directory, so esc -> s/x/../.. resolves to the worktree root.
    mkdirSync(join(repo.workTree, 's', 'x'), { recursive: true });
    writeFileSync(join(repo.workTree, 's', 'x', 'keep'), '');
    symlinkSync('s/x/../..', join(repo.workTree, 'esc'));
    expect(await git.commitAll(repo, 'A', ID)).toBe(true);
    // Commit B only turns s into `s -> .`: esc (unchanged) now points at the parent.
    rmSync(join(repo.workTree, 's'), { recursive: true });
    symlinkSync('.', join(repo.workTree, 's'));
    await expect(git.commitAll(repo, 'B', ID)).rejects.toThrow(/esc: symlink/);
    expect(sh(['--git-dir', repo.gitDir, 'diff', '--cached', '--name-only'])).toBe('');
  });

  it('refuses absolute, looping and .git symlink targets', async () => {
    const { git, repo } = await realRepo();
    const cases: [string, string][] = [
      ['abs', '/tmp'],
      ['loop', 'loop'],
      ['dotgit', '.git/config'],
      ['dotgit2', 'sub/../.GIT'],
    ];
    for (const [name, target] of cases) {
      symlinkSync(target, join(repo.workTree, name));
      await expect(git.commitAll(repo, 'bad', ID), name).rejects.toThrow(
        new RegExp(`${name}: symlink`),
      );
      rmSync(join(repo.workTree, name));
    }
    // A loop between two links.
    symlinkSync('b/x', join(repo.workTree, 'a'));
    symlinkSync('a/y', join(repo.workTree, 'b'));
    await expect(git.commitAll(repo, 'bad', ID)).rejects.toThrow(/symlink/);
  });

  it('helpers: tree-based symlink resolution (index, not disk)', () => {
    const tree = (o: Record<string, string>) => new Map(Object.entries(o));
    expect(symlinkResolvesInTree(tree({ s: '.', esc: 's/x/../..' }), 'esc')).toBe(false);
    expect(symlinkResolvesInTree(tree({ esc: 's/x/../..' }), 'esc')).toBe(true);
    expect(symlinkResolvesInTree(tree({ s: '.', ok: 's/x/keep' }), 'ok')).toBe(true);
    expect(symlinkResolvesInTree(tree({ a: 'a' }), 'a')).toBe(false);
    expect(symlinkResolvesInTree(tree({ a: '/etc' }), 'a')).toBe(false);
    expect(symlinkResolvesInTree(tree({ d: 'x/.git' }), 'd')).toBe(false);
    // A case-insensitive checkout resolves S through s.
    expect(symlinkResolvesInTree(tree({ s: '.', esc: 'S/x/../..' }), 'esc')).toBe(false);
    expect(symlinkResolvesInTree(tree({ s: '.', S: 'x', e: 'S' }), 'e')).toBe(false);
    // Chains through other links, in subdirectories too.
    expect(symlinkResolvesInTree(tree({ s: '.', e: 's/s/x/../../..' }), 'e')).toBe(false);
    expect(symlinkResolvesInTree(tree({ 'a/s': '..', 'a/e': 's/../x' }), 'a/e')).toBe(false);
    expect(symlinkResolvesInTree(tree({ 'a/s': '..', 'a/e': 's/x' }), 'a/e')).toBe(true);
  });

  it('helpers: nested .git detection and symlink containment', () => {
    const root = join(tmp.dir, 'wt');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'a', '.GIT'), { recursive: true });
    writeFileSync(join(root, 'a', 'b'), '');
    expect(findNestedGit(root)).toEqual(['a/.GIT']);
    expect(symlinkStaysInside('a/b', '../c')).toBe(true);
    expect(symlinkStaysInside('a/b', '../../c')).toBe(false);
    expect(symlinkStaysInside('a', '/etc')).toBe(false);
    expect(symlinkStaysInside('a', '.git/config')).toBe(false);
  });
});
