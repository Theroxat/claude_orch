/**
 * Task history contract.
 *
 *   GET /api/tasks/history  HistoryQuery (query string) -> HistoryResponse
 *
 * Covers tasks of the projects the caller sees on the Backlog (same visibility rules as
 * `GET /api/tasks`: owner, or active participant; private repositories are never leaked). A task
 * is part of the history once it has started or ended: IN_PROGRESS, IN_REVIEW, DONE, CANCELLED,
 * or back in the queue (TODO) after at least one run.
 *
 * Order is stable: `createdAt` descending, then `id` descending. `nextCursor` is opaque; pass it
 * back as `cursor` with the same filters. Filters combine with AND; list filters (`status`,
 * `project`, `model`) repeat the key (`?status=DONE&status=IN_REVIEW`) and combine with OR.
 */
import { z } from 'zod';
import { FailureClass } from '../domain/failure';
import { Model } from '../domain/enums';
import { TaskSize } from '../protocol/messages';
import { TaskUserSchema } from './m3';

export const HistoryStatus = z.enum(['IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED', 'TODO']);
export type HistoryStatus = z.infer<typeof HistoryStatus>;

export const HISTORY_PAGE_SIZE = 25;
export const HISTORY_MAX_PAGE_SIZE = 100;

/** `?k=a&k=b` arrives as an array, `?k=a` as a string, absent as undefined. */
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]),
    z.array(item).max(20),
  );

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const HistoryQuerySchema = z.object({
  status: list(HistoryStatus),
  /** Project ids. */
  project: list(z.string().min(1).max(64)),
  /** GitHub login of the task creator. */
  creator: z.string().trim().min(1).max(64).optional(),
  /** GitHub login of a member who ran the task. */
  executor: z.string().trim().min(1).max(64).optional(),
  model: list(Model),
  /** Created on or after this day (UTC). */
  from: day.optional(),
  /** Created on or before this day (UTC). */
  to: day.optional(),
  /** Title, issue number (`12` or `#12`) or PR number. */
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_MAX_PAGE_SIZE).default(HISTORY_PAGE_SIZE),
});
export type HistoryQuery = z.input<typeof HistoryQuerySchema>;

export const HistoryItemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectFullName: z.string(),
  issueNumber: z.number().int(),
  issueUrl: z.string(),
  title: z.string(),
  status: HistoryStatus,
  model: Model,
  size: TaskSize,
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  /** Runs that actually started. */
  attempts: z.number().int().nonnegative(),
  /** Class of the most recent failed run (null when none failed). */
  lastFailureClass: FailureClass.nullable(),
  /** Total wall-clock time of the finished runs, in milliseconds (null when none finished). */
  durationMs: z.number().int().nonnegative().nullable(),
  /** Weighted tokens used by all runs (null when no run reported usage). */
  tokens: z.number().nonnegative().nullable(),
  createdBy: TaskUserSchema,
  /** Member who ran the latest attempt. */
  executor: TaskUserSchema.nullable(),
  createdAt: z.string(),
  /** End of the latest finished run. */
  finishedAt: z.string().nullable(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const HistoryResponseSchema = z.object({
  items: z.array(HistoryItemSchema),
  nextCursor: z.string().nullable(),
  /** First page only: values the filter bar can offer. */
  facets: z
    .object({
      projects: z.array(z.object({ id: z.string(), fullName: z.string() })),
      people: z.array(TaskUserSchema),
    })
    .optional(),
});
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;
