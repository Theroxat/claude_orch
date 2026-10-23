import type { FastifyInstance } from 'fastify';
import type { Notification, NotificationSettings, Prisma } from '@prisma/client';
import {
  MarkNotificationsReadRequestSchema,
  NotificationEvent,
  ConfirmEmailRequestSchema,
  PushSubscribeRequestSchema,
  PushUnsubscribeRequestSchema,
  type PushStatus,
  SendTestNotificationRequestSchema,
  UpdateNotificationSettingsRequestSchema,
  type NotificationItem,
  type NotificationListResponse,
  type NotificationSettingsView,
  type SendTestNotificationResponse,
  type UnreadCountResponse,
} from '@orch/shared';
import { encrypt } from '../auth/crypto';
import { requireUser, type AuthDeps } from '../auth';
import { HttpError, parseBody } from '../http/errors';
import { confirmToken, issueToken, overLimit } from './emailVerification';
import { absoluteLink } from './format';
import {
  DeliveryError,
  TEST_DRAFT,
  channelTarget,
  effectivePreferences,
  type Notifier,
} from './service';
import { validatePushEndpoint } from './push';
import { WebhookUrlError, maskUrl, validateWebhookUrl } from './ssrf';

export { Notifier } from './service';

const MAX_PUSH_SUBSCRIPTIONS = 10;
const TEST_LIMIT = 5;
const TEST_WINDOW_MS = 60_000;

