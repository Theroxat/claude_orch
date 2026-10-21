import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccessGrantStatus, User } from '@prisma/client';
import { z } from 'zod';
import { audit } from '../audit';
import { requireUser, type AuthDeps } from '../auth';
import { cookie } from '../auth/cookies';
import { randomToken, sha256Hex, signToken, verifyToken } from '../auth/crypto';
import { HttpError, parseBody } from '../http/errors';
import {
  ACCESS_REQUEST_PURPOSE,
  GITHUB_LOGIN_RE,
  INVITE_COOKIE,
  INVITE_COOKIE_PURPOSE,
  INVITE_COOKIE_TTL_SEC,
  RateLimiter,
  grantView,
  inviteIsActive,
  inviteView,
} from './core';
import {
  NOTE_MAX,
  alreadyApprovedPage,
  declinedPage,
  invalidInvitePage,
  requestExpiredPage,
  requestSentPage,
  tooManyRequestsPage,
} from './pages';

const PreapproveSchema = z.object({ githubLogin: z.string().trim().regex(GITHUB_LOGIN_RE) });
const InviteSchema = z.object({
  multiUse: z.boolean(),
  expiresInHours: z.number().int().min(1).max(720),
});

/**
 * Access management: the request-access form (no session), invite links and the admin API
 * behind the Access page (/admin/access). Admins come from ORCH_ADMIN_GITHUB_LOGINS.
 */
