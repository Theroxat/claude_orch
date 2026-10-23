/**
 * Notifications contract (cookie session, JSON).
 *
 *   GET  /api/notifications               ?limit=1..100 (default 30)
 *        -> NotificationListResponse      the caller's latest notifications, newest first
 *   GET  /api/notifications/unread-count  -> UnreadCountResponse (cheap, polled by the bell)
 *   POST /api/notifications/read          MarkNotificationsReadRequest -> UnreadCountResponse
 *        `ids` marks those notifications read, `all: true` marks every one read.
 *   GET  /api/notifications/settings      -> NotificationSettingsView
 *   PUT  /api/notifications/settings      UpdateNotificationSettingsRequest -> NotificationSettingsView
 *        A target left out is kept, `null` or `''` clears it. Webhook URLs must be public `https`
 *        URLs (private, loopback and link-local addresses are refused, here and at delivery).
 *   POST /api/notifications/email/resend  -> { ok: true } (generic; 429 past 3/hour or 10/day)
 *        Sends a fresh confirmation link to the pending address (the previous link stops working).
 *   POST /api/notifications/email/confirm ConfirmEmailRequest -> NotificationSettingsView
 *        Confirms the pending address with the single-use token of the e-mailed link (400 when
 *        invalid or expired, without saying which). The link opens a page of the web app, which
 *        POSTs only when the member clicks, so link prefetchers cannot confirm.
 *   POST /api/notifications/test          SendTestNotificationRequest -> SendTestNotificationResponse
 *        Sends one test message on that channel right away (single attempt) and reports the result.
 *
 * Webhook URLs are secrets (anyone holding a Slack or Discord webhook URL can post to it): they are
 * stored encrypted and only a masked hint is returned.
 */
import { z } from 'zod';

export const NotificationEvent = z.enum([
  /** The task's PR was merged. */
  'task_done',
  /** A run failed or was lost. */
  'task_failed',
  /** A task stopped being dispatched (repeated setup failures) or your Claude login is invalid. */
  'task_needs_attention',
  /** A PR was opened for a task and waits for review. */
  'pr_review',
  /** A task is offered to you and waits for your approval. */
  'consent_request',
  /** Admins: someone asked for access to the server. */
  'access_request',
  /** Project owners: someone asked to join the pool. */
  'participation_request',
]);
export type NotificationEvent = z.infer<typeof NotificationEvent>;
export const NOTIFICATION_EVENTS = NotificationEvent.options;

export const NotificationChannel = z.enum(['in_app', 'email', 'slack', 'discord', 'webhook']);
export type NotificationChannel = z.infer<typeof NotificationChannel>;
export const NOTIFICATION_CHANNELS = NotificationChannel.options;

/** Per event, the channels it is sent on. */
export const NotificationPreferencesSchema = z.record(
  NotificationEvent,
  z.array(NotificationChannel).max(NOTIFICATION_CHANNELS.length),
);
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

/** Every event in-app, nothing else until the member sets up a channel. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.fromEntries(
  NOTIFICATION_EVENTS.map((e) => [e, ['in_app']]),
) as NotificationPreferences;

export const NotificationItemSchema = z.object({
  id: z.string(),
  event: NotificationEvent,
  title: z.string(),
  body: z.string(),
  /** Where the notification leads: an app path (`/backlog?...`) or an absolute URL (a PR). */
  url: z.string().nullable(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type NotificationItem = z.infer<typeof NotificationItemSchema>;

export const NotificationListResponseSchema = z.object({
  items: z.array(NotificationItemSchema),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

export const UnreadCountResponseSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
});
export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;

export const MarkNotificationsReadRequestSchema = z.union([
  z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(100) }),
  z.object({ all: z.literal(true) }),
]);
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequestSchema>;

export const WebhookTargetViewSchema = z.object({
  configured: z.boolean(),
  /** Masked URL, e.g. `https://hooks.slack.com/…a1b2`. Null when not configured. */
  hint: z.string().nullable(),
});
export type WebhookTargetView = z.infer<typeof WebhookTargetViewSchema>;

export const NotificationSettingsViewSchema = z.object({
  preferences: NotificationPreferencesSchema,
  slack: WebhookTargetViewSchema,
  discord: WebhookTargetViewSchema,
  webhook: WebhookTargetViewSchema,
  email: z.object({
    /** False when the server has no SMTP settings: the e-mail channel is then unavailable. */
    available: z.boolean(),
    address: z.string().nullable(),
    /** `pending`: a confirmation e-mail was sent, nothing is delivered to it until confirmed. */
    status: z.enum(['none', 'pending', 'verified']),
  }),
});
export type NotificationSettingsView = z.infer<typeof NotificationSettingsViewSchema>;

const MAX_URL = 2000;
const optionalTarget = z.union([z.string().trim().max(MAX_URL), z.null()]).optional();

export const UpdateNotificationSettingsRequestSchema = z.object({
  preferences: NotificationPreferencesSchema.optional(),
  slackWebhookUrl: optionalTarget,
  discordWebhookUrl: optionalTarget,
  webhookUrl: optionalTarget,
  email: z.union([z.email().max(320), z.literal(''), z.null()]).optional(),
});
export type UpdateNotificationSettingsRequest = z.infer<
  typeof UpdateNotificationSettingsRequestSchema
>;

export const ConfirmEmailRequestSchema = z.object({ token: z.string().min(16).max(200) });
export type ConfirmEmailRequest = z.infer<typeof ConfirmEmailRequestSchema>;
export const OkResponseSchema = z.object({ ok: z.literal(true) });

export const SendTestNotificationRequestSchema = z.object({ channel: NotificationChannel });
export type SendTestNotificationRequest = z.infer<typeof SendTestNotificationRequestSchema>;

export const SendTestNotificationResponseSchema = z.object({
  ok: z.boolean(),
  /** Why the test failed (no secret in it), e.g. `HTTP 404` or `not_configured`. */
  error: z.string().optional(),
});
export type SendTestNotificationResponse = z.infer<typeof SendTestNotificationResponseSchema>;
