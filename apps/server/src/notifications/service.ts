import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_EVENTS,
  NotificationChannel,
  redactSecrets,
  type NotificationEvent,
  type NotificationPreferences,
} from '@orch/shared';
import type { NotificationSettings } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { createTransport } from 'nodemailer';
import { onAudit, type AuditEntry } from '../audit';
import { decrypt } from '../auth/crypto';
import type { Config } from '../config';
import type { PrismaClient } from '../db';
import type { RecipientCheck } from './access';
import { confirmationMessage } from './emailVerification';
import { planNotifications, type NotificationDraft } from './events';
import {
  absoluteLink,
  discordPayload,
  emailMessage,
  genericPayload,
  slackPayload,
  type OutgoingNotification,
} from './format';
import { PushError, createPushSender, type PushPayload, type PushSender } from './push';
import { safePost, type WebhookPoster } from './ssrf';

export type ExternalChannel = Exclude<NotificationChannel, 'in_app'>;

/** The subset of a nodemailer transport the notifier uses; tests pass a fake. */
export interface Mailer {
  sendMail(m: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface NotifierDeps {
  prisma: PrismaClient;
  config: Config;
  log: FastifyBaseLogger;
  /** HTTP client for webhooks (default: SSRF-guarded https POST). */
  post?: WebhookPoster;
  /** E-mail transport (default: nodemailer from SMTP_*, or none). */
  mailer?: Mailer | null;
  /** Web Push sender (default: web-push from VAPID_*, or none). */
  pusher?: PushSender | null;
  /** Drops recipients who lost access to orch or to the project (default: everyone receives). */
  canReceive?: RecipientCheck;
}

/** A delivery that failed; `retryable` false stops the retries (e.g. HTTP 404: the hook is gone). */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function createMailer(config: Config): Mailer | null {
  if (!config.SMTP_HOST) return null;
  return createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    ...(config.SMTP_USER
      ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? '' } }
      : {}),
  });
}

export function smtpFrom(config: Config): string {
  return config.SMTP_FROM ?? `orch <orch@${new URL(config.ORCH_BASE_URL).hostname}>`;
}

/** Stored preferences merged over the defaults; unknown events and channels are dropped. */
export function effectivePreferences(stored: unknown): NotificationPreferences {
  const out: NotificationPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  if (!stored || typeof stored !== 'object') return out;
  const s = stored as Record<string, unknown>;
  for (const e of NOTIFICATION_EVENTS) {
    const v = s[e];
    if (!Array.isArray(v)) continue;
    out[e] = [
      ...new Set(v.filter((c) => NotificationChannel.safeParse(c).success)),
    ] as NotificationChannel[];
  }
  return out;
}

/** The decrypted target of an external channel, or null when it is not set up. */
export function channelTarget(
  s: NotificationSettings | null,
  channel: ExternalChannel,
  config: Config,
  hasMailer: boolean,
): string | null {
  if (!s) return null;
  // Never to an address the member has not confirmed (SMTP would otherwise mail anyone).
  if (channel === 'email') return hasMailer && s.emailVerifiedAt ? s.email : null;
  if (channel === 'push') return null; // targets are the member's browsers, see PushSubscription
  const enc =
    channel === 'slack' ? s.slackUrlEnc : channel === 'discord' ? s.discordUrlEnc : s.webhookUrlEnc;
  if (!enc || !config.ORCH_ENCRYPTION_KEY) return null;
  try {
    return decrypt(enc, config.ORCH_ENCRYPTION_KEY);
  } catch {
    return null; // key rotated: the member sets the target again
  }
}

const RETRYABLE_STATUS = (status: number) => status === 408 || status === 429 || status >= 500;

/**
 * Turns audit events into notifications: an in-app row per recipient, and external deliveries
 * (Slack, Discord, generic webhook, e-mail) according to each recipient's preferences.
 *
 * Nothing here runs on the request path: the audit listener only queues work, deliveries are
 * retried with exponential backoff in the background, and failures are logged, never thrown.
 */
export class Notifier {
  private readonly post: WebhookPoster;
  readonly mailer: Mailer | null;
  /** Null when the server has no VAPID keys: the browser channel is unavailable. */
  readonly pusher: PushSender | null;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private purgeTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;

