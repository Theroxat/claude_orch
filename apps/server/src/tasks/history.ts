import { Prisma, type User } from '@prisma/client';
import {
  type HistoryItem,
  type HistoryQuerySchema,
  type HistoryResponse,
  type HistoryStatus,
} from '@orch/shared';
import type { z } from 'zod';
import { failureClassOf } from '../dispatch/failures';
import { HttpError } from '../http/errors';
import type { PrismaClient } from '../db';
import { issueUrlFor } from './service';

export type HistoryFilters = z.output<typeof HistoryQuerySchema>;

/** Statuses that always belong to the history; a TODO task joins it after its first run. */
const ENDED_OR_RUNNING: HistoryStatus[] = ['IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'];
const MAX_INT = 2_147_483_647;

const historyInclude = {
  project: { select: { fullName: true } },
  createdBy: true,
  assignments: {
    where: { startedAt: { not: null } },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: {
      status: true,
      failureClass: true,
      reason: true,
      startedAt: true,
      finishedAt: true,
      usageWeighted: true,
      user: true,
    },
  },
} satisfies Prisma.TaskInclude;
type HistoryRow = Prisma.TaskGetPayload<{ include: typeof historyInclude }>;

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([A-Za-z0-9_-]{1,64})$/;

/**
 * The cursor is only a keyset position (never an authorization): it is ANDed with the visibility
 * and filter clauses. It is still parsed strictly so garbage fails with a 400, not a DB error.
 */
export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const m = CURSOR_RE.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  const createdAt = m ? new Date(m[1]!) : null;
  if (!m || !createdAt || Number.isNaN(createdAt.getTime())) {
    throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid');
  }
  return { createdAt, id: m[2]! };
}

const userView = (u: User) => ({ id: u.id, githubLogin: u.login, avatarUrl: u.avatarUrl });

function toItem(t: HistoryRow, webUrl: string): HistoryItem {
  const runs = t.assignments; // newest first
  let durationMs: number | null = null;
  let tokens: number | null = null;
  let finishedAt: Date | null = null;
  for (const a of runs) {
    if (a.startedAt && a.finishedAt) {
      durationMs = (durationMs ?? 0) + Math.max(0, a.finishedAt.getTime() - a.startedAt.getTime());
    }
    if (a.finishedAt && (!finishedAt || a.finishedAt > finishedAt)) finishedAt = a.finishedAt;
    if (a.usageWeighted !== null) tokens = (tokens ?? 0) + Number(a.usageWeighted);
  }
  const failed = runs.find((a) => a.status === 'FAILED');
  return {
    id: t.id,
    projectId: t.projectId,
    projectFullName: t.project.fullName,
    issueNumber: t.githubIssueNumber,
    issueUrl: issueUrlFor(webUrl, t.project.fullName, t.githubIssueNumber),
    title: t.title,
    status: t.status as HistoryStatus,
    model: t.model,
    size: t.size,
    prNumber: t.prNumber,
    prUrl: t.prUrl,
    attempts: runs.length,
    lastFailureClass: failed ? failureClassOf(failed) : null,
    durationMs,
    tokens,
    createdBy: userView(t.createdBy),
    executor: runs[0] ? userView(runs[0].user) : null,
    createdAt: t.createdAt.toISOString(),
    finishedAt: finishedAt?.toISOString() ?? null,
  };
}

function buildWhere(f: HistoryFilters, projectIds: string[]): Prisma.TaskWhereInput {
  const and: Prisma.TaskWhereInput[] = [
    {
      OR: [
        { status: { in: ENDED_OR_RUNNING } },
        { assignments: { some: { startedAt: { not: null } } } },
      ],
    },
  ];
  if (f.status.length > 0) and.push({ status: { in: f.status } });
  if (f.model.length > 0) and.push({ model: { in: f.model } });
  if (f.creator) {
    and.push({ createdBy: { login: { equals: f.creator, mode: 'insensitive' } } });
  }
  if (f.executor) {
    and.push({
      assignments: {
        some: {
          startedAt: { not: null },
          user: { login: { equals: f.executor, mode: 'insensitive' } },
        },
      },
    });
  }
  if (f.from) and.push({ createdAt: { gte: new Date(`${f.from}T00:00:00.000Z`) } });
  if (f.to) {
    and.push({ createdAt: { lt: new Date(Date.parse(`${f.to}T00:00:00.000Z`) + 86_400_000) } });
  }
  if (f.q) {
    const or: Prisma.TaskWhereInput[] = [
      { title: { contains: escapeLike(f.q), mode: 'insensitive' } },
    ];
    const num = /^#?(\d{1,10})$/.exec(f.q);
    if (num && Number(num[1]) <= MAX_INT) {
      const n = Number(num[1]);
      or.push({ githubIssueNumber: n }, { prNumber: n });
    }
    and.push({ OR: or });
  }
  if (f.cursor) {
    const c = decodeCursor(f.cursor);
    and.push({
      OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
    });
  }
  return { projectId: { in: projectIds }, AND: and };
}

/** Prisma passes `contains` straight to ILIKE: make `%`, `_` and `\\` literal. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface HistoryContext {
  prisma: PrismaClient;
  webUrl: string;
}

/** Searchable task history, limited to the projects the caller sees on the Backlog. */
export async function listHistory(
  ctx: HistoryContext,
  visible: { id: string; fullName: string }[],
  f: HistoryFilters,
): Promise<HistoryResponse> {
  const visibleIds = visible.map((v) => v.id);
  // A project filter can only narrow the visible set, never widen it.
  const projectIds =
    f.project.length > 0 ? visibleIds.filter((id) => f.project.includes(id)) : visibleIds;
  const facets = f.cursor ? undefined : await loadFacets(ctx.prisma, visible, visibleIds);
  if (projectIds.length === 0) return { items: [], nextCursor: null, facets };

  const rows = await ctx.prisma.task.findMany({
    where: buildWhere(f, projectIds),
    include: historyInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: f.limit + 1,
  });
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  const hasMore = rows.length > f.limit && !!last;
  return {
    items: page.map((t) => toItem(t, ctx.webUrl)),
    nextCursor: hasMore ? encodeCursor(last.createdAt, last.id) : null,
    facets,
  };
}

async function loadFacets(
  prisma: PrismaClient,
  visible: { id: string; fullName: string }[],
  ids: string[],
): Promise<NonNullable<HistoryResponse['facets']>> {
  if (ids.length === 0) return { projects: [], people: [] };
  const [creators, runners] = await Promise.all([
    prisma.task.groupBy({ by: ['createdById'], where: { projectId: { in: ids } } }),
    prisma.assignment.groupBy({
      by: ['userId'],
      where: { startedAt: { not: null }, task: { projectId: { in: ids } } },
    }),
  ]);
  const userIds = [
    ...new Set([...creators.map((c) => c.createdById), ...runners.map((r) => r.userId)]),
  ];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    orderBy: { login: 'asc' },
  });
  return {
    projects: visible
      .map((v) => ({ id: v.id, fullName: v.fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    people: users.map(userView),
  };
}
