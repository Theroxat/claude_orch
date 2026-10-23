import type { NotificationEvent } from '@orch/shared';
import type { AuditEntry } from '../audit';
import type { Config } from '../config';
import type { PrismaClient } from '../db';

/** What one audit event means for the people it concerns. */
export interface NotificationDraft {
  event: NotificationEvent;
  title: string;
  body: string;
  /** App path (`/backlog?task=...`) or absolute URL (a PR). */
  url: string | null;
  projectId: string | null;
  taskId: string | null;
}

export interface PlannedNotification {
  draft: NotificationDraft;
  userIds: string[];
}

type Data = Record<string, unknown>;

const FAILED_OUTCOMES = new Set(['failed', 'no_changes']);
const MAX_BODY = 500;

const clip = (s: string, n = MAX_BODY) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Unique, non-null recipients, minus the person who did it themselves (when a user acted). */
function recipients(e: AuditEntry, ...ids: Array<string | null | undefined>): string[] {
  const actor = (e.actorType ?? 'USER') === 'USER' ? e.actorUserId : undefined;
  return [...new Set(ids.filter((x): x is string => !!x && x !== actor))];
}

async function loadTask(prisma: PrismaClient, id: string | undefined) {
  if (!id) return null;
  return prisma.task.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      githubIssueNumber: true,
      createdById: true,
      assigneeId: true,
      prNumber: true,
      prUrl: true,
      needsAttentionReason: true,
      project: { select: { id: true, fullName: true, addedById: true } },
    },
  });
}

type TaskInfo = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

const taskRef = (t: TaskInfo) => `${t.project.fullName}#${t.githubIssueNumber}`;
const taskPath = (t: TaskInfo) => `/backlog?task=${encodeURIComponent(t.id)}`;

function taskDraft(
  event: NotificationEvent,
  t: TaskInfo,
  title: string,
  body: string,
  url: string | null = null,
): NotificationDraft {
  return {
    event,
    title: clip(title, 200),
    body: clip(body),
    url: url ?? taskPath(t),
    projectId: t.project.id,
    taskId: t.id,
  };
}

/**
 * Turns an audit event into notifications: which event, for whom, with which text. Returns an
 * empty list for the (many) audit actions nobody is notified about.
 */
