import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Agent } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CloseCode,
  ENROLLMENT_TOKEN_TTL_SEC,
  AgentUpdateRequestSchema,
  EnrollRequestSchema,
  isOutdated,
  normalizeVersion,
  parseAgentCredential,
  type AgentView,
  type CreateEnrollmentTokenResponse,
  type EnrollResponse,
  type OutdatedCountResponse,
  type UpdateStatus,
} from '@orch/shared';
import { audit } from '../audit';
import { requireUser, type AuthDeps } from '../auth';
import { randomToken, sha256Hex } from '../auth/crypto';
import { HttpError, parseBody } from '../http/errors';
import type { Dispatcher } from '../dispatch/dispatcher';
import { toUsageSummary } from '../usage';
import { AgentGateway } from './gateway';

export { AgentGateway, OfferRefusedError, type OfferRefusal } from './gateway';

declare module 'fastify' {
  interface FastifyInstance {
    agentGateway: AgentGateway;
  }
}

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));

/** Constant-time comparison of two hex digests. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Creates the gateway, exposes it as `app.agentGateway` and stops it on close. */
export function createAgentGateway(app: FastifyInstance, deps: AuthDeps): AgentGateway {
  const gateway = new AgentGateway({
    prisma: deps.prisma,
    config: deps.config,
    log: app.log,
    github: deps.github,
    metrics: deps.metrics,
    // `app.allowlist` is registered later (registerAuth): resolved at call time.
    // `reauth` (GitHub token gone past the outage grace period) is a denial too.
    isAllowed: async (user) => (await app.allowlist.check(user)) === 'allowed',
  });
  app.decorate('agentGateway', gateway);
  gateway.start();
  app.addHook('onClose', async () => gateway.stop());
  return gateway;
}

