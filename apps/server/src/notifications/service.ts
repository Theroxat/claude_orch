import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_EVENTS,
  NotificationChannel,
  type NotificationEvent,
  type NotificationPreferences,
} from '@orch/shared';
import type { NotificationSettings, Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { createTransport } from 'nodemailer';
import { onAudit, type AuditEntry } from '../audit';
import type { Cluster } from '../cluster';
import { decrypt } from '../auth/crypto';
import type { Config } from '../config';
import type { Metrics } from '../observability';
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
  /** Several instances: the retention purge runs on the maintenance leader only. */
  cluster?: Cluster;
  metrics?: Metrics;
}

/** Jobs claimed per round; a full batch is followed by another round at once. */
const CLAIM_BATCH = 20;
/** A SENDING job is claimed again once this lock expires (its instance died mid-send). */
const SEND_LOCK_SEC = 120;
/**
 * Jobs are delivered by the instance that queued them; another instance takes a job over only
 * once it has been due for this long (the owner is gone or stuck).
 */
const TAKEOVER_GRACE_SEC = 60;
/** Failed deliveries are kept this long for inspection, then deleted. */
const FAILED_JOB_RETENTION_MS = 7 * 86_400_000;

interface ClaimedJob {
  id: string;
  userId: string;
  channel: string;
  endpoint: string | null;
  payload: Prisma.JsonValue;
  attempts: number;
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
 * (Slack, Discord, generic webhook, e-mail, push) according to each recipient's preferences.
 *
 * Nothing here runs on the request path: the audit listener only queues work, and failures are
 * logged, never thrown. External deliveries are durable `NotificationJob` rows: the instance that
 * queued them sends them at once; retries (exponential backoff), jobs left by a restart and jobs
 * of an instance that died are picked up by the queue worker of any instance, each job by exactly
 * one worker at a time (`FOR UPDATE SKIP LOCKED`). Delivery is at least once: a process killed
 * between the send and the bookkeeping sends that one again.
 */
export class Notifier {
  private readonly post: WebhookPoster;
  readonly mailer: Mailer | null;
  /** Null when the server has no VAPID keys: the browser channel is unavailable. */
  readonly pusher: PushSender | null;
  private readonly inflight = new Set<Promise<unknown>>();
  private purgeTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private readonly instanceId: string;

  constructor(private readonly deps: NotifierDeps) {
    this.post = deps.post ?? safePost;
    this.mailer = deps.mailer === undefined ? createMailer(deps.config) : deps.mailer;
    this.pusher = deps.pusher === undefined ? createPushSender(deps.config) : deps.pusher;
    this.instanceId = deps.config.ORCH_INSTANCE_ID;
  }

  start(): void {
    this.closed = false;
    this.unsubscribe = onAudit(this.deps.prisma, (e) => this.onAudit(e));
    this.purgeTimer = setInterval(() => {
      if (this.deps.cluster && !this.deps.cluster.leads('maintenance')) return;
      this.purge().catch((err) => this.deps.log.warn({ err }, 'notification purge failed'));
    }, this.deps.config.RETENTION_PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
    this.wake(); // jobs left by a previous run
  }

  /** Stops listening and polling (in-flight attempts finish; queued jobs stay in the database). */
  stop(): void {
    this.closed = true;
    this.unsubscribe?.();
    clearInterval(this.purgeTimer);
    clearTimeout(this.pollTimer);
  }

  /**
   * Resolves once the work queued by this instance is done: audit events planned, and every job it
   * queued delivered or given up (retries included). For tests and shutdown.
   */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([...this.inflight]);
      await this.draining;
      if (this.inflight.size > 0 || this.draining) continue;
      if (this.closed) return;
      const open = await this.deps.prisma.notificationJob.count({
        where: { instanceId: this.instanceId, status: { in: ['PENDING', 'SENDING'] } },
      });
      if (open === 0 && this.inflight.size === 0) return;
      await new Promise((r) => setTimeout(r, 5));
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
  async notify(userId: string, draft: NotificationDraft): Promise<void> {
    const { prisma, config } = this.deps;
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
    const jobs: Prisma.NotificationJobCreateManyInput[] = [];
    const payload = out as unknown as Prisma.InputJsonValue;
    const job = (channel: ExternalChannel, endpoint: string | null) =>
      jobs.push({ userId, channel, endpoint, payload, instanceId: this.instanceId });
    for (const channel of channels) {
      if (channel === 'in_app') continue;
      if (channel === 'push') {
        if (!this.pusher) continue;
        const subs = await prisma.pushSubscription.findMany({
          where: { userId },
          select: { endpoint: true },
        });
        for (const sub of subs) job('push', sub.endpoint);
        continue;
      }
      // Checked now (no job for an unset channel), read again at send time (never stored).
      if (!channelTarget(settings, channel, config, !!this.mailer)) continue;
      job(channel, null);
    }
    if (jobs.length === 0 || this.closed) return;
    await prisma.notificationJob.createMany({ data: jobs });
    this.wake();
  }

  /** Runs a queue round now (or right after the current one). */
  private wake(): void {
    if (this.closed) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    clearTimeout(this.pollTimer);
    this.draining = this.drain()
      .catch((err) => this.deps.log.warn({ err }, 'notification queue round failed'))
      .finally(() => {
        this.draining = null;
        if (this.drainAgain) {
          this.drainAgain = false;
          this.wake();
        } else {
          void this.schedulePoll();
        }
      });
  }

  /** Next round: this instance's next retry, or the poll period (other instances' leftovers). */
  private async schedulePoll(): Promise<void> {
    if (this.closed) return;
    let delay = this.deps.config.NOTIFY_QUEUE_POLL_MS;
    try {
      const next = await this.deps.prisma.notificationJob.findFirst({
        where: { instanceId: this.instanceId, status: 'PENDING' },
        orderBy: { nextAttemptAt: 'asc' },
        select: { nextAttemptAt: true },
      });
      if (next) delay = Math.min(delay, Math.max(0, next.nextAttemptAt.getTime() - Date.now()));
    } catch (err) {
      this.deps.log.warn({ err }, 'notification queue poll failed');
    }
    if (this.closed || this.draining) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.wake(), delay);
    this.pollTimer.unref();
  }

