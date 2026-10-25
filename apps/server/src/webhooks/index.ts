/**
 * GitHub App webhook (M4): POST /api/github/webhook.
 *
 * - Signature: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`, compared in
 *   constant time. The secret comes from GITHUB_WEBHOOK_SECRET (never from a file in the repo).
 * - Dedupe: `X-GitHub-Delivery` is stored in WebhookDelivery; a replay is answered 200 without
 *   doing anything. If processing fails the row is removed so GitHub's redelivery is processed.
 *
 * Events:
 *   issues.labeled (project pool label, by a write+ user)  -> import as a task
 *   issues.closed                                          -> CANCELLED if not started
 *   issues.edited (body changed, task not started)         -> new snapshot, back to PROPOSED
 *   pull_request.opened|reopened on `orch/issue-<n>-*`     -> IN_REVIEW
 *   pull_request.closed merged                             -> DONE, dependents unblocked, cleanup
 *   pull_request.closed not merged                         -> back to TODO, cleanup
 *   installation, installation_repositories                -> installations / projects updated
 *   member (collaborator added|removed|edited)             -> that user's cached repo role is stale
 *   repository (privatized|publicized|deleted|transferred) -> visibility updated, all roles stale
 *   organization (member_removed|member_added)             -> the user's roles on the org's repos stale
 *   installation deleted|suspend|unsuspend, repositories removed -> roles of the installation stale
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { serverMessage, type WebhookResponse } from '@orch/shared';
import { audit } from '../audit';
import type { AuthDeps } from '../auth';
import type { Dispatcher } from '../dispatch/dispatcher';
import type { AgentGateway } from '../agents/gateway';
import { HttpError } from '../http/errors';
import { invalidateRepoAccess } from '../projects/service';
import { TaskService } from '../tasks/service';
import { bodyHash, parseIssueBody } from '../tasks/meta';

const WRITE_ROLES = ['ADMIN', 'MAINTAIN', 'WRITE'];
const BRANCH_RE = /^orch\/issue-(\d+)(?:-|$)/;

/** Constant-time check of `sha256=<hex>` against the raw body. */
export function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const got = Buffer.from(header.slice(7), 'hex');
  const want = createHmac('sha256', secret).update(raw).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

