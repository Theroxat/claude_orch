import { describe, expect, it } from 'vitest';
import {
  assertSafeId,
  attachCommand,
  branchName,
  containerName,
  isValidBranch,
  parseIssueRef,
  pickBranch,
  slugify,
} from '../../src/exec/naming';

describe('branch naming and slugging', () => {
  it('slugifies titles to lowercase ascii words', () => {
    expect(slugify('Add a Dark-Mode toggle!')).toBe('add-a-dark-mode-toggle');
    expect(slugify('  Café   crème: déjà vu  ')).toBe('cafe-creme-deja-vu');
    expect(slugify('***')).toBe('task');
    expect(slugify('')).toBe('task');
    expect(slugify('fix `rm -rf /` in ../scripts; $(whoami)')).toBe('fix-rm-rf-in-scripts-whoami');
  });

  it('caps the slug length without a trailing dash', () => {
    const s = slugify('a'.repeat(39) + ' bbbbbbb');
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });

  it('builds orch/issue-<n>-<slug>', () => {
    expect(branchName(12, 'Fix login bug')).toBe('orch/issue-12-fix-login-bug');
  });

  it('validates server branch names and falls back to the computed one', () => {
    expect(isValidBranch('orch/issue-1-x')).toBe(true);
    for (const bad of ['-x', 'a..b', 'a/.hidden', 'a b', 'x.lock', '/a', 'a//b', '']) {
      expect(isValidBranch(bad)).toBe(false);
    }
    expect(pickBranch('orch/issue-3-ok', 3, 'Whatever')).toBe('orch/issue-3-ok');
    expect(pickBranch('bad..name', 3, 'Whatever')).toBe('orch/issue-3-whatever');
    expect(pickBranch('', 3, 'Whatever')).toBe('orch/issue-3-whatever');
  });

  it('parses issue references', () => {
    expect(parseIssueRef('12')).toEqual({ issue: 12 });
    expect(parseIssueRef('acme/widgets#7')).toEqual({ project: 'acme/widgets', issue: 7 });
    expect(parseIssueRef('0')).toBeNull();
    expect(parseIssueRef('x')).toBeNull();
    expect(parseIssueRef('a#1')).toBeNull();
  });

  it('refuses unsafe assignment ids and derives docker-safe names', () => {
    expect(() => assertSafeId('../etc')).toThrow();
    expect(() => assertSafeId('a/b')).toThrow();
    expect(containerName(5, 'Asg_X1')).toBe('orch-task-5-asg-x1');
    expect(attachCommand(5)).toBe(
      'docker compose -f ~/orch/compose.yaml exec agent screen -r issue-5',
    );
  });
});