/** `new URL().href` form of an endpoint, so unsubscribe finds what subscribe stored. */
function normalizeEndpoint(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

function toItem(n: Notification): NotificationItem {
  const event = NotificationEvent.safeParse(n.event);
  return {
    id: n.id,
    event: event.success ? event.data : 'task_needs_attention',
    title: n.title,
    body: n.body,
    url: n.url,
    projectId: n.projectId,
    taskId: n.taskId,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt?.toISOString() ?? null,
  };
}

interface PushView {
  available: boolean;
  publicKey: string | null;
  subscriptions: number;
}

function toSettingsView(
  s: NotificationSettings | null,
  emailAvailable: boolean,
  push: PushView,
): NotificationSettingsView {
  const target = (enc: Uint8Array | null | undefined, hint: string | null | undefined) => ({
    configured: !!enc,
    hint: enc ? (hint ?? null) : null,
  });
  return {
    preferences: effectivePreferences(s?.preferences),
    slack: target(s?.slackUrlEnc, s?.slackHint),
    discord: target(s?.discordUrlEnc, s?.discordHint),
    webhook: target(s?.webhookUrlEnc, s?.webhookHint),
    email: {
      available: emailAvailable,
      address: s?.email ?? null,
      status: !s?.email ? 'none' : s.emailVerifiedAt ? 'verified' : 'pending',
    },
    push,
  };
}

export function registerNotifications(
  app: FastifyInstance,
  deps: AuthDeps & { notifier: Notifier },
): void {
  const { prisma, config, notifier } = deps;
  const unread = (userId: string) => prisma.notification.count({ where: { userId, readAt: null } });
  const pushView = async (userId: string): Promise<PushView> => ({
    available: !!notifier.pusher,
    publicKey: notifier.pusher ? (config.VAPID_PUBLIC_KEY ?? null) : null,
    subscriptions: await prisma.pushSubscription.count({ where: { userId } }),
  });
  const testSends = new Map<string, number[]>();

  app.get('/api/notifications', async (req): Promise<NotificationListResponse> => {
    const user = requireUser(req);
    const raw = Number((req.query as { limit?: string }).limit ?? 30);
    const limit = Number.isInteger(raw) ? Math.min(100, Math.max(1, raw)) : 30;
    const [rows, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: user.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
      unread(user.id),
    ]);
    return { items: rows.map(toItem), unreadCount };
  });

  app.get('/api/notifications/unread-count', async (req): Promise<UnreadCountResponse> => {
    const user = requireUser(req);
    return { unreadCount: await unread(user.id) };
  });

  app.post('/api/notifications/read', async (req): Promise<UnreadCountResponse> => {
    const user = requireUser(req);
    const body = parseBody(MarkNotificationsReadRequestSchema, req.body);
    await prisma.notification.updateMany({
      where: { userId: user.id, readAt: null, ...('ids' in body ? { id: { in: body.ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { unreadCount: await unread(user.id) };
  });

  app.get('/api/notifications/settings', async (req): Promise<NotificationSettingsView> => {
    const user = requireUser(req);
    const s = await prisma.notificationSettings.findUnique({ where: { userId: user.id } });
    return toSettingsView(s, !!notifier.mailer, await pushView(user.id));
  });

  app.put('/api/notifications/settings', async (req): Promise<NotificationSettingsView> => {
    const user = requireUser(req);
    const body = parseBody(UpdateNotificationSettingsRequestSchema, req.body);
    const data: Prisma.NotificationSettingsUncheckedUpdateInput = {};
    const targets = [
      ['slackWebhookUrl', 'slackUrlEnc', 'slackHint'],
      ['discordWebhookUrl', 'discordUrlEnc', 'discordHint'],
      ['webhookUrl', 'webhookUrlEnc', 'webhookHint'],
    ] as const;
    for (const [field, encCol, hintCol] of targets) {
      const v = body[field];
      if (v === undefined) continue;
      if (v === null || v === '') {
        data[encCol] = null;
        data[hintCol] = null;
        continue;
      }
      let u: URL;
      try {
        u = validateWebhookUrl(v);
      } catch (err) {
        if (err instanceof WebhookUrlError) {
          throw new HttpError(400, 'invalid_webhook_url', `${field}: ${err.message}`);
        }
        throw err;
      }
      if (!config.ORCH_ENCRYPTION_KEY) {
        throw new HttpError(
          400,
          'encryption_not_configured',
          'ORCH_ENCRYPTION_KEY is not set: webhook URLs cannot be stored',
        );
      }
      data[encCol] = encrypt(u.href, config.ORCH_ENCRYPTION_KEY);
      data[hintCol] = maskUrl(u);
    }
    let confirmEmail = false;
    if (body.email !== undefined) {
      const next = body.email || null;
      const cur = await prisma.notificationSettings.findUnique({ where: { userId: user.id } });
      if (next?.toLowerCase() !== cur?.email?.toLowerCase()) {
        // A new address starts unverified, whatever was confirmed before.
        data.email = next;
        data.emailVerifiedAt = null;
        data.emailTokenHash = null;
        data.emailTokenExpiresAt = null;
        confirmEmail = !!next && !!notifier.mailer;
      }
    }
    if (body.preferences) data.preferences = effectivePreferences(body.preferences);
    const s = await prisma.notificationSettings.upsert({
      where: { userId: user.id },
      create: { ...(data as Prisma.NotificationSettingsUncheckedCreateInput), userId: user.id },
      update: data,
    });
    if (confirmEmail) await sendConfirmation(user.id);
    return toSettingsView(
      confirmEmail
        ? await prisma.notificationSettings.findUnique({ where: { userId: user.id } })
        : s,
      !!notifier.mailer,
      await pushView(user.id),
    );
  });

  /** Issues a fresh token and mails it; silently does nothing past the rate limits. */
  async function sendConfirmation(userId: string): Promise<void> {
    const issued = await issueToken(prisma, userId);
    if (issued.ok) await notifier.sendConfirmation(issued.email, issued.token);
  }

  /** Same answer whether or not a mail was sent: the response reveals nothing about addresses. */
  app.post('/api/notifications/email/resend', async (req): Promise<{ ok: true }> => {
    const user = requireUser(req);
    const s = await prisma.notificationSettings.findUnique({ where: { userId: user.id } });
    if (overLimit(s?.emailSendLog ?? [], new Date())) {
      throw new HttpError(429, 'rate_limited', 'Too many confirmation e-mails, try again later');
    }
    if (notifier.mailer) await sendConfirmation(user.id);
    return { ok: true };
  });

  app.post('/api/notifications/email/confirm', async (req): Promise<NotificationSettingsView> => {
    const user = requireUser(req);
    const { token } = parseBody(ConfirmEmailRequestSchema, req.body);
    if (!(await confirmToken(prisma, user.id, token))) {
      throw new HttpError(400, 'invalid_token', 'This link is invalid or has expired');
    }
    const s = await prisma.notificationSettings.findUnique({ where: { userId: user.id } });
    return toSettingsView(s, !!notifier.mailer, await pushView(user.id));
  });

  app.post('/api/notifications/push/subscribe', async (req): Promise<PushStatus> => {
    const user = requireUser(req);
    if (!notifier.pusher) {
      throw new HttpError(400, 'push_not_configured', 'This server has no VAPID keys set');
    }
    const body = parseBody(PushSubscribeRequestSchema, req.body);
    let endpoint: string;
    try {
      endpoint = validatePushEndpoint(body.endpoint).href;
    } catch (err) {
      if (err instanceof WebhookUrlError) {
        throw new HttpError(400, 'invalid_push_endpoint', `endpoint: ${err.message}`);
      }
      throw err;
    }
    const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 200) || null;
    // A browser has one endpoint: if another member used it before, it now belongs to the caller.
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: user.id, endpoint, ...body.keys, userAgent },
      update: { userId: user.id, ...body.keys, userAgent },
    });
    const all = await prisma.pushSubscription.findMany({
      where: { userId: user.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    const extra = all.slice(MAX_PUSH_SUBSCRIPTIONS).map((r) => r.id);
    if (extra.length > 0)
      await prisma.pushSubscription.deleteMany({ where: { id: { in: extra } } });
    return { subscriptions: Math.min(all.length, MAX_PUSH_SUBSCRIPTIONS) };
  });

  app.post('/api/notifications/push/unsubscribe', async (req): Promise<PushStatus> => {
    const user = requireUser(req);
    const body = parseBody(PushUnsubscribeRequestSchema, req.body);
    await prisma.pushSubscription.deleteMany({
      where: {
        userId: user.id,
        endpoint: { in: [body.endpoint, normalizeEndpoint(body.endpoint)] },
      },
    });
    return { subscriptions: await prisma.pushSubscription.count({ where: { userId: user.id } }) };
  });

  /** One immediate attempt on one channel, so the member sees at once whether it works. */
  app.post('/api/notifications/test', async (req): Promise<SendTestNotificationResponse> => {
    const user = requireUser(req);
    const { channel } = parseBody(SendTestNotificationRequestSchema, req.body);
    const now = Date.now();
    const recent = (testSends.get(user.id) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
    if (recent.length >= TEST_LIMIT) {
      throw new HttpError(429, 'rate_limited', 'Too many test notifications, wait a minute');
    }
    testSends.set(user.id, [...recent, now]);

    const testPush = async (userId: string): Promise<SendTestNotificationResponse> => {
      if (!notifier.pusher) return { ok: false, error: 'push_not_configured' };
      const subs = await prisma.pushSubscription.findMany({ where: { userId } });
      if (subs.length === 0) return { ok: false, error: 'not_configured' };
      let failure = 'delivery_failed';
      let delivered = 0;
      for (const sub of subs) {
        try {
          await notifier.send('push', sub.endpoint, {
            ...TEST_DRAFT,
            id: 'test',
            link: absoluteLink(config.ORCH_BASE_URL, TEST_DRAFT.url),
            createdAt: new Date(),
          });
          delivered++;
        } catch (err) {
          if (err instanceof DeliveryError) failure = err.message;
        }
      }
      return delivered > 0 ? { ok: true } : { ok: false, error: failure };
    };

    if (channel === 'in_app') {
      await prisma.notification.create({ data: { userId: user.id, ...TEST_DRAFT } });
      return { ok: true };
    }
    if (channel === 'push') return testPush(user.id);
    const s = await prisma.notificationSettings.findUnique({ where: { userId: user.id } });
    if (channel === 'email' && !notifier.mailer) return { ok: false, error: 'smtp_not_configured' };
    if (channel === 'email' && s?.email && !s.emailVerifiedAt) {
      return { ok: false, error: 'email_not_verified' };
    }
    const target = channelTarget(s, channel, config, !!notifier.mailer);
    if (!target) return { ok: false, error: 'not_configured' };
    try {
      await notifier.send(channel, target, {
        ...TEST_DRAFT,
        id: 'test',
        link: absoluteLink(config.ORCH_BASE_URL, TEST_DRAFT.url),
        createdAt: new Date(),
      });
      return { ok: true };
    } catch (err) {
      const error = err instanceof DeliveryError ? err.message : 'delivery_failed';
      req.log.info({ channel, error }, 'test notification failed');
      return { ok: false, error };
    }
  });
}