export function signBody(secret: string, raw: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

interface Payload {
  action?: string;
  sender?: { id: number; login: string };
  repository?: { id: number; full_name: string; private?: boolean };
  member?: { id: number; login?: string };
  membership?: { user?: { id: number } };
  organization?: { login?: string };
  installation?: { id: number; account?: { login?: string; type?: string } };
  issue?: {
    number: number;
    node_id: string;
    html_url: string;
    title: string;
    body?: string | null;
    labels?: Array<{ name?: string } | string>;
    pull_request?: unknown;
  };
  label?: { name?: string };
  changes?: { body?: unknown; title?: unknown };
  pull_request?: {
    number: number;
    html_url: string;
    merged?: boolean;
    /** `head.repo` is the fork for a PR from a fork, null when the fork was deleted. */
    head: { ref: string; sha: string; repo?: { id: number } | null };
    base: { ref: string };
  };
  repositories_added?: Array<{ id: number; full_name: string }>;
  repositories_removed?: Array<{ id: number; full_name: string }>;
}

export function registerWebhooks(
  app: FastifyInstance,
  deps: AuthDeps & { dispatcher: Dispatcher; gateway: AgentGateway },
): void {
  const { prisma, config, dispatcher, gateway } = deps;
  const tasks = new TaskService(deps);

  app.register(async (scope) => {
    // Raw body for the HMAC: this scope parses JSON itself after the check.
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    // Explicit cap: the webhook is public and only HMAC-checked after the body is read.
    scope.post(
      '/api/github/webhook',
      { bodyLimit: 1024 * 1024 },
      async (req, reply): Promise<WebhookResponse> => {
        const secret = config.GITHUB_WEBHOOK_SECRET;
        if (!secret)
          throw new HttpError(503, 'webhook_not_configured', 'Webhook secret is not set');
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const sig = req.headers['x-hub-signature-256'];
        if (!verifySignature(secret, raw, typeof sig === 'string' ? sig : undefined)) {
          // Delivery id and event only: never the signature, the secret or the body.
          req.log.warn(
            {
              deliveryId: header(req, 'x-github-delivery') ?? null,
              event: header(req, 'x-github-event') ?? null,
            },
            'webhook signature verification failed',
          );
          throw new HttpError(401, 'bad_signature', 'Invalid webhook signature');
        }
        const event = header(req, 'x-github-event');
        const deliveryId = header(req, 'x-github-delivery');
        if (!event || !deliveryId) {
          throw new HttpError(
            400,
            'invalid_request',
            'Missing X-GitHub-Event or X-GitHub-Delivery',
          );
        }
        // Signature verified: GitHub's event name, still restricted to a short safe token.
        const eventLabel = /^[a-z_]{1,40}$/.test(event) ? event : 'other';
        let payload: Payload;
        try {
          payload = JSON.parse(raw.toString('utf8')) as Payload;
        } catch {
          throw new HttpError(400, 'invalid_json', 'Malformed JSON body');
        }
        try {
          await prisma.webhookDelivery.create({
            data: { deliveryId, event, bodyHash: createHash('sha256').update(raw).digest('hex') },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            deps.metrics?.webhookDeliveries.inc({ event: eventLabel, result: 'duplicate' });
            return { ok: true, duplicate: true };
          }
          throw err;
        }
        let result: string;
        try {
          result = await handle(event, payload);
        } catch (err) {
          deps.metrics?.webhookDeliveries.inc({ event: eventLabel, result: 'failed' });
          await prisma.webhookDelivery.deleteMany({ where: { deliveryId } });
          throw err;
        }
        await prisma.webhookDelivery.update({
          where: { deliveryId },
          data: { processedAt: new Date() },
        });
        deps.metrics?.webhookDeliveries.inc({ event: eventLabel, result: 'processed' });
        reply.status(200);
        return { ok: true, result };
      },
    );
  });

  function header(req: FastifyRequest, name: string): string | undefined {
    const v = req.headers[name];
    return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined;
  }

  async function handle(event: string, p: Payload): Promise<string> {
    switch (event) {
      case 'ping':
        return 'pong';
      case 'installation':
        return onInstallation(p);
      case 'installation_repositories':
        return onInstallationRepos(p);
      case 'member':
        return onMember(p);
      case 'repository':
        return onRepository(p);
      case 'organization':
        return onOrganization(p);
      case 'issues':
        return onIssues(p);
      case 'pull_request':
        return onPullRequest(p);
      default:
        return 'ignored';
    }
  }

  async function projectOf(p: Payload) {
    if (!p.repository) return null;
    return prisma.project.findUnique({
      where: { githubRepoId: BigInt(p.repository.id) },
      include: { installation: true },
    });
  }

  // ---------- repository access (cached GitHub roles) ----------

  const userByGithubId = (id: number | undefined) =>
    id === undefined
      ? null
      : prisma.user.findUnique({ where: { githubId: BigInt(id) }, select: { id: true } });

  /** A collaborator was added, removed or had their permission changed. */
  async function onMember(p: Payload): Promise<string> {
    const project = await projectOf(p);
    if (!project) return 'ignored';
    const user = await userByGithubId(p.member?.id);
    if (!user) return 'ignored';
    await invalidateRepoAccess(prisma, { projectId: project.id, userId: user.id });
    return `member.${p.action ?? 'unknown'}`;
  }

  /** Visibility change, deletion or transfer: every cached role of the repository is stale. */
  async function onRepository(p: Payload): Promise<string> {
    const project = await projectOf(p);
    if (!project) return 'ignored';
    if (p.action === 'privatized' || p.action === 'publicized') {
      await prisma.project.update({
        where: { id: project.id },
        data: { isPrivate: p.action === 'privatized' },
      });
    } else if (!['deleted', 'transferred', 'archived', 'renamed'].includes(p.action ?? '')) {
      return 'ignored';
    }
    await invalidateRepoAccess(prisma, { projectId: project.id });
    return `repository.${p.action}`;
  }

  /** Someone left (or joined) the organization: their cached roles on its repositories are stale. */
  async function onOrganization(p: Payload): Promise<string> {
    if (p.action !== 'member_removed' && p.action !== 'member_added') return 'ignored';
    const login = p.organization?.login;
    const user = await userByGithubId(p.membership?.user?.id);
    if (!login || !user) return 'ignored';
    await invalidateRepoAccess(prisma, { userId: user.id, accountLogin: login });
    return `organization.${p.action}`;
  }

  // ---------- installations ----------

  async function onInstallation(p: Payload): Promise<string> {
    const inst = p.installation;
    if (!inst) return 'ignored';
    const id = BigInt(inst.id);
    const now = new Date();
    if (p.action === 'created' || p.action === 'new_permissions_accepted') {
      await prisma.installation.upsert({
        where: { githubInstallationId: id },
        create: {
          githubInstallationId: id,
          accountLogin: inst.account?.login ?? 'unknown',
          accountType: inst.account?.type ?? 'User',
        },
        update: { suspendedAt: null },
      });
      return 'installation.upserted';
    }
    const existing = await prisma.installation.findUnique({ where: { githubInstallationId: id } });
    if (!existing) return 'ignored';
    if (p.action === 'deleted' || p.action === 'suspend' || p.action === 'unsuspend') {
      await invalidateRepoAccess(prisma, { installationId: existing.id });
    }
    if (p.action === 'deleted' || p.action === 'suspend') {
      await prisma.installation.update({ where: { id: existing.id }, data: { suspendedAt: now } });
      if (p.action === 'deleted') {
        await archiveProjects({ installationId: existing.id }, 'installation_deleted');
      }
    } else if (p.action === 'unsuspend') {
      await prisma.installation.update({ where: { id: existing.id }, data: { suspendedAt: null } });
    } else {
      return 'ignored';
    }
    await audit(prisma, {
      actorType: 'GITHUB',
      action: `installation.${p.action}`,
      data: { githubInstallationId: inst.id },
    });
    return `installation.${p.action}`;
  }

  async function onInstallationRepos(p: Payload): Promise<string> {
    const inst = p.installation;
    if (!inst) return 'ignored';
    const existing = await prisma.installation.upsert({
      where: { githubInstallationId: BigInt(inst.id) },
      create: {
        githubInstallationId: BigInt(inst.id),
        accountLogin: inst.account?.login ?? 'unknown',
        accountType: inst.account?.type ?? 'User',
      },
      update: {},
    });
    const removed = (p.repositories_removed ?? []).map((r) => BigInt(r.id));
    if (removed.length) {
      const gone = await prisma.project.findMany({
        where: { installationId: existing.id, githubRepoId: { in: removed } },
        select: { id: true },
      });
      for (const g of gone) await invalidateRepoAccess(prisma, { projectId: g.id });
      await archiveProjects(
        { installationId: existing.id, githubRepoId: { in: removed } },
        'repository_removed',
      );
    }
    return `installation_repositories.${p.action ?? 'unknown'}`;
  }

  async function archiveProjects(where: Prisma.ProjectWhereInput, reason: string) {
    const projects = await prisma.project.findMany({ where: { ...where, archivedAt: null } });
    for (const project of projects) {
      await prisma.project.update({ where: { id: project.id }, data: { archivedAt: new Date() } });
      const open = await prisma.task.findMany({ where: { projectId: project.id, status: 'TODO' } });
      for (const t of open) await dispatcher.withdrawForTask(t.id, reason);
      await audit(prisma, {
        actorType: 'GITHUB',
        action: 'project.archived',
        projectId: project.id,
        data: { reason },
      });
      // The members' agents drop the archived project from their participation list.
      const members = await prisma.participation.findMany({
        where: { projectId: project.id },
        select: { userId: true },
      });
      await gateway.pushConfigToUsers(members.map((m) => m.userId));
    }
  }

  // ---------- issues ----------

  async function onIssues(p: Payload): Promise<string> {
    const issue = p.issue;
    if (!issue || issue.pull_request) return 'ignored';
    const project = await projectOf(p);
    if (!project || project.archivedAt) return 'ignored';
    const task = await prisma.task.findUnique({
      where: {
        projectId_githubIssueNumber: { projectId: project.id, githubIssueNumber: issue.number },
      },
    });

    if (p.action === 'labeled') {
      if (p.label?.name !== project.poolLabel) return 'ignored';
      if (task) return 'already_imported';
      // R3: only issues labeled by a write+ user (or the project owner) become tasks.
      const sender = p.sender;
      if (!sender) return 'ignored';
      const senderUser = await prisma.user.findUnique({ where: { githubId: BigInt(sender.id) } });
      // The stored owner is trusted on a public repository only; a private one is asked to GitHub.
      let allowed = senderUser?.id === project.addedById && (!project.isPrivate || !deps.github);
      if (!allowed && deps.github) {
        const role = await deps.github
          .getUserRole(
            Number(project.installation.githubInstallationId),
            project.fullName,
            sender.login,
          )
          .catch(() => 'NONE');
        allowed = WRITE_ROLES.includes(role);
      }
      if (!allowed) {
        await audit(prisma, {
          actorType: 'GITHUB',
          action: 'task.import_refused',
          projectId: project.id,
          data: { issueNumber: issue.number, sender: sender.login, reason: 'not_writer' },
        });
        return 'refused_not_writer';
      }
      const imported = await tasks.importIssue(
        project,
        {
          number: issue.number,
          nodeId: issue.node_id,
          htmlUrl: issue.html_url,
          title: issue.title,
          body: issue.body ?? '',
          labels: (issue.labels ?? [])
            .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
            .filter(Boolean),
        },
        senderUser?.id ?? project.addedById,
        { actorType: 'GITHUB', actorUserId: senderUser?.id },
      );
      dispatcher.kick();
      return imported ? 'imported' : 'already_imported';
    }

    if (!task) return 'ignored';

    if (p.action === 'closed') {
      const r = await prisma.task.updateMany({
        where: { id: task.id, status: { in: ['PROPOSED', 'TODO'] } },
        data: { status: 'CANCELLED' },
      });
      if (r.count !== 1) return 'not_cancelled_started';
      await dispatcher.withdrawForTask(task.id, 'cancelled');
      await audit(prisma, {
        actorType: 'GITHUB',
        action: 'task.cancelled',
        projectId: project.id,
        taskId: task.id,
        data: { issueNumber: issue.number, reason: 'issue_closed' },
      });
      return 'cancelled';
    }

    if (p.action === 'reopened' && task.status === 'CANCELLED') {
      await prisma.task.update({ where: { id: task.id }, data: { status: 'PROPOSED' } });
      await audit(prisma, {
        actorType: 'GITHUB',
        action: 'task.reopened',
        projectId: project.id,
        taskId: task.id,
      });
      return 'reopened_proposed';
    }

    if (p.action === 'edited' && p.changes?.body !== undefined) {
      // R3: the prompt is a snapshot; a changed body needs a new approval before anyone runs it.
      const { description } = parseIssueBody(issue.body);
      const hash = bodyHash(description);
      if (hash === task.bodyHash) return 'unchanged';
      const r = await prisma.task.updateMany({
        where: { id: task.id, status: { in: ['PROPOSED', 'TODO'] } },
        data: { bodySnapshot: description, bodyHash: hash, status: 'PROPOSED' },
      });
      if (r.count !== 1) return 'edited_after_start';
      await dispatcher.withdrawForTask(task.id, 'edited');
      await audit(prisma, {
        actorType: 'GITHUB',
        action: 'task.edited',
        projectId: project.id,
        taskId: task.id,
        data: { issueNumber: issue.number, needsApproval: true },
      });
      return 'reapproval_required';
    }
    return 'ignored';
  }

  // ---------- pull requests ----------

  async function onPullRequest(p: Payload): Promise<string> {
    const pr = p.pull_request;
    if (!pr) return 'ignored';
    const project = await projectOf(p);
    if (!project) return 'ignored';
    let task = await prisma.task.findFirst({
      where: { projectId: project.id, prNumber: pr.number },
    });
    // A branch name alone links a PR to a task only when the branch is in the project's own
    // repository: anyone can open a PR from a fork whose branch is named like a task branch.
    const sameRepo = !!p.repository && pr.head.repo?.id === p.repository.id;
    if (!task && sameRepo) {
      const m = BRANCH_RE.exec(pr.head.ref);
      if (m) {
        const candidate = await prisma.task.findUnique({
          where: {
            projectId_githubIssueNumber: { projectId: project.id, githubIssueNumber: Number(m[1]) },
          },
        });
        // Only the task's own branch links a PR to it.
        if (candidate && (!candidate.branchName || candidate.branchName === pr.head.ref)) {
          task = candidate;
        }
      }
    }
    if (!task) return 'ignored';

    if (p.action === 'opened' || p.action === 'reopened' || p.action === 'ready_for_review') {
      const r = await prisma.task.updateMany({
        where: { id: task.id, status: { in: ['IN_PROGRESS', 'IN_REVIEW', 'TODO'] } },
        data: {
          status: 'IN_REVIEW',
          prNumber: pr.number,
          prUrl: pr.html_url,
          headSha: pr.head.sha,
        },
      });
      if (r.count !== 1) return 'ignored';
      if (task.status === 'TODO') await dispatcher.withdrawForTask(task.id, 'pr_opened');
      await audit(prisma, {
        actorType: 'GITHUB',
        action: 'task.in_review',
        projectId: project.id,
        taskId: task.id,
        // Already IN_REVIEW: orch opened this PR itself (task.pr_opened) or it is a reopen/ready.
        data: { prNumber: pr.number, alreadyInReview: task.status === 'IN_REVIEW' },
      });
      return 'in_review';
    }

    if (p.action !== 'closed') return 'ignored';
    const live = await prisma.assignment.findFirst({
      where: {
        taskId: task.id,
        agentId: { not: null },
        status: { in: ['ACCEPTED', 'RUNNING', 'PUSHED', 'SUCCEEDED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (pr.merged) {
      const r = await prisma.task.updateMany({
        where: { id: task.id, status: { in: ['IN_REVIEW', 'IN_PROGRESS', 'TODO'] } },
        data: { status: 'DONE', prNumber: pr.number, prUrl: pr.html_url, headSha: pr.head.sha },
      });
      if (r.count !== 1) return 'ignored';
      if (live) {
        await prisma.assignment.update({
          where: { id: live.id },
          data: {
            cleanupPending: true,
            ...(live.status === 'PUSHED' ? { status: 'SUCCEEDED', finishedAt: new Date() } : {}),
          },
        });
        if (live.agentId) gateway.sendCleanup(live.agentId, live.id);
      }
      await dispatcher.withdrawForTask(task.id, 'done');
      await audit(prisma, {
        actorType: 'GITHUB',
        action: 'task.merged',
        projectId: project.id,
        taskId: task.id,
        data: { prNumber: pr.number },
      });
      dispatcher.kick(); // dependents may be unblocked
      return 'done';
    }
    // Closed without merge: the work is dropped, the task goes back to the pool.
    const r = await prisma.task.updateMany({
      where: { id: task.id, status: 'IN_REVIEW', prNumber: pr.number },
      data: {
        status: 'TODO',
        prNumber: null,
        prUrl: null,
        headSha: null,
        assigneeId: null,
        assigneeAgentId: null,
      },
    });
    if (r.count !== 1) return 'ignored';
    if (live) {
      await prisma.assignment.update({
        where: { id: live.id },
        data: {
          cleanupPending: true,
          ...(live.status !== 'SUCCEEDED'
            ? { status: 'CANCELLED', reason: 'pr_closed', finishedAt: new Date() }
            : {}),
        },
      });
      if (live.agentId) {
        if (live.status !== 'PUSHED' && live.status !== 'SUCCEEDED') {
          gateway.sendTo(
            live.agentId,
            serverMessage('task.cancel', { assignmentId: live.id, reason: 'pr_closed' }),
          );
        }
        gateway.sendCleanup(live.agentId, live.id);
      }
    }
    await audit(prisma, {
      actorType: 'GITHUB',
      action: 'task.pr_closed',
      projectId: project.id,
      taskId: task.id,
      data: { prNumber: pr.number, returnedToPool: true },
    });
    dispatcher.kick();
    return 'returned_to_pool';
  }
}
