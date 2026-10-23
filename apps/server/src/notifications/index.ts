import type { FastifyInstance } from 'fastify';
import type { Notification, NotificationSettings, Prisma } from '@prisma/client';
import {
  MarkNotificationsReadRequestSchema,
  NotificationEvent,
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
import { absoluteLink } from './format';
import {
  DeliveryError,
  TEST_DRAFT,
  channelTarget,
  effectivePreferences,
  type Notifier,
} from './service';
import { WebhookUrlError, maskUrl, validateWebhookUrl } from './ssrf';

export { Notifier } from './service';

const TEST_LIMIT = 5;
const TEST_WINDOW_MS = 60_000;

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

function toSettingsView(
  s: NotificationSettings | null,
  emailAvailable: boolean,
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
    email: { available: emailAvailable, address: s?.email ?? null },
  };
}

export function registerNotifications(
  app: FastifyInstance,
  deps: AuthDeps & { notifier: Notifier },
): void {
  const { prisma, config, notifier } = deps;
  const unread = (userId: string) => prisma.notification.count({ where: { userId, readAt: null } });
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
    return toSettingsView(s, !!notifier.mailer);
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
    if (body.email !== undefined) data.email = body.email || null;
    if (body.preferences) data.preferences = effectivePreferences(body.preferences);
    const s = await prisma.notificationSettings.upsert({
      where: { userId: user.id },
      create: { ...(data as Prisma.NotificationSettingsUncheckedCreateInput), userId: user.id },
      update: data,
    });
    return toSettingsView(s, !!notifier.mailer);
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

    if (channel === 'in_app') {
      await prisma.notification.create({ data: { userId: user.id, ...TEST_DRAFT } });
      return { ok: true };
    }
    const s = await prisma.notificationSettings.findUnique({ where: { userId: user.id } });
    if (channel === 'email' && !notifier.mailer) return { ok: false, error: 'smtp_not_configured' };
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
