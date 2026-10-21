/**
 * M4 REST contract: offers for approval-mode members, the Pool page, GitHub webhooks.
 *
 * Routes:
 *   POST   /api/projects/:id/tasks   (m3) accepts `dispatch` (see ./dispatch). 403 `forbidden`
 *          when a non-owner asks for `broadcast`; 400 `invalid_member` when a memberId does not
 *          participate in the project.
 *   GET    /api/offers/mine          -> OfferView[]   pending CONSENT_REQUESTs for the caller (approval
 *          mode) only: never auto offers.
 *   POST   /api/offers/:id/accept    -> OfferView     the caller consents; the task starts on one of
 *          their online, unpaused agents. 409 `offer_closed` (taken, expired, withdrawn),
 *          409 `paused`, 409 `no_agent_online`, 409 `not_participating`, 404 for other users' offers.
 *   POST   /api/offers/:id/reject    -> OfferView     the next candidate gets the task.
 *   GET    /api/pool[?projectId=]    -> PoolResponse  members of the caller's projects (owned or
 *          participating). With `projectId`, also for a submitter of that project (to pick
 *          `members` targets). Every usage figure is an ESTIMATE.
 *   POST   /api/github/webhook       GitHub App webhook. HMAC SHA-256 (`X-Hub-Signature-256`,
 *          secret from GITHUB_WEBHOOK_SECRET) checked in constant time: 401 `bad_signature`.
 *          `X-GitHub-Delivery` dedupe: a replay answers 200 `{ ok: true, duplicate: true }`.
 *
 * Errors: HTTP status + `{ error: { code, message } }` (see ApiErrorSchema in m1).
 */
import { z } from 'zod';
import { Model, ParticipationMode } from '../domain/enums';
import { AssignmentKind, TaskSize } from '../protocol/messages';
import { TaskUserSchema } from './m3';

export const OfferStatus = z.enum([
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'RUNNING',
  'PUSHED',
  'SUCCEEDED',
  'FAILED',
  'LOST',
]);
export type OfferStatus = z.infer<typeof OfferStatus>;

export const OfferViewSchema = z.object({
  id: z.string(),
  /** Always `CONSENT_REQUEST` on `/api/offers/*`: auto offers are never listed or answered there. */
  kind: AssignmentKind,
  status: OfferStatus,
  offeredAt: z.string(),
  expiresAt: z.string().nullable(),
  task: z.object({
    id: z.string(),
    projectId: z.string(),
    projectFullName: z.string(),
    issueNumber: z.number().int(),
    issueUrl: z.string(),
    title: z.string(),
    body: z.string(),
    acceptanceCriteria: z.array(z.string()),
    size: TaskSize,
    model: Model,
    createdBy: TaskUserSchema,
  }),
  /** The CLI equivalent of the Accept button. */
  acceptCommand: z.string(),
  /** M5 (additive): who asked for it (the task creator; for a broadcast, its submitter). */
  requestedBy: z.object({ githubLogin: z.string(), avatarUrl: z.string().nullable() }).optional(),
});
export type OfferView = z.infer<typeof OfferViewSchema>;
export const OfferListResponseSchema = z.array(OfferViewSchema);

export const PoolMemberProjectSchema = z.object({
  projectId: z.string(),
  fullName: z.string(),
  mode: ParticipationMode,
  budgetPercent: z.number().int(),
  /** ESTIMATE: weighted tokens this member gives the project in the current 5h window. */
  estimatedBudget: z.number().nullable(),
  /** ESTIMATE: what is left of it (budget - used - reserved). Null when usage is unknown or stale. */
  estimatedMargin: z.number().nullable(),
  /** estimatedMargin / estimatedBudget, 0..1. */
  marginFraction: z.number().nullable(),
  /** M5 (additive): the caller is this project's owner. */
  isOwner: z.boolean().optional(),
});

export const PoolMemberSchema = z.object({
  userId: z.string(),
  login: z.string(),
  avatarUrl: z.string().nullable(),
  online: z.boolean(),
  paused: z.boolean(),
  /** Additive: per-machine state (non-revoked machines), so the UI can tell paused from offline. */
  machines: z
    .array(z.object({ name: z.string(), online: z.boolean(), paused: z.boolean() }))
    .optional(),
  /** Last usage report is older than ~15 min: not eligible for auto offers. */
  usageStale: z.boolean(),
  /** ESTIMATE: when the member's 5h window resets. */
  resetAt: z.string().nullable(),
  rateLimitedUntil: z.string().nullable(),
  projects: z.array(PoolMemberProjectSchema),
  runningTasks: z.array(
    z.object({
      taskId: z.string(),
      projectId: z.string(),
      issueNumber: z.number().int(),
      title: z.string(),
      status: OfferStatus,
      /** M5 (additive). */
      projectFullName: z.string().optional(),
      /** M5 (additive). */
      issueUrl: z.string().optional(),
    }),
  ),
});
export type PoolMember = z.infer<typeof PoolMemberSchema>;

export const PoolResponseSchema = z.object({
  /** Every figure is an estimate (local logs, plan presets). */
  estimate: z.literal(true),
  members: z.array(PoolMemberSchema),
  /** M5 (additive): projects in scope with the caller's ownership, members or not. */
  projects: z
    .array(z.object({ projectId: z.string(), fullName: z.string(), isOwner: z.boolean() }))
    .optional(),
});
export type PoolResponse = z.infer<typeof PoolResponseSchema>;

export const WebhookResponseSchema = z.object({
  ok: z.boolean(),
  duplicate: z.boolean().optional(),
  /** What the server did, for logs and tests. */
  result: z.string().optional(),
});
export type WebhookResponse = z.infer<typeof WebhookResponseSchema>;
