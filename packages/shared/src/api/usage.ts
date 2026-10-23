/**
 * Usage dashboard contract: `GET /api/usage?range=7d|30d|90d` (cookie session) -> UsageDashboard.
 *
 * Every figure is an ESTIMATE. "Weighted" tokens are the agent's model-weighted count (Opus counts
 * more than Sonnet); runs are finished task attempts (succeeded or failed).
 *
 * Who sees what: a member sees their own runs plus every run of the projects they own; admins see
 * everything. The input/output/cache split comes from agent usage reports, which describe a whole
 * machine (personal use included): it is only returned for the member's own agents (all agents for
 * admins), never for other members.
 */
import { z } from 'zod';

export const UsageRange = z.enum(['7d', '30d', '90d']);
export type UsageRange = z.infer<typeof UsageRange>;

export const UsageRangeQuerySchema = z.object({ range: UsageRange.default('30d') });

const count = z.number().int().nonnegative();
const tokens = z.number().nonnegative();

export const UsageTotalsSchema = z.object({
  runs: count,
  succeeded: count,
  failed: count,
  weighted: tokens,
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageDayPointSchema = UsageTotalsSchema.extend({
  /** UTC day, `YYYY-MM-DD`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Token split from usage reports (own machines; null when not visible or none reported). */
  input: tokens.nullable(),
  output: tokens.nullable(),
  cacheWrite: tokens.nullable(),
  cacheRead: tokens.nullable(),
});
export type UsageDayPoint = z.infer<typeof UsageDayPointSchema>;

export const UsageMemberRowSchema = UsageTotalsSchema.extend({
  userId: z.string(),
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type UsageMemberRow = z.infer<typeof UsageMemberRowSchema>;

export const UsageProjectRowSchema = UsageTotalsSchema.extend({
  projectId: z.string(),
  fullName: z.string(),
});
export type UsageProjectRow = z.infer<typeof UsageProjectRowSchema>;

export const UsageTopTaskSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  issueNumber: z.number().int(),
  projectId: z.string(),
  projectFullName: z.string(),
  runs: count,
  weighted: tokens,
});
export type UsageTopTask = z.infer<typeof UsageTopTaskSchema>;

/** The member's own project budgets against the current 5-hour window. */
export const UsageBudgetRowSchema = z.object({
  projectId: z.string(),
  fullName: z.string(),
  /** Share of capacity given to the project (0..100). */
  percent: z.number().int().min(0).max(100),
  /** Budget in weighted tokens for the current window; null when capacity is unknown. */
  budget: tokens.nullable(),
  used: tokens,
  /** used / budget, may exceed 1; null when the budget is unknown. */
  usedFraction: z.number().nonnegative().nullable(),
});
export type UsageBudgetRow = z.infer<typeof UsageBudgetRowSchema>;

export const UsageDashboardSchema = z.object({
  estimate: z.literal(true),
  range: UsageRange,
  from: z.string(),
  to: z.string(),
  scope: z.enum(['own', 'admin']),
  totals: UsageTotalsSchema,
  /** Token split totals over the range; null when not visible. */
  tokenSplit: z
    .object({ input: tokens, output: tokens, cacheWrite: tokens, cacheRead: tokens })
    .nullable(),
  /** One point per UTC day of the range, oldest first, zero-filled. */
  series: z.array(UsageDayPointSchema),
  members: z.array(UsageMemberRowSchema),
  projects: z.array(UsageProjectRowSchema),
  topTasks: z.array(UsageTopTaskSchema),
  budgets: z.array(UsageBudgetRowSchema),
  /** Usage reports are kept 30 days: the token split cannot go further back. */
  splitRetentionDays: z.number().int(),
});
export type UsageDashboard = z.infer<typeof UsageDashboardSchema>;
