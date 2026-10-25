/**
 * `GET /api/usage?range=7d|30d|90d`: aggregated usage for the dashboard. Contract in shared
 * api/usage. Aggregation runs in SQL (one pass over the visible finished runs per breakdown) and
 * uses the existing (status, finishedAt) index on Assignment.
 *
 * Visibility of a run: admin, or the run is the caller's own, or it belongs to a project the caller
 * owns. For a private repository, "owns" means GitHub still gives the stored owner the ADMIN role
 * (cached check); a repository the owner lost access to disappears from their runs and budgets. Nobody else's runs are ever read into the response, and the token split (reports describe a
 * whole machine) is limited to the caller's own agents (all agents for admins).
 */
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  UsageRangeQuerySchema,
  type UsageBudgetRow,
  type UsageDashboard,
  type UsageDayPoint,
  type UsageMemberRow,
  type UsageProjectRow,
  type UsageRange,
  type UsageTopTask,
  type UsageTotals,
} from '@orch/shared';
import { requireUser, type AuthDeps } from '../auth';
import type { PrismaClient } from '../db';
import { computeMargin, windowStartOf, type UsageSnapshot } from '../dispatch/budget';
import { parseBody } from '../http/errors';
import type { GithubClient } from '../github';
import { ownerLostAccess, stillOwns } from '../projects/service';
import { USAGE_RETENTION_MS } from './index';

const DAY_MS = 24 * 3600_000;
const RANGE_DAYS: Record<UsageRange, number> = { '7d': 7, '30d': 30, '90d': 90 };
const TOP_TASKS = 10;

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

interface Viewer {
  id: string;
  /** Needed with `github`, to re-check the owner's access on GitHub. */
  login?: string;
  isAdmin: boolean;
}

/** Runs the viewer may see, finished in [from, to). Aliases: a = Assignment, t = Task. */
function visibleRuns(
  viewer: Viewer,
  owned: string[],
  lost: string[],
  from: Date,
  to: Date,
): Prisma.Sql {
  const who = viewer.isAdmin
    ? Prisma.sql`TRUE`
    : owned.length > 0
      ? Prisma.sql`(a."userId" = ${viewer.id} OR t."projectId" IN (${Prisma.join(owned)}))`
      : Prisma.sql`a."userId" = ${viewer.id}`;
  return Prisma.sql`a."status" IN ('SUCCEEDED', 'FAILED')
    AND a."finishedAt" >= ${from} AND a."finishedAt" < ${to} AND ${who}
    ${lost.length > 0 ? Prisma.sql`AND t."projectId" NOT IN (${Prisma.join(lost)})` : Prisma.empty}`;
}

const TOTALS = Prisma.sql`COUNT(*)::int AS runs,
  COUNT(*) FILTER (WHERE a."status" = 'SUCCEEDED')::int AS succeeded,
  COUNT(*) FILTER (WHERE a."status" = 'FAILED')::int AS failed,
  COALESCE(SUM(a."usageWeighted"), 0)::float8 AS weighted`;

const totalsOf = (r: Record<string, unknown>): UsageTotals => ({
  runs: num(r.runs),
  succeeded: num(r.succeeded),
  failed: num(r.failed),
  weighted: num(r.weighted),
});

