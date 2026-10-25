import type { AccessGrant, AccessInvite } from '@prisma/client';
import type { PrismaClient } from '../db';

/** Signed-token purposes (each gets its own HKDF sub-key of ORCH_ENCRYPTION_KEY). */
export const ACCESS_REQUEST_PURPOSE = 'access-request';
export const INVITE_COOKIE_PURPOSE = 'invite-cookie';
export const ACCESS_REQUEST_TTL_MS = 15 * 60_000;
export const INVITE_COOKIE = 'orch_invite';
export const INVITE_COOKIE_TTL_SEC = 15 * 60;

/** GitHub login syntax: alphanumerics and single inner hyphens, at most 39 characters. */
export const GITHUB_LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export interface GrantView {
  id: string;
  githubLogin: string;
  githubUserId: string | null;
  avatarUrl: string | null;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  note: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface InviteView {
  id: string;
  multiUse: boolean;
  expiresAt: string;
  uses: number;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  active: boolean;
}

export function grantView(g: AccessGrant): GrantView {
  return {
    id: g.id,
    githubLogin: g.githubLogin,
    githubUserId: g.githubUserId === null ? null : g.githubUserId.toString(),
    avatarUrl: g.avatarUrl,
    status: g.status,
    note: g.note,
    requestedAt: g.requestedAt?.toISOString() ?? null,
    decidedAt: g.decidedAt?.toISOString() ?? null,
    decidedBy: g.decidedBy,
  };
}

export function inviteIsActive(i: AccessInvite, now = Date.now()): boolean {
  return !i.revokedAt && i.expiresAt.getTime() > now && (i.multiUse || i.uses === 0);
}

export function inviteView(i: AccessInvite): InviteView {
  return {
    id: i.id,
    multiUse: i.multiUse,
    expiresAt: i.expiresAt.toISOString(),
    uses: i.uses,
    revokedAt: i.revokedAt?.toISOString() ?? null,
    createdBy: i.createdBy,
    createdAt: i.createdAt.toISOString(),
    lastUsedAt: i.lastUsedAt?.toISOString() ?? null,
    active: inviteIsActive(i),
  };
}

/**
 * Uses one invite: the `uses` increment is conditional (not revoked, not expired, single-use
 * still unused), so a single-use invite cannot be spent twice, even concurrently.
 */
export async function useInvite(prisma: PrismaClient, inviteId: string): Promise<boolean> {
  const now = new Date();
  const res = await prisma.accessInvite.updateMany({
    where: {
      id: inviteId,
      revokedAt: null,
      expiresAt: { gt: now },
      OR: [{ multiUse: true }, { uses: 0 }],
    },
    data: { uses: { increment: 1 }, lastUsedAt: now },
  });
  return res.count === 1;
}