  /** Claims due jobs (batch after batch) and delivers them. */
  private async drain(): Promise<void> {
    while (!this.closed) {
      const jobs = await this.claim();
      if (jobs.length === 0) return;
      const round = Promise.allSettled(jobs.map((j) => this.deliver(j)));
      this.track(round);
      await round;
      if (jobs.length < CLAIM_BATCH) return;
    }
  }

  private claim(): Promise<ClaimedJob[]> {
    return this.deps.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE "NotificationJob" SET status = 'SENDING', attempts = attempts + 1,
             "lockedUntil" = now() + make_interval(secs => ${SEND_LOCK_SEC}),
             "instanceId" = ${this.instanceId}, "updatedAt" = now()
       WHERE id IN (
         SELECT id FROM "NotificationJob"
          WHERE ((status = 'PENDING' AND "nextAttemptAt" <= now())
                 OR (status = 'SENDING' AND "lockedUntil" < now()))
            AND ("instanceId" = ${this.instanceId}
                 OR "nextAttemptAt" <= now() - make_interval(secs => ${TAKEOVER_GRACE_SEC}))
          ORDER BY "nextAttemptAt"
          LIMIT ${CLAIM_BATCH}
          FOR UPDATE SKIP LOCKED)
      RETURNING id, "userId", channel, endpoint, payload, attempts`;
  }

  /** One attempt of a claimed job, then its bookkeeping (deleted, retried later, or failed). */
  private async deliver(job: ClaimedJob): Promise<void> {
    const { prisma, config, log, metrics } = this.deps;
    const raw = job.payload as unknown as OutgoingNotification & { createdAt: string };
    const n: OutgoingNotification = { ...raw, createdAt: new Date(raw.createdAt) };
    const channel = job.channel as ExternalChannel;
    try {
      let target = job.endpoint;
      if (channel !== 'push') {
        const s = await prisma.notificationSettings.findUnique({ where: { userId: job.userId } });
        target = channelTarget(s, channel, config, !!this.mailer);
      }
      if (!target) throw new DeliveryError('not_configured', false); // removed meanwhile
      await this.send(channel, target, n);
      await prisma.notificationJob.delete({ where: { id: job.id } });
      metrics?.notificationJobs.inc({ channel, result: 'sent' });
    } catch (err) {
      const retryable = !(err instanceof DeliveryError) || err.retryable;
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const ctx = { userId: job.userId, channel, event: n.event, attempt: job.attempts, reason };
      if (retryable && job.attempts < config.NOTIFY_MAX_ATTEMPTS) {
        const next = config.NOTIFY_RETRY_BASE_MS * 4 ** (job.attempts - 1);
        log.info({ ...ctx, retryInMs: next }, 'notification delivery failed, retrying');
        await prisma.notificationJob.update({
          where: { id: job.id },
          data: {
            status: 'PENDING',
            nextAttemptAt: new Date(Date.now() + next),
            lockedUntil: null,
            lastError: reason,
          },
        });
        metrics?.notificationJobs.inc({ channel, result: 'retry' });
      } else {
        // Never log the target: webhook URLs are secrets.
        log.warn(ctx, 'notification delivery failed');
        await prisma.notificationJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', lockedUntil: null, lastError: reason },
        });
        metrics?.notificationJobs.inc({ channel, result: 'failed' });
      }
    }
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

  /** Deletes in-app notifications past the retention period (and old failed deliveries). */
  async purge(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.deps.config.NOTIFY_RETENTION_DAYS * 86_400_000);
    const r = await this.deps.prisma.notification.deleteMany({
      where: { createdAt: { lt: before } },
    });
    await this.deps.prisma.notificationJob.deleteMany({
      where: {
        status: 'FAILED',
        updatedAt: { lt: new Date(now.getTime() - FAILED_JOB_RETENTION_MS) },
      },
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