export async function computeUsageDashboard(
  prisma: PrismaClient,
  viewer: Viewer,
  range: UsageRange,
  reserve: number,
  now: Date = new Date(),
  github?: GithubClient,
): Promise<UsageDashboard> {
  const days = RANGE_DAYS[range];
  const startOfToday = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const from = new Date(startOfToday.getTime() - (days - 1) * DAY_MS);
  const to = new Date(startOfToday.getTime() + DAY_MS);

  const ownedRows = viewer.isAdmin
    ? []
    : await prisma.project.findMany({
        where: { addedById: viewer.id },
        include: { installation: true },
      });
  const who = { id: viewer.id, login: viewer.login ?? '' };
  const owned: string[] = [];
  // Private repositories the stored owner can no longer reach: not even their own runs show.
  const lost: string[] = [];
  for (const p of ownedRows) {
    if (await stillOwns(prisma, github, p, who)) owned.push(p.id);
    if (await ownerLostAccess(prisma, github, p, who)) lost.push(p.id);
  }
  const where = visibleRuns(viewer, owned, lost, from, to);

  const reportScope = viewer.isAdmin ? Prisma.sql`TRUE` : Prisma.sql`"userId" = ${viewer.id}`;

  const [byDay, byMember, byProject, top, split, budgets] = await Promise.all([
    prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT to_char(date_trunc('day', a."finishedAt"), 'YYYY-MM-DD') AS day, ${TOTALS}
      FROM "Assignment" a JOIN "Task" t ON t."id" = a."taskId"
      WHERE ${where} GROUP BY 1`,
    prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT u."id" AS "userId", u."login", u."name", u."avatarUrl", ${TOTALS}
      FROM "Assignment" a JOIN "Task" t ON t."id" = a."taskId" JOIN "User" u ON u."id" = a."userId"
      WHERE ${where} GROUP BY u."id" ORDER BY weighted DESC, runs DESC, u."login"`,
    prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT p."id" AS "projectId", p."fullName", ${TOTALS}
      FROM "Assignment" a JOIN "Task" t ON t."id" = a."taskId" JOIN "Project" p ON p."id" = t."projectId"
      WHERE ${where} GROUP BY p."id" ORDER BY weighted DESC, runs DESC, p."fullName"`,
    prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT t."id" AS "taskId", t."title", t."githubIssueNumber" AS "issueNumber",
             p."id" AS "projectId", p."fullName" AS "projectFullName",
             COUNT(*)::int AS runs, COALESCE(SUM(a."usageWeighted"), 0)::float8 AS weighted
      FROM "Assignment" a JOIN "Task" t ON t."id" = a."taskId" JOIN "Project" p ON p."id" = t."projectId"
      WHERE ${where} GROUP BY t."id", p."id"
      HAVING COALESCE(SUM(a."usageWeighted"), 0) > 0
      ORDER BY weighted DESC, t."id" LIMIT ${TOP_TASKS}`,
    // One row per (agent, window): the latest report of a window is its running total.
    prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT to_char(date_trunc('day', "windowStart"), 'YYYY-MM-DD') AS day,
             SUM("inputTokens")::float8 AS input, SUM("outputTokens")::float8 AS output,
             SUM("cacheWriteTokens")::float8 AS "cacheWrite", SUM("cacheReadTokens")::float8 AS "cacheRead"
      FROM (
        SELECT DISTINCT ON ("agentId", "windowStart") *
        FROM "UsageReport"
        WHERE "windowStart" >= ${from} AND "windowStart" < ${to} AND ${reportScope}
        ORDER BY "agentId", "windowStart", "reportedAt" DESC
      ) w GROUP BY 1`,
    ownBudgets(prisma, github, who, reserve, now),
  ]);

  const dayMap = new Map(byDay.map((r) => [String(r.day), totalsOf(r)]));
  const splitMap = new Map(split.map((r) => [String(r.day), r]));
  const hasSplit = splitMap.size > 0;
  const series: UsageDayPoint[] = [];
  for (let i = 0; i < days; i++) {
    const day = dayKey(new Date(from.getTime() + i * DAY_MS));
    const t = dayMap.get(day) ?? { runs: 0, succeeded: 0, failed: 0, weighted: 0 };
    const s = splitMap.get(day);
    series.push({
      day,
      ...t,
      input: s ? num(s.input) : null,
      output: s ? num(s.output) : null,
      cacheWrite: s ? num(s.cacheWrite) : null,
      cacheRead: s ? num(s.cacheRead) : null,
    });
  }

  const totals = series.reduce<UsageTotals>(
    (acc, d) => ({
      runs: acc.runs + d.runs,
      succeeded: acc.succeeded + d.succeeded,
      failed: acc.failed + d.failed,
      weighted: acc.weighted + d.weighted,
    }),
    { runs: 0, succeeded: 0, failed: 0, weighted: 0 },
  );
  const sum = (k: 'input' | 'output' | 'cacheWrite' | 'cacheRead') =>
    series.reduce((n, d) => n + (d[k] ?? 0), 0);

  return {
    estimate: true,
    range,
    from: from.toISOString(),
    to: to.toISOString(),
    scope: viewer.isAdmin ? 'admin' : 'own',
    totals,
    tokenSplit: hasSplit
      ? {
          input: sum('input'),
          output: sum('output'),
          cacheWrite: sum('cacheWrite'),
          cacheRead: sum('cacheRead'),
        }
      : null,
    series,
    members: byMember.map((r): UsageMemberRow => ({
      userId: String(r.userId),
      login: String(r.login),
      name: (r.name as string | null) ?? null,
      avatarUrl: (r.avatarUrl as string | null) ?? null,
      ...totalsOf(r),
    })),
    projects: byProject.map((r): UsageProjectRow => ({
      projectId: String(r.projectId),
      fullName: String(r.fullName),
      ...totalsOf(r),
    })),
    topTasks: top.map((r): UsageTopTask => ({
      taskId: String(r.taskId),
      title: String(r.title),
      issueNumber: num(r.issueNumber),
      projectId: String(r.projectId),
      projectFullName: String(r.projectFullName),
      runs: num(r.runs),
      weighted: num(r.weighted),
    })),
    budgets,
    splitRetentionDays: Math.round(USAGE_RETENTION_MS / DAY_MS),
  };
}

/** The member's active project budgets against the current window (same arithmetic as dispatch). */
async function ownBudgets(
  prisma: PrismaClient,
  github: GithubClient | undefined,
  user: { id: string; login: string },
  reserve: number,
  now: Date,
): Promise<UsageBudgetRow[]> {
  const userId = user.id;
  const all = await prisma.participation.findMany({
    where: { userId, active: true },
    include: { project: { include: { installation: true } } },
    orderBy: { project: { fullName: 'asc' } },
  });
  const parts = [];
  for (const p of all) {
    if (!(await ownerLostAccess(prisma, github, p.project, user))) parts.push(p);
  }
  if (parts.length === 0) return [];
  const report = await prisma.usageReport.findFirst({
    where: { userId },
    orderBy: { reportedAt: 'desc' },
  });
  const usage: UsageSnapshot | null = report
    ? {
        reportedAt: report.reportedAt,
        windowStart: report.windowStart,
        windowResetAt: report.windowResetAt,
        weighted: Number(report.weightedTokens),
        capacity: report.capacityEstimate === null ? null : Number(report.capacityEstimate),
        byProject: (report.byProject ?? {}) as Record<string, number>,
        rateLimitedUntil: report.rateLimitedUntil,
      }
    : null;
  const since = windowStartOf(usage, now);
  const orch = await prisma.assignment.groupBy({
    by: ['taskId'],
    where: { userId, status: { in: ['SUCCEEDED', 'FAILED'] }, finishedAt: { gte: since } },
    _sum: { usageWeighted: true },
  });
  const taskProject = new Map(
    (
      await prisma.task.findMany({
        where: { id: { in: orch.map((o) => o.taskId) } },
        select: { id: true, projectId: true },
      })
    ).map((t) => [t.id, t.projectId]),
  );
  const orchByProject = new Map<string, number>();
  for (const o of orch) {
    const pid = taskProject.get(o.taskId);
    if (pid) orchByProject.set(pid, (orchByProject.get(pid) ?? 0) + num(o._sum.usageWeighted));
  }

  return parts.map((p) => {
    const orchUsed = orchByProject.get(p.projectId) ?? 0;
    const m = usage
      ? computeMargin({
          usage,
          now,
          projectId: p.projectId,
          percent: p.percent,
          reserve,
          orchUsedInWindow: orchUsed,
          reservedProject: 0,
          reservedAll: 0,
        })
      : null;
    return {
      projectId: p.projectId,
      fullName: p.project.fullName,
      percent: p.percent,
      budget: m ? m.budget : null,
      used: m ? m.used : orchUsed,
      usedFraction: m && m.budget > 0 ? m.used / m.budget : null,
    };
  });
}

export function registerUsage(
  app: FastifyInstance,
  deps: AuthDeps & { config: { BUDGET_SAFETY_RESERVE: number } },
): void {
  app.get('/api/usage', async (req): Promise<UsageDashboard> => {
    const user = requireUser(req);
    const { range } = parseBody(UsageRangeQuerySchema, req.query);
    return computeUsageDashboard(
      deps.prisma,
      { id: user.id, login: user.login, isAdmin: app.allowlist.isAdmin(user.login) },
      range,
      deps.config.BUDGET_SAFETY_RESERVE,
      new Date(),
      deps.github,
    );
  });
}
