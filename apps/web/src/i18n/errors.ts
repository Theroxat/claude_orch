import { ApiError } from '../api/client';
import { getLocale, t, type MessageKey } from './index.ts';

/**
 * API error codes with one stable meaning, translated in every locale. The server's own message
 * is English and sometimes more specific, so codes that cover many cases (`not_found`,
 * `forbidden`, ...) keep it in English and get a generic translation in other locales.
 */
const SPECIFIC = {
  access_suspended: 'errors.api.access_suspended',
  agent_offline: 'errors.api.agent_offline',
  already_added: 'errors.api.already_added',
  already_taken: 'errors.api.already_taken',
  cannot_reject_owner: 'errors.api.cannot_reject_owner',
  concurrency: 'errors.api.concurrency',
  csrf: 'errors.api.csrf',
  dependency_cycle: 'errors.api.dependency_cycle',
  dispatcher_unavailable: 'errors.api.dispatcher_unavailable',
  github_not_configured: 'errors.api.github_not_configured',
  no_agent_online: 'errors.api.no_agent_online',
  not_participating: 'errors.api.not_participating',
  not_retryable: 'errors.api.not_retryable',
  offer_closed: 'errors.api.offer_closed',
  paused: 'errors.api.paused',
  push_not_configured: 'errors.api.push_not_configured',
  server_version_unknown: 'errors.api.server_version_unknown',
  task_cancelled: 'errors.api.task_cancelled',
  task_locked: 'errors.api.task_locked',
  template_readonly: 'errors.api.template_readonly',
  too_many_streams: 'errors.api.too_many_streams',
  up_to_date: 'errors.api.up_to_date',
  update_unsupported: 'errors.api.update_unsupported',
  webhook_not_configured: 'errors.api.webhook_not_configured',
} as const satisfies Record<string, MessageKey>;

const GENERIC = {
  forbidden: 'errors.generic.forbidden',
  not_found: 'errors.generic.not_found',
  unauthorized: 'errors.generic.unauthorized',
  invalid_request: 'errors.generic.invalid_request',
  github_error: 'errors.generic.github_error',
  rate_limited: 'errors.generic.rate_limited',
  internal: 'errors.generic.internal',
  invalid_token: 'errors.generic.invalid_token',
  invalid_webhook_url: 'errors.generic.invalid_webhook_url',
  reauth_required: 'errors.generic.reauth_required',
  template_not_found: 'errors.generic.template_not_found',
} as const satisfies Record<string, MessageKey>;

const has = <T extends object>(o: T, k: string): k is Extract<keyof T, string> =>
  Object.prototype.hasOwnProperty.call(o, k);

/** What to show for a failed request or action, in the active locale. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (has(SPECIFIC, e.code)) return t(SPECIFIC[e.code]);
    if (getLocale() === 'en') return e.message;
    if (has(GENERIC, e.code)) return t(GENERIC[e.code]);
    return t('errors.requestFailed', { status: e.status });
  }
  // fetch() rejects with a TypeError when the server cannot be reached.
  if (e instanceof TypeError) return t('errors.network');
  if (e instanceof Error && e.message && getLocale() === 'en') return e.message;
  return t('errors.unknown');
}
