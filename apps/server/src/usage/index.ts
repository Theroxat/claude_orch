import type { UsageReport } from '@prisma/client';
import type { AgentUsageSummary, UsageReportPayload } from '@orch/shared';
import type { PrismaClient } from '../db';

export const USAGE_RETENTION_MS = 30 * 24 * 3600_000;
export const MESSAGE_SEEN_RETENTION_MS = 24 * 3600_000;

const big = (n: number) => BigInt(Math.round(n));

/**
 * Agent fields for a reported `claudeAuthValid` (v0.5.1 agents; absent = unchanged). A report of
 * true after `orch login` clears the flag the server set on a `claude_auth` failure.
 */
export function claudeAuthUpdate(
  current: { claudeAuthValid: boolean } | null,
  reported: boolean | undefined,
): { claudeAuthValid?: boolean; claudeAuthInvalidAt?: Date | null } {
  if (reported === undefined || current?.claudeAuthValid === reported) return {};
  return reported
    ? { claudeAuthValid: true, claudeAuthInvalidAt: null }
    : { claudeAuthValid: false, claudeAuthInvalidAt: new Date() };
}

/** Stores one usage report and bumps Agent.lastUsageAt. */
export async function recordUsage(
  prisma: PrismaClient,
  agent: { id: string; userId: string },
  p: UsageReportPayload,
  now: Date = new Date(),
): Promise<void> {
  // A rate limit known from a failed run (or an earlier report) holds until it lapses, even if
  // this report did not see it.
  const prev = await prisma.usageReport.findFirst({
    where: { agentId: agent.id },
    orderBy: { reportedAt: 'desc' },
    select: { rateLimitedUntil: true },
  });
  const reported = p.rateLimitedUntil ? new Date(p.rateLimitedUntil) : null;
  const carried =
    prev?.rateLimitedUntil && prev.rateLimitedUntil.getTime() > now.getTime()
      ? prev.rateLimitedUntil
      : null;
  const rateLimitedUntil = carried && (!reported || carried > reported) ? carried : reported;
  const current = await prisma.agent.findUnique({
    where: { id: agent.id },
    select: { claudeAuthValid: true },
  });
  await prisma.$transaction([
    prisma.usageReport.create({
      data: {
        agentId: agent.id,
        userId: agent.userId,
        reportedAt: now,
        windowStart: p.windowStart ? new Date(p.windowStart) : null,
        windowResetAt: p.windowResetAt ? new Date(p.windowResetAt) : null,
        inputTokens: big(p.tokens.input),
        outputTokens: big(p.tokens.output),
        cacheWriteTokens: big(p.tokens.cacheWrite),
        cacheReadTokens: big(p.tokens.cacheRead),
        weightedTokens: big(p.weighted),
        byModel: p.byModel,
        byProject: p.byProject,
        capacityEstimate: p.capacityEstimate === null ? null : big(p.capacityEstimate),
        rateLimitedUntil,
        source: p.source,
      },
    }),
    prisma.agent.update({
      where: { id: agent.id },
      data: {
        lastUsageAt: now,
        ...(p.claudeTokenPresent !== undefined && { claudeTokenPresent: p.claudeTokenPresent }),
        ...claudeAuthUpdate(current, p.claudeAuthValid),
      },
    }),
  ]);
}

export function toUsageSummary(r: UsageReport): AgentUsageSummary {
  const weighted = Number(r.weightedTokens);
  const capacity = r.capacityEstimate === null ? null : Number(r.capacityEstimate);
  return {
    estimate: true,
    reportedAt: r.reportedAt.toISOString(),
    windowStart: r.windowStart?.toISOString() ?? null,
    windowResetAt: r.windowResetAt?.toISOString() ?? null,
    weighted,
    capacityEstimate: capacity,
    usedFraction: capacity ? weighted / capacity : null,
    rateLimitedUntil: r.rateLimitedUntil?.toISOString() ?? null,
  };
}

/** Deletes usage reports older than 30 days and dedupe entries older than 24 h. */
export async function purgeRetention(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<{ usageReports: number; messagesSeen: number }> {
  const u = await prisma.usageReport.deleteMany({
    where: { reportedAt: { lt: new Date(now.getTime() - USAGE_RETENTION_MS) } },
  });
  const m = await prisma.agentMessageSeen.deleteMany({
    where: { seenAt: { lt: new Date(now.getTime() - MESSAGE_SEEN_RETENTION_MS) } },
  });
  return { usageReports: u.count, messagesSeen: m.count };
}