export async function planNotifications(
  prisma: PrismaClient,
  config: Pick<Config, 'ORCH_ADMIN_GITHUB_LOGINS'>,
  e: AuditEntry,
): Promise<PlannedNotification[]> {
  const data = (e.data ?? {}) as Data;
  switch (e.action) {
    case 'task.merged': {
      const t = await loadTask(prisma, e.taskId);
      if (!t) return [];
      const pr = t.prNumber ? `PR #${t.prNumber}` : 'The PR';
      return [
        {
          draft: taskDraft(
            'task_done',
            t,
            `Done: ${t.title}`,
            `${taskRef(t)}: ${pr} was merged.`,
            t.prUrl,
          ),
          userIds: recipients(e, t.createdById, t.assigneeId),
        },
      ];
    }
    case 'task.finished': {
      if (!FAILED_OUTCOMES.has(String(data.outcome))) return [];
      const t = await loadTask(prisma, e.taskId);
      if (!t) return [];
      const why =
        data.outcome === 'no_changes'
          ? 'The run produced no changes.'
          : (str(data.error) ?? 'The run failed.');
      const back = data.returnedToPool ? ' The task went back to the pool.' : '';
      return [
        {
          draft: taskDraft(
            'task_failed',
            t,
            `Run failed: ${t.title}`,
            `${taskRef(t)}: ${why}${back}`,
          ),
          // The runner is the agent's owner; they learn it too, their machine ran it.
          userIds: recipients(e, t.createdById, e.actorUserId),
        },
      ];
    }
    case 'task.lost': {
      const t = await loadTask(prisma, e.taskId);
      if (!t) return [];
      return [
        {
          draft: taskDraft(
            'task_failed',
            t,
            `Run lost: ${t.title}`,
            `${taskRef(t)}: the agent stopped reporting (${str(data.reason) ?? 'lost'}). The task went back to the pool.`,
          ),
          userIds: recipients(e, t.createdById, e.targetUserId),
        },
      ];
    }
    case 'task.needs_attention': {
      const t = await loadTask(prisma, e.taskId);
      if (!t) return [];
      const reason = str(data.reason) ?? t.needsAttentionReason ?? 'repeated setup failures';
      return [
        {
          draft: taskDraft(
            'task_needs_attention',
            t,
            `Needs attention: ${t.title}`,
            `${taskRef(t)} is no longer dispatched: ${reason}. Fix the repository setup, then retry the task.`,
          ),
          userIds: recipients(e, t.createdById, t.project.addedById),
        },
      ];
    }
    case 'agent.claude_auth_invalid': {
      if (!e.targetUserId) return [];
      const agent = e.agentId
        ? await prisma.agent.findUnique({ where: { id: e.agentId }, select: { name: true } })
        : null;
      const on = agent ? ` on ${agent.name}` : '';
      return [
        {
          draft: {
            event: 'task_needs_attention',
            title: 'Your Claude login needs attention',
            body: `Claude rejected the login of your agent${on}. Run \`orch login\` on that machine; no task starts there until then.`,
            url: '/my-server',
            projectId: null,
            taskId: e.taskId ?? null,
          },
          userIds: [e.targetUserId],
        },
      ];
    }
    case 'task.pr_opened':
    case 'task.in_review': {
      // The webhook also reports the PR orch itself opened: notify once, from the agent's report.
      if (e.action === 'task.in_review' && data.alreadyInReview === true) return [];
      const t = await loadTask(prisma, e.taskId);
      if (!t) return [];
      const pr = t.prNumber ? `PR #${t.prNumber}` : 'A PR';
      const draft = data.draft === true ? ' (draft)' : '';
      return [
        {
          draft: taskDraft(
            'pr_review',
            t,
            `Ready for review: ${t.title}`,
            `${taskRef(t)}: ${pr}${draft} is open and waits for review.`,
            t.prUrl,
          ),
          userIds: recipients(e, t.project.addedById, t.createdById),
        },
      ];
    }
    case 'offer.requested': {
      const t = await loadTask(prisma, e.taskId);
      if (!t || !e.targetUserId) return [];
      return [
        {
          draft: taskDraft(
            'consent_request',
            t,
            `Task offered to you: ${t.title}`,
            `${taskRef(t)} waits for your approval. Accept or decline it before it expires.`,
            '/requests',
          ),
          userIds: [e.targetUserId],
        },
      ];
    }
    case 'access.requested': {
      const login = str(data.login) ?? 'someone';
      const admins = config.ORCH_ADMIN_GITHUB_LOGINS;
      if (admins.length === 0) return [];
      const users = await prisma.user.findMany({
        where: { login: { in: admins, mode: 'insensitive' } },
        select: { id: true },
      });
      return [
        {
          draft: {
            event: 'access_request',
            title: `Access request from @${login}`,
            body: `@${login} asked to sign in to this orch server. Approve or deny it on the Access page.`,
            url: '/admin/access',
            projectId: null,
            taskId: null,
          },
          userIds: users.map((u) => u.id),
        },
      ];
    }
    case 'participation.updated': {
      if (data.requested !== true || !e.projectId || !e.actorUserId) return [];
      const [project, member] = await Promise.all([
        prisma.project.findUnique({
          where: { id: e.projectId },
          select: { id: true, fullName: true, addedById: true },
        }),
        prisma.user.findUnique({ where: { id: e.actorUserId }, select: { login: true } }),
      ]);
      if (!project || !member) return [];
      return [
        {
          draft: {
            event: 'participation_request',
            title: `@${member.login} wants to join ${project.fullName}`,
            body: `@${member.login} asked to lend capacity to the ${project.fullName} pool. Approve or reject the request on the Projects page.`,
            url: '/projects',
            projectId: project.id,
            taskId: null,
          },
          userIds: recipients(e, project.addedById),
        },
      ];
    }
    default:
      return [];
  }
}