  constructor(private readonly deps: NotifierDeps) {
    this.post = deps.post ?? safePost;
    this.mailer = deps.mailer === undefined ? createMailer(deps.config) : deps.mailer;
    this.pusher = deps.pusher === undefined ? createPushSender(deps.config) : deps.pusher;
  }

  start(): void {
    this.closed = false;
    this.unsubscribe = onAudit(this.deps.prisma, (e) => this.onAudit(e));
    this.purgeTimer = setInterval(() => {
      this.purge().catch((err) => this.deps.log.warn({ err }, 'notification purge failed'));
    }, this.deps.config.RETENTION_PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  /** Stops listening and drops pending retries (in-flight attempts finish). */
  stop(): void {
    this.closed = true;
    this.unsubscribe?.();
    clearInterval(this.purgeTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Resolves once queued work (and scheduled retries) are done. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0 || this.timers.size > 0) {
      await Promise.allSettled([...this.inflight]);
      if (this.inflight.size === 0 && this.timers.size > 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.catch((err) => this.deps.log.warn({ err }, 'notification failed'));
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
  }

  onAudit(e: AuditEntry): void {
    if (this.closed) return;
    this.track(
      // Next macrotask: the audited request finishes first.
      new Promise((r) => setImmediate(r)).then(() => this.dispatch(e)),
    );
  }

  async dispatch(e: AuditEntry): Promise<void> {
    const plans = await planNotifications(this.deps.prisma, this.deps.config, e);
    for (const { draft, userIds } of plans) {
      for (const userId of userIds) await this.notify(userId, draft);
    }
  }

  /** One notification for one user, on the channels their preferences select. */
  async notify(userId: string, input: NotificationDraft): Promise<void> {
    const { prisma, config } = this.deps;
    // Titles and bodies quote task titles and run errors: secret formats are masked once here,
    // for every channel (in-app, webhooks, e-mail, push).
    const draft = { ...input, title: redactSecrets(input.title), body: redactSecrets(input.body) };
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    const channels = effectivePreferences(settings?.preferences)[draft.event];
    if (channels.length === 0) return;
    // Recipients come from stored ids (creator, owner, runner): check they may still see this.
    if (this.deps.canReceive && !(await this.deps.canReceive(userId, draft.projectId))) return;
    let id: string | null = null;
    let createdAt = new Date();
    if (channels.includes('in_app')) {
      const row = await prisma.notification.create({ data: { userId, ...draft } });
      id = row.id;
      createdAt = row.createdAt;
    }
    const out: OutgoingNotification = {
      ...draft,
      id: id ?? `ntf_${createdAt.getTime().toString(36)}`,
      link: absoluteLink(config.ORCH_BASE_URL, draft.url),
      createdAt,
    };
    for (const channel of channels) {
      if (channel === 'in_app') continue;
      if (channel === 'push') {
        if (!this.pusher) continue;
        const subs = await prisma.pushSubscription.findMany({
          where: { userId },
          select: { endpoint: true },
        });
        for (const sub of subs) this.schedule(userId, 'push', sub.endpoint, out, 1, 0);
        continue;
      }
      const target = channelTarget(settings, channel, config, !!this.mailer);
      if (!target) continue;
      this.schedule(userId, channel, target, out, 1, 0);
    }
  }

  private schedule(
    userId: string,
    channel: ExternalChannel,
    target: string,
    n: OutgoingNotification,
    attempt: number,
    delayMs: number,
  ): void {
    if (this.closed) return;
    const run = () =>
      this.send(channel, target, n).catch((err: unknown) => {
        const retryable = !(err instanceof DeliveryError) || err.retryable;
        const reason = err instanceof Error ? err.message : String(err);
        const ctx = { userId, channel, event: n.event, attempt, reason };
        if (retryable && attempt < this.deps.config.NOTIFY_MAX_ATTEMPTS) {
          const next = this.deps.config.NOTIFY_RETRY_BASE_MS * 4 ** (attempt - 1);
          this.deps.log.info({ ...ctx, retryInMs: next }, 'notification delivery failed, retrying');
          this.schedule(userId, channel, target, n, attempt + 1, next);
        } else {
          // Never log the target: webhook URLs are secrets.
          this.deps.log.warn(ctx, 'notification delivery failed');
        }
      });
    if (delayMs <= 0) {
      this.track(run());
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.track(run());
    }, delayMs);
    t.unref();
    this.timers.add(t);
  }

  /** One delivery attempt. Throws DeliveryError on failure. */
  async send(channel: ExternalChannel, target: string, n: OutgoingNotification): Promise<void> {
    if (channel === 'email') {
      if (!this.mailer) throw new DeliveryError('smtp_not_configured', false);
      const m = emailMessage(n, this.deps.config.ORCH_BASE_URL);
      try {
        await this.mailer.sendMail({ from: smtpFrom(this.deps.config), to: target, ...m });
      } catch (err) {
        const code = (err as { responseCode?: number }).responseCode;
        // 5xx SMTP replies are permanent (bad address, refused); anything else may pass later.
        throw new DeliveryError(code ? `SMTP ${code}` : 'smtp_error', !(code && code >= 500));
      }
      return;
    }
    if (channel === 'push') return this.sendPush(target, n);
    const body =
      channel === 'slack'
        ? slackPayload(n)
        : channel === 'discord'
          ? discordPayload(n)
          : genericPayload(n);
    let res;
    try {
      res = await this.post(target, body);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ESSRF') throw new DeliveryError('refused_private_address', false);
      throw new DeliveryError(code ?? (err instanceof Error ? err.message : 'network_error'), true);
    }
    if (!res.ok) throw new DeliveryError(`HTTP ${res.status}`, RETRYABLE_STATUS(res.status));
  }

  /** The confirmation e-mail (the only mail that may go to an unverified address). Never throws. */
  async sendConfirmation(to: string, token: string): Promise<boolean> {
    if (!this.mailer) return false;
    const link = absoluteLink(this.deps.config.ORCH_BASE_URL, `/confirm-email?token=${token}`);
    try {
      await this.mailer.sendMail({
        from: smtpFrom(this.deps.config),
        to,
        ...confirmationMessage(link ?? ''),
      });
      return true;
    } catch (err) {
      this.deps.log.warn({ err }, 'confirmation e-mail failed');
      return false;
    }
  }

  /** One browser. `endpoint` identifies the subscription; a 404/410 means it is gone for good. */
  private async sendPush(endpoint: string, n: OutgoingNotification): Promise<void> {
    if (!this.pusher) throw new DeliveryError('push_not_configured', false);
    const { prisma } = this.deps;
    const sub = await prisma.pushSubscription.findUnique({ where: { endpoint } });
    if (!sub) throw new DeliveryError('subscription_gone', false); // unsubscribed meanwhile
    try {
      await this.pusher(sub, pushPayload(n));
    } catch (err) {
      const status = err instanceof PushError ? err.status : undefined;
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.deleteMany({ where: { endpoint } });
        throw new DeliveryError(`HTTP ${status}: subscription expired`, false);
      }
      const reason = err instanceof Error ? err.message : 'push_error';
      // 4xx other than 408/429 (bad VAPID, payload too large) will not pass on a retry.
      throw new DeliveryError(reason, status === undefined || RETRYABLE_STATUS(status));
    }
    await prisma.pushSubscription
      .updateMany({ where: { endpoint }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }

  /** Deletes in-app notifications past the retention period. */
  async purge(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.deps.config.NOTIFY_RETENTION_DAYS * 86_400_000);
    const r = await this.deps.prisma.notification.deleteMany({
      where: { createdAt: { lt: before } },
    });
    return r.count;
  }
}

/** What a browser shows: short text and an app path, never an external link. */
export function pushPayload(n: OutgoingNotification): PushPayload {
  const url = isAppPath(n.url) ? n.url : n.taskId ? `/backlog?task=${n.taskId}` : null;
  return {
    title: n.title.slice(0, 120),
    body: n.body.slice(0, 200),
    url,
    tag: n.id,
  };
}

export const TEST_DRAFT: NotificationDraft = {
  event: 'task_done' satisfies NotificationEvent,
  title: 'Test notification from orch',
  body: 'If you can read this, notifications reach you on this channel.',
  url: '/my-server#notifications',
  projectId: null,
  taskId: null,
};

/** A short in-app path: `//host` and `/\host` are protocol-relative URLs, not paths. */
function isAppPath(url: string | null | undefined): url is string {
  return !!url && url.length <= 512 && /^\/(?![/\\])/.test(url);
}
