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
 *   POST /api/notifications/test          SendTestNotificationRequest -> SendTestNotificationResponse
 *        Sends one test message on that channel right away (single attempt) and reports the result.
 *   POST /api/notifications/push/subscribe    PushSubscribeRequest -> PushStatus
 *        Registers this browser (a Web Push subscription) for the caller. Needs the server's VAPID
 *        keys (`settings.push.available`); the endpoint must be a known push service over https.
 *   POST /api/notifications/push/unsubscribe  PushUnsubscribeRequest -> PushStatus
 *        Forgets one browser of the caller.
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

export const NotificationChannel = z.enum([
  'in_app',
  'email',
  'slack',
  'discord',
  'webhook',
  /** Web Push: a system notification in the member's browsers. */
  'push',
]);
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
  }),
  push: z.object({
    /** False when the server has no VAPID keys: browser notifications are then unavailable. */
    available: z.boolean(),
    /** VAPID public key (base64url) for `pushManager.subscribe`. Null when unavailable. */
    publicKey: z.string().nullable(),
    /** Browsers of the caller that currently receive pushes. */
    subscriptions: z.number().int().nonnegative(),
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

export const SendTestNotificationRequestSchema = z.object({ channel: NotificationChannel });
export type SendTestNotificationRequest = z.infer<typeof SendTestNotificationRequestSchema>;

export const SendTestNotificationResponseSchema = z.object({
  ok: z.boolean(),
  /** Why the test failed (no secret in it), e.g. `HTTP 404` or `not_configured`. */
  error: z.string().optional(),
});
export type SendTestNotificationResponse = z.infer<typeof SendTestNotificationResponseSchema>;

export const PushStatusSchema = z.object({ subscriptions: z.number().int().nonnegative() });
export type PushStatus = z.infer<typeof PushStatusSchema>;

const b64url = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/);

/** `PushSubscription.toJSON()` of the browser. */
export const PushSubscribeRequestSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: b64url, auth: b64url }),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequestSchema>;

export const PushUnsubscribeRequestSchema = z.object({ endpoint: z.string().min(1).max(2048) });
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequestSchema>;
