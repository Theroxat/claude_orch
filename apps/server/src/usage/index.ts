import type { UsageReport } from '@prisma/client';
import type { AgentUsageSummary, UsageReportPayload } from '@orch/shared';
import type { PrismaClient } from '../db';

export const USAGE_RETENTION_MS = 30 * 24 * 3600_000;
export const MESSAGE_SEEN_RETENTION_MS = 24 * 3600_000;

const big = (n: number) => BigInt(Math.round(n));

/** Stores one usage report and bumps Agent.lastUsageAt. */
export async function recordUsage(
  prisma: PrismaClient,
  agent: { id: string; userId: string },
  p: UsageReportPayload,
  now: Date = new Date(),
): Promise<void> {
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
        rateLimitedUntil: p.rateLimitedUntil ? new Date(p.rateLimitedUntil) : null,
        source: p.source,
      },
    }),
    prisma.agent.update({ where: { id: agent.id }, data: { lastUsageAt: now } }),
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