/** Registers the agent routes. Must run inside a plugin registered after @fastify/websocket. */
export function registerAgents(
  app: FastifyInstance,
  deps: AuthDeps & { dispatcher?: Dispatcher },
  gateway: AgentGateway,
): void {
  const { prisma, config } = deps;
  const baseUrl = config.ORCH_BASE_URL.replace(/\/+$/, '');

  const latestAgentVersion = normalizeVersion(config.ORCH_VERSION);

  async function toView(a: Agent): Promise<AgentView> {
    const last = await prisma.usageReport.findFirst({
      where: { agentId: a.id },
      orderBy: { reportedAt: 'desc' },
    });
    return {
      id: a.id,
      machineName: a.name,
      version: a.agentVersion,
      connected: !a.revokedAt && gateway.isConnected(a.id),
      lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
      lastUsage: last ? toUsageSummary(last) : null,
      paused: a.paused,
      revokedAt: a.revokedAt?.toISOString() ?? null,
      claudeTokenPresent: a.claudeTokenPresent,
      claudeAuthValid: a.claudeAuthValid,
      claudeAuthCheckedAt: a.claudeAuthCheckedAt?.toISOString() ?? null,
      claudeAuthError: a.claudeAuthError,
      latestAgentVersion,
      updateAvailable: !a.revokedAt && isOutdated(a.agentVersion, latestAgentVersion),
      canSelfUpdate: !a.revokedAt && gateway.canSelfUpdate(a.id),
      update: a.updateStatus
        ? {
            status: a.updateStatus as UpdateStatus,
            targetVersion: a.updateTargetVersion ?? '',
            code: a.updateCode,
            detail: a.updateDetail,
            requestedAt: a.updateRequestedAt?.toISOString() ?? null,
            updatedAt: a.updateUpdatedAt?.toISOString() ?? null,
          }
        : null,
    };
  }

  /** The caller's agent. 404 for unknown, foreign or (with `live`) revoked agents. */
  async function ownAgent(req: FastifyRequest, live: boolean): Promise<Agent> {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const a = await prisma.agent.findUnique({ where: { id } });
    if (!a || a.userId !== user.id || (live && a.revokedAt)) {
      throw new HttpError(404, 'not_found', 'Agent not found');
    }
    return a;
  }

  // ---------- enrollment ----------

  app.post('/api/agents/enrollment-tokens', async (req, reply) => {
    const user = requireUser(req);
    const token = randomToken();
    const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_SEC * 1000);
    await prisma.enrollmentToken.create({
      data: { userId: user.id, tokenHash: sha256Hex(token), expiresAt, createdIp: req.ip },
    });
    await audit(prisma, { actorUserId: user.id, action: 'agent.enrollment_token.created' });
    const body: CreateEnrollmentTokenResponse = {
      token,
      expiresAt: expiresAt.toISOString(),
      installCommand: `curl -fsSL ${baseUrl}/install.sh | ORCH_TOKEN=${token} sh`,
    };
    return reply.status(201).send(body);
  });

  const enroll = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(EnrollRequestSchema, req.body);
    const machineName = (body.machineName ?? body.machine?.hostname)!;
    const agentVersion = body.agentVersion ?? body.machine?.agentVersion ?? null;
    const now = new Date(); // app clock (not SQL now()) so tests can fake time
    const tokenHash = sha256Hex(body.token);
    const secret = randomToken();
    const agentId = `agt_${randomBytes(16).toString('base64url')}`;

    const agent = await prisma.$transaction(async (tx) => {
      // Spends the token in one statement: concurrent enrollments cannot both win.
      const spent = await tx.enrollmentToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (spent.count !== 1) return null;
      const tok = await tx.enrollmentToken.findUniqueOrThrow({ where: { tokenHash } });
      const created = await tx.agent.create({
        data: {
          id: agentId,
          userId: tok.userId,
          name: machineName,
          hostname: body.machine?.hostname ?? null,
          os: body.machine?.os ?? null,
          arch: body.machine?.arch ?? null,
          agentVersion,
          secretHash: sha256Hex(secret),
          secretPrefix: secret.slice(0, 6),
        },
      });
      await tx.enrollmentToken.update({ where: { id: tok.id }, data: { usedByAgentId: agentId } });
      return created;
    });
    if (!agent) throw new HttpError(401, 'invalid_token', 'Invalid, expired or used token');

    await audit(prisma, {
      actorUserId: agent.userId,
      agentId: agent.id,
      action: 'agent.enrolled',
      ip: req.ip,
      data: { machineName, agentVersion },
    });
    const res: EnrollResponse = {
      agentId: agent.id,
      credential: `orch_agent_${agentId}.${secret}`,
    };
    return reply.status(201).send(res);
  };
  app.post('/api/agents/enroll', enroll);
  app.post('/agent/enroll', enroll);

  // ---------- my agents ----------

  app.get('/api/agents/mine', async (req): Promise<AgentView[]> => {
    const user = requireUser(req);
    const agents = await prisma.agent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(agents.map(toView));
  });

  app.get('/api/agents/outdated-count', async (req): Promise<OutdatedCountResponse> => {
    const user = requireUser(req);
    const agents = await prisma.agent.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { agentVersion: true },
    });
    return { count: agents.filter((a) => isOutdated(a.agentVersion, latestAgentVersion)).length };
  });

  app.post('/api/agents/:id/update', async (req, reply) => {
    const a = await ownAgent(req, true);
    const body = parseBody(AgentUpdateRequestSchema, req.body ?? {});
    const target = latestAgentVersion;
    if (!target) {
      throw new HttpError(409, 'server_version_unknown', 'This server runs a dev build');
    }
    if (!isOutdated(a.agentVersion, target)) {
      throw new HttpError(409, 'up_to_date', 'The agent is already up to date');
    }
    if (!gateway.isConnected(a.id)) throw new HttpError(409, 'agent_offline', 'Agent is offline');
    if (!gateway.canSelfUpdate(a.id)) {
      throw new HttpError(409, 'update_unsupported', 'This agent cannot update itself remotely');
    }
    const updateId = `upd_${randomBytes(12).toString('base64url')}`;
    // The image is decided here and only here: never taken from the request.
    const image = `${config.ORCH_AGENT_IMAGE_REPO}:${target}`;
    const whenIdle = body.whenIdle ?? false;
    const now = new Date();
    await prisma.agent.update({
      where: { id: a.id },
      data: {
        updateId,
        updateStatus: 'pending',
        updateTargetVersion: target,
        updateCode: null,
        updateDetail: null,
        updateRequestedAt: now,
        updateUpdatedAt: now,
      },
    });
    await audit(prisma, {
      actorUserId: a.userId,
      agentId: a.id,
      action: 'agent.update_requested',
      ip: req.ip,
      data: { fromVersion: a.agentVersion, targetVersion: target, image, whenIdle },
    });
    const sent = gateway.sendUpdate(a.id, { updateId, targetVersion: target, image, whenIdle });
    if (!sent) {
      await prisma.agent.update({
        where: { id: a.id },
        data: { updateStatus: 'failed', updateCode: 'agent_offline', updateUpdatedAt: new Date() },
      });
      throw new HttpError(409, 'agent_offline', 'Agent is offline');
    }
    const fresh = await prisma.agent.findUniqueOrThrow({ where: { id: a.id } });
    return reply.status(202).send(await toView(fresh));
  });

  for (const action of ['pause', 'resume'] as const) {
    /** Revoked agents answer 404 (they cannot be paused or resumed any more). */
    app.post(`/api/agents/:id/${action}`, async (req): Promise<AgentView> => {
      const a = await ownAgent(req, true);
      const paused = action === 'pause';
      const updated = await prisma.agent.update({
        where: { id: a.id },
        data: { paused, pausedAt: paused ? new Date() : null, pauseSource: 'web' },
      });
      await audit(prisma, {
        actorUserId: a.userId,
        agentId: a.id,
        action: paused ? 'agent.paused' : 'agent.resumed',
        ip: req.ip,
        data: { source: 'web' },
      });
      await gateway.pushConfig(a.id);
      await deps.dispatcher?.onAgentPauseChanged(a.id, paused);
      return toView(updated);
    });
  }

  app.delete('/api/agents/:id', async (req, reply) => {
    const a = await ownAgent(req, false);
    if (!a.revokedAt) {
      await prisma.agent.update({ where: { id: a.id }, data: { revokedAt: new Date() } });
      await audit(prisma, {
        actorUserId: a.userId,
        agentId: a.id,
        action: 'agent.revoked',
        ip: req.ip,
      });
    }
    gateway.disconnect(a.id, CloseCode.REVOKED, 'revoked');
    await deps.dispatcher?.onAgentRevoked(a.id);
    return reply.status(204).send();
  });

  // ---------- files for member machines ----------

  app.get('/install.sh', async (_req, reply) => {
    const path = config.ORCH_INSTALL_SH_PATH ?? repoFile('install.sh');
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text === null) throw new HttpError(404, 'not_found', 'install.sh not found');
    // Only the assignment line is substituted: install.sh compares against the placeholder.
    const out = text.replace(
      /^SERVED_FROM_URL="__ORCH_SERVER_URL__"$/m,
      `SERVED_FROM_URL="${baseUrl}"`,
    );
    return reply.type('text/x-shellscript; charset=utf-8').send(out);
  });

  app.get('/agent/compose.yaml', async (_req, reply) => {
    const path = config.ORCH_AGENT_COMPOSE_PATH ?? repoFile('deploy/agent/compose.yaml');
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text === null) throw new HttpError(404, 'not_found', 'compose.yaml not found');
    return reply.type('text/yaml; charset=utf-8').send(text);
  });

  // ---------- WebSocket gateway ----------

  const authed = new WeakMap<FastifyRequest, Agent>();
  app.get(
    '/agent/ws',
    {
      websocket: true,
      // Runs before the upgrade: a rejected credential gets a plain HTTP 401, no socket.
      preValidation: async (req) => {
        const header = req.headers.authorization ?? '';
        const cred = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        const parsed = parseAgentCredential(cred);
        const agent = parsed
          ? await prisma.agent.findUnique({ where: { id: parsed.agentId } })
          : null;
        if (
          !parsed ||
          !agent ||
          agent.revokedAt ||
          !sameHash(sha256Hex(parsed.secret), agent.secretHash)
        ) {
          throw new HttpError(401, 'unauthorized', 'Invalid agent credential');
        }
        // A user who left the allowlist is denied with a 403, not the 401 of a bad credential:
        // the agent keeps retrying with a long backoff and is back once the user is re-approved.
        const owner = await prisma.user.findUnique({ where: { id: agent.userId } });
        if (!owner || !(await gateway.ownerAllowed(owner))) {
          throw new HttpError(403, 'access_suspended', 'Access to this server was removed');
        }
        authed.set(req, agent);
      },
    },
    (socket, req) => {
      const agent = authed.get(req);
      if (!agent) return socket.close(CloseCode.UNAUTHORIZED, 'unauthorized');
      gateway.attach(socket, agent);
    },
  );
}
