/**
 * M5 personal access tokens (`orch_pat_<...>`) for the MCP endpoint. Contract in shared api/m5.
 * Only the SHA-256 of a token is stored; the plain value is returned once, on creation.
 */
import type { FastifyInstance } from 'fastify';
import type { PersonalToken, User } from '@prisma/client';
import {
  CreatePersonalTokenRequestSchema,
  PAT_PREFIX,
  mcpAddCommand,
  type CreatePersonalTokenResponse,
  type PersonalTokenScope,
  type PersonalTokenView,
} from '@orch/shared';
import { audit } from '../audit';
import { requireUser, type AuthDeps } from '../auth';
import { randomToken, sha256Hex } from '../auth/crypto';
import type { PrismaClient } from '../db';
import { HttpError, parseBody } from '../http/errors';

const PREFIX_LEN = PAT_PREFIX.length + 4;
/** lastUsedAt is written at most this often per token. */
const LAST_USED_RESOLUTION_MS = 60_000;

export function toTokenView(t: PersonalToken): PersonalTokenView {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes.filter((s): s is PersonalTokenScope => s === 'mcp'),
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Resolves `Authorization: Bearer orch_pat_...` to its user, or null (missing, malformed,
 * unknown, revoked, expired or without the scope). Records lastUsedAt.
 */
export async function authenticatePat(
  prisma: PrismaClient,
  header: string | undefined,
  scope: PersonalTokenScope = 'mcp',
  now = new Date(),
): Promise<{ user: User; token: PersonalToken } | null> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const raw = m?.[1];
  if (!raw || !raw.startsWith(PAT_PREFIX) || raw.length > 200) return null;
  const token = await prisma.personalToken.findUnique({
    where: { tokenHash: sha256Hex(raw) },
    include: { user: true },
  });
  if (
    !token ||
    token.revokedAt ||
    (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) ||
    !token.scopes.includes(scope)
  ) {
    return null;
  }
  if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
    await prisma.personalToken.update({ where: { id: token.id }, data: { lastUsedAt: now } });
  }
  const { user, ...rest } = token;
  return { user, token: rest };
}

export function registerTokens(app: FastifyInstance, deps: AuthDeps): void {
  const { prisma, config } = deps;

  app.post('/api/tokens', async (req, reply): Promise<CreatePersonalTokenResponse> => {
    const user = requireUser(req);
    const body = parseBody(CreatePersonalTokenRequestSchema, req.body);
    const token = `${PAT_PREFIX}${randomToken()}`;
    const row = await prisma.personalToken.create({
      data: {
        userId: user.id,
        name: body.name,
        tokenHash: sha256Hex(token),
        prefix: token.slice(0, PREFIX_LEN),
        scopes: ['mcp'],
        expiresAt: body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 24 * 3600_000)
          : null,
      },
    });
    await audit(prisma, {
      actorUserId: user.id,
      action: 'token.created',
      ip: req.ip,
      data: {
        tokenId: row.id,
        name: row.name,
        prefix: row.prefix,
        scopes: row.scopes,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      },
    });
    return reply.status(201).send({
      ...toTokenView(row),
      token,
      mcpAddCommand: mcpAddCommand(new URL(config.ORCH_BASE_URL).origin, token),
    });
  });

  app.get('/api/tokens', async (req): Promise<PersonalTokenView[]> => {
    const user = requireUser(req);
    const rows = await prisma.personalToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toTokenView);
  });

  app.delete('/api/tokens/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const row = await prisma.personalToken.findUnique({ where: { id } });
    if (!row || row.userId !== user.id) throw new HttpError(404, 'not_found', 'No such token');
    if (!row.revokedAt) {
      const res = await prisma.personalToken.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (res.count === 1) {
        await audit(prisma, {
          actorUserId: user.id,
          action: 'token.revoked',
          ip: req.ip,
          data: { tokenId: row.id, name: row.name, prefix: row.prefix },
        });
      }
    }
    return reply.status(204).send();
  });
}
