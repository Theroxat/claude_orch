import type { GithubRole, MyRole, Policy, Visibility } from '@orch/shared';

/** GitHub repo role -> orch role. Admin = owner, Write/Maintain = submit, Read/Triage = propose. */
export function toOrchRole(role: GithubRole): MyRole {
  switch (role) {
    case 'ADMIN':
      return 'owner';
    case 'MAINTAIN':
    case 'WRITE':
      return 'submitter';
    case 'TRIAGE':
    case 'READ':
      return 'proposer';
    default:
      return 'none';
  }
}

export interface Overrides {
  canSubmit?: boolean | null;
  canParticipate?: boolean | null;
}

/** Can the user join the pool of a project? Owner overrides win over the policy. */
export function canParticipate(policy: Policy, role: GithubRole, o: Overrides = {}): boolean {
  if (o.canParticipate === false) return false;
  if (o.canParticipate === true) return true;
  switch (policy) {
    case 'ALL_MEMBERS':
      return true;
    case 'ALLOWLIST':
      return false;
    default:
      return role !== 'NONE';
  }
}

export function canSubmit(policy: 'GITHUB' | 'ALLOWLIST', role: GithubRole, o: Overrides = {}) {
  if (o.canSubmit === false) return false;
  if (o.canSubmit === true) return true;
  return policy === 'GITHUB' && (role === 'ADMIN' || role === 'MAINTAIN' || role === 'WRITE');
}

/** Does the project show up in Discover for this (non-owner) user? */
export function canSee(visibility: Visibility, role: GithubRole, o: Overrides = {}): boolean {
  switch (visibility) {
    case 'ALL_MEMBERS':
      return true;
    case 'COLLABORATORS':
      return role !== 'NONE';
    default:
      return o.canParticipate === true || o.canSubmit === true;
  }
}
