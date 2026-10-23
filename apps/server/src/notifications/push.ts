import { Agent as HttpsAgent } from 'node:https';
import webpush from 'web-push';
import type { Config } from '../config';
import { guardedLookup, validateWebhookUrl, WebhookUrlError } from './ssrf';

/**
 * Web Push. A subscription endpoint is a URL chosen by the browser, but it must belong to the
 * browser vendor's push service. Accepting only the known services (over https, no credentials, no
 * IP literal) keeps the server from being pointed at other hosts, on top of the SSRF guard that is
 * also applied to the connection.
 */
const PUSH_HOSTS: Array<{ suffix: string; exact?: boolean }> = [
  { suffix: 'fcm.googleapis.com', exact: true }, // Chrome, Edge, Opera, Brave, Samsung Internet
  { suffix: 'push.services.mozilla.com' }, // Firefox (updates.push.services.mozilla.com, ...)
  { suffix: 'notify.windows.com' }, // legacy Edge / WNS (*.notify.windows.com)
  { suffix: 'push.apple.com' }, // Safari (web.push.apple.com, ...)
];

/** The validated endpoint URL, or throws WebhookUrlError saying why it is refused. */
export function validatePushEndpoint(raw: string): URL {
  const u = validateWebhookUrl(raw); // https, no credentials, public host, no local names
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const known = PUSH_HOSTS.some((h) =>
    h.exact ? host === h.suffix : host === h.suffix || host.endsWith(`.${h.suffix}`),
  );
  if (!known) throw new WebhookUrlError('Not a known push service');
  return u;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the service worker receives: a title, a body and an app path to open. */
export interface PushPayload {
  title: string;
  body: string;
  /** App path (`/backlog?task=...`); null opens the app. Never an external URL. */
  url: string | null;
  tag: string;
}

/** A push attempt that failed; `status` is the push service's HTTP status when it answered. */
export class PushError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Sends one payload to one browser. Throws PushError. Tests replace it. */
export type PushSender = (target: PushTarget, payload: PushPayload) => Promise<void>;

/** The real sender, or null when the server has no VAPID keys. */
export function createPushSender(config: Config): PushSender | null {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: subject } = config;
  if (!pub || !priv || !subject) return null;
  const vapidDetails = { subject, publicKey: pub, privateKey: priv };
  return async (target, payload) => {
    try {
      validatePushEndpoint(target.endpoint);
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails,
          TTL: 24 * 3600,
          timeout: 10_000,
          // Dedicated agent with the SSRF-guarded lookup; never the global one (it may honour
          // HTTP(S)_PROXY, past the guard).
          agent: new HttpsAgent({ keepAlive: false, lookup: guardedLookup() }),
        },
      );
    } catch (err) {
      if (err instanceof WebhookUrlError) throw new PushError('refused_endpoint');
      const status = (err as { statusCode?: number }).statusCode;
      const code = (err as { code?: string }).code;
      if (status) throw new PushError(`HTTP ${status}`, status);
      throw new PushError(code ?? 'network_error');
    }
  };
}
