import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliGit, GIT_SAFETY_FLAGS, gitAuthEnv } from '../../src/exec/git';
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
    cwd,
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
    return { code: 0, stdout: '0\n', stderr: '' };
  }
}

describe('git auth and hygiene', () => {
  it('redacts GitHub tokens and auth headers from logs and errors', () => {
    const line = redact(`push failed ${TOKEN} Authorization: Basic ${B64} done`);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(B64);
    expect(line).toContain('Authorization: Basic [REDACTED] done');
  });

  it('passes the token only through the child env, scoped to the git host', async () => {
    const r = new RecordingRunner();
    const git = new CliGit(r, 'https://github.com/');
    await git.clone('/data/mirrors/p.git', 'https://github.com/acme/w.git', '/w/a/src', TOKEN);
    await git.push('/w/a/src', 'orch/issue-1-x', TOKEN);
    await git.commitAll('/w/a/src', 'msg', ID);
    for (const c of r.calls) {
      expect(c.args.join(' ')).not.toContain(TOKEN);
      expect(c.args.join(' ')).not.toContain(B64);
      expect(c.args.slice(0, GIT_SAFETY_FLAGS.length)).toEqual(GIT_SAFETY_FLAGS);
    }
    const authed = r.calls.filter((c) => c.opts?.env?.GIT_CONFIG_VALUE_0);
    expect(authed.map((c) => c.args[GIT_SAFETY_FLAGS.length])).toEqual(['clone', '-C']);
    expect(authed[0]?.opts?.env).toMatchObject(gitAuthEnv('https://github.com', TOKEN));
    expect(authed[0]?.opts?.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    expect(r.calls.find((c) => c.args.includes('add'))?.opts?.env?.GIT_CONFIG_VALUE_0).toBe(
      undefined,
    );
  });

  it('real git: mirror, clone, branch, commit and push never write the token to disk or run hooks', async () => {
    const origin = join(tmp.dir, 'origin.git');
    const seed = join(tmp.dir, 'seed');
    sh(['init', '-q', '--bare', '-b', 'main', origin]);
    sh(['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'README.md'), 'hello\n');
    sh(['add', '-A'], seed);
    sh(['commit', '-q', '-m', 'init'], seed);
    sh(['push', '-q', origin, 'main'], seed);

    const git = new CliGit(spawnRunner, 'https://github.com');
    const mirror = join(tmp.dir, 'mirrors', 'p.git');
    const clone = join(tmp.dir, 'work', 'asg', 'src');
    await git.syncMirror(mirror, origin, TOKEN);
    await git.syncMirror(mirror, origin, TOKEN); // refresh path
    await git.clone(mirror, origin, clone, TOKEN);
    await git.createBranch(clone, 'orch/issue-1-x', 'main');
    await git.setIdentity(clone, ID);
    expect(existsSync(join(clone, '.git', 'objects', 'info', 'alternates'))).toBe(false);

    // A hostile clone: hooks that would run in the agent's git.
    const marker = join(tmp.dir, 'hook-ran');
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']) {
      const p = join(clone, '.git', 'hooks', hook);
      writeFileSync(p, `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      chmodSync(p, 0o755);
    }
    writeFileSync(join(clone, 'feature.txt'), 'work\n');
    expect(await git.commitAll(clone, 'feat: work', ID)).toBe(true);
    expect(await git.commitAll(clone, 'nothing', ID)).toBe(false);
    expect(await git.commitsAhead(clone, 'main')).toBe(1);
    expect(await git.changedFiles(clone, 'main')).toBe(1);
    expect(await git.subjects(clone, 'main')).toEqual(['feat: work']);
    await git.push(clone, 'orch/issue-1-x', TOKEN);

    expect(existsSync(marker)).toBe(false);
    expect(sh(['--git-dir', origin, 'rev-parse', 'refs/heads/orch/issue-1-x']).trim()).toBe(
      await git.headSha(clone),
    );
    const config = readFileSync(join(clone, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(B64);
    expect(config).not.toMatch(/extraheader/i);
    for (const dir of [clone, mirror]) {
      expect(filesContaining(dir, TOKEN)).toEqual([]);
      expect(filesContaining(dir, B64)).toEqual([]);
    }
  });
});