export function registerAccess(app: FastifyInstance, deps: AuthDeps): void {
  const { config, prisma } = deps;
  const base = new URL(config.ORCH_BASE_URL);
  const secure = base.protocol === 'https:';
  const limits = { ip: new RateLimiter(10, 15 * 60_000), login: new RateLimiter(5, 15 * 60_000) };

  const html = (reply: FastifyReply, status: number, body: string) =>
    reply.status(status).type('text/html; charset=utf-8').send(body);

  function requireAdmin(req: FastifyRequest): User {
    const user = requireUser(req);
    if (!app.allowlist.isAdmin(user.login)) {
      throw new HttpError(403, 'forbidden', 'Admins only');
    }
    return user;
  }

  // ---------- request access (signed token from the OAuth callback, no session) ----------

  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16 * 1024 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    // Cross-origin POSTs are rejected by the Origin check of registerAuth.
    scope.post('/api/auth/access-request', async (req, reply) => {
      const key = config.ORCH_ENCRYPTION_KEY;
      if (!key) throw new HttpError(503, 'github_not_configured', 'GitHub App is not configured');
      if (!limits.ip.allow(req.ip)) return html(reply, 429, tooManyRequestsPage());
      const b = (req.body ?? {}) as Record<string, unknown>;
      const p = verifyToken(key, ACCESS_REQUEST_PURPOSE, b.token);
      const login = typeof p?.login === 'string' ? p.login : null;
      if (!p || !login || !GITHUB_LOGIN_RE.test(login)) {
        return html(reply, 400, requestExpiredPage());
      }
      const githubLogin = login.toLowerCase();
      if (!limits.login.allow(githubLogin)) return html(reply, 429, tooManyRequestsPage());
      const githubUserId =
        typeof p.id === 'string' && /^\d{1,20}$/.test(p.id) ? BigInt(p.id) : null;
      const avatarUrl = typeof p.avatarUrl === 'string' ? p.avatarUrl.slice(0, 1000) : null;
      const rawNote = typeof b.note === 'string' ? b.note.trim().slice(0, NOTE_MAX) : '';
      const note = rawNote || null;

      const existing = await prisma.accessGrant.findUnique({ where: { githubLogin } });
      if (existing?.status === 'DENIED') return html(reply, 403, declinedPage(login, avatarUrl));
      if (existing?.status === 'APPROVED') return html(reply, 200, alreadyApprovedPage(login));
      let grantId: string;
      if (existing) {
        const g = await prisma.accessGrant.update({
          where: { id: existing.id },
          data: { note, githubUserId, avatarUrl },
        });
        grantId = g.id;
      } else {
        try {
          const g = await prisma.accessGrant.create({
            data: {
              githubLogin,
              githubUserId,
              avatarUrl,
              note,
              status: 'PENDING',
              requestedAt: new Date(),
            },
          });
          grantId = g.id;
        } catch {
          // Concurrent request for the same login: the other one created it.
          const g = await prisma.accessGrant.findUnique({ where: { githubLogin } });
          if (!g) throw new HttpError(500, 'internal', 'Could not record the request');
          grantId = g.id;
        }
      }
      await audit(prisma, {
        actorType: 'SYSTEM',
        action: existing ? 'access.request_updated' : 'access.requested',
        data: { login: githubLogin, grantId },
        ip: req.ip,
      });
      return html(reply, 200, requestSentPage(login, avatarUrl));
    });
  });

  // ---------- invite links ----------

  app.get('/invite/:token', async (req, reply) => {
    const key = config.ORCH_ENCRYPTION_KEY;
    const { token } = req.params as { token: string };
    const invite =
      key && token.length <= 200
        ? await prisma.accessInvite.findUnique({ where: { tokenHash: sha256Hex(token) } })
        : null;
    if (!key || !invite || !inviteIsActive(invite)) return html(reply, 404, invalidInvitePage());
    const value = signToken(
      key,
      INVITE_COOKIE_PURPOSE,
      { id: invite.id },
      INVITE_COOKIE_TTL_SEC * 1000,
    );
    reply.header('Set-Cookie', cookie(INVITE_COOKIE, value, secure, INVITE_COOKIE_TTL_SEC));
    return reply.redirect('/api/auth/github/login', 302);
  });

  // ---------- admin API ----------

  app.get('/api/admin/access', async (req) => {
    requireAdmin(req);
    const [grants, invites] = await Promise.all([
      prisma.accessGrant.findMany({ orderBy: [{ updatedAt: 'desc' }] }),
      prisma.accessInvite.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
    ]);
    const by = (s: AccessGrantStatus) => grants.filter((g) => g.status === s).map(grantView);
    return {
      pending: by('PENDING'),
      approved: by('APPROVED'),
      denied: by('DENIED'),
      invites: invites.map(inviteView),
      configured: {
        logins: config.ORCH_ALLOWED_GITHUB_LOGINS,
        orgs: config.ORCH_ALLOWED_GITHUB_ORGS,
        admins: config.ORCH_ADMIN_GITHUB_LOGINS,
        allowAny: config.ORCH_ALLOW_ANY_GITHUB_USER,
      },
    };
  });

  app.get('/api/admin/access/pending-count', async (req) => {
    requireAdmin(req);
    return { count: await prisma.accessGrant.count({ where: { status: 'PENDING' } }) };
  });

  app.post('/api/admin/access/grants', async (req) => {
    const admin = requireAdmin(req);
    const githubLogin = parseBody(PreapproveSchema, req.body).githubLogin.toLowerCase();
    const decided = { status: 'APPROVED' as const, decidedAt: new Date(), decidedBy: admin.login };
    const grant = await prisma.accessGrant.upsert({
      where: { githubLogin },
      create: { githubLogin, ...decided },
      update: decided,
    });
    app.allowlist.invalidate(githubLogin);
    await audit(prisma, {
      actorUserId: admin.id,
      action: 'access.preapproved',
      data: { login: githubLogin, grantId: grant.id },
      ip: req.ip,
    });
    return { grant: grantView(grant) };
  });

  const decide = (path: string, status: 'APPROVED' | 'DENIED', action: string) =>
    app.post(path, async (req) => {
      const admin = requireAdmin(req);
      const { id } = req.params as { id: string };
      const found = await prisma.accessGrant.findUnique({ where: { id } });
      if (!found) throw new HttpError(404, 'not_found', 'Access grant not found');
      // Never deleted: removing access sets DENIED, so sessions and tokens are refused, not lost.
      const grant = await prisma.accessGrant.update({
        where: { id },
        data: { status, decidedAt: new Date(), decidedBy: admin.login },
      });
      app.allowlist.invalidate(grant.githubLogin);
      if (status === 'DENIED') {
        // Connected agents of that user are suspended now, not at their next frame.
        const users = await prisma.user.findMany({
          where: { login: { equals: grant.githubLogin, mode: 'insensitive' } },
          select: { id: true },
        });
        for (const u of users) await app.agentGateway.recheckUser(u.id);
      }
      await audit(prisma, {
        actorUserId: admin.id,
        action,
        data: { login: grant.githubLogin, grantId: grant.id, from: found.status },
        ip: req.ip,
      });
      return { grant: grantView(grant) };
    });
  decide('/api/admin/access/grants/:id/approve', 'APPROVED', 'access.approved');
  decide('/api/admin/access/grants/:id/deny', 'DENIED', 'access.denied');
  decide('/api/admin/access/grants/:id/remove', 'DENIED', 'access.removed');

  app.post('/api/admin/access/invites', async (req) => {
    const admin = requireAdmin(req);
    const b = parseBody(InviteSchema, req.body);
    const token = randomToken();
    const invite = await prisma.accessInvite.create({
      data: {
        tokenHash: sha256Hex(token),
        multiUse: b.multiUse,
        expiresAt: new Date(Date.now() + b.expiresInHours * 3600_000),
        createdBy: admin.login,
      },
    });
    await audit(prisma, {
      actorUserId: admin.id,
      action: 'access.invite_created',
      data: { inviteId: invite.id, multiUse: b.multiUse, expiresInHours: b.expiresInHours },
      ip: req.ip,
    });
    // The raw token is returned once; only its SHA-256 is stored.
    return { invite: inviteView(invite), url: `${base.origin}/invite/${token}` };
  });

  app.post('/api/admin/access/invites/:id/revoke', async (req) => {
    const admin = requireAdmin(req);
    const { id } = req.params as { id: string };
    const found = await prisma.accessInvite.findUnique({ where: { id } });
    if (!found) throw new HttpError(404, 'not_found', 'Invite not found');
    const invite = found.revokedAt
      ? found
      : await prisma.accessInvite.update({ where: { id }, data: { revokedAt: new Date() } });
    if (!found.revokedAt) {
      await audit(prisma, {
        actorUserId: admin.id,
        action: 'access.invite_revoked',
        data: { inviteId: id },
        ip: req.ip,
      });
    }
    return { invite: inviteView(invite) };
  });
}
