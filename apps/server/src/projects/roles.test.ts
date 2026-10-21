import { describe, expect, it } from 'vitest';
import { mapGithubRoleName } from '../github';
import { canParticipate, canSee, canSubmit, toOrchRole } from './roles';

describe('role mapping', () => {
  it('maps GitHub roles to orch roles', () => {
    expect(toOrchRole('ADMIN')).toBe('owner');
    expect(toOrchRole('MAINTAIN')).toBe('submitter');
    expect(toOrchRole('WRITE')).toBe('submitter');
    expect(toOrchRole('TRIAGE')).toBe('proposer');
    expect(toOrchRole('READ')).toBe('proposer');
    expect(toOrchRole('NONE')).toBe('none');
  });

  it('maps GitHub role names', () => {
    expect(mapGithubRoleName('admin')).toBe('ADMIN');
    expect(mapGithubRoleName('maintain')).toBe('MAINTAIN');
    expect(mapGithubRoleName('custom-role')).toBe('NONE');
    expect(mapGithubRoleName(undefined)).toBe('NONE');
  });

  it('derives rights from policy, role and overrides', () => {
    expect(canParticipate('GITHUB', 'READ')).toBe(true);
    expect(canParticipate('GITHUB', 'NONE')).toBe(false);
    expect(canParticipate('GITHUB', 'READ', { canParticipate: false })).toBe(false);
    expect(canParticipate('ALLOWLIST', 'ADMIN')).toBe(false);
    expect(canParticipate('ALLOWLIST', 'NONE', { canParticipate: true })).toBe(true);
    expect(canParticipate('ALL_MEMBERS', 'NONE')).toBe(true);
    expect(canSubmit('GITHUB', 'WRITE')).toBe(true);
    expect(canSubmit('GITHUB', 'READ')).toBe(false);
    expect(canSubmit('ALLOWLIST', 'ADMIN')).toBe(false);
    expect(canSubmit('GITHUB', 'READ', { canSubmit: true })).toBe(true);
  });

  it('applies discover visibility', () => {
    expect(canSee('ALL_MEMBERS', 'NONE')).toBe(true);
    expect(canSee('COLLABORATORS', 'NONE')).toBe(false);
    expect(canSee('COLLABORATORS', 'READ')).toBe(true);
    expect(canSee('ALLOWLIST', 'ADMIN')).toBe(false);
    expect(canSee('ALLOWLIST', 'NONE', { canParticipate: true })).toBe(true);
  });
});
