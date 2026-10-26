import type { NotificationChannel, NotificationEvent } from '@orch/shared';
import type { MessageKey } from '../i18n/index.ts';
import type { IconName } from './Icon';

/** Wording keys (translated at render), icon and signal lamp for each notification event. */
export const EVENT_META = {
  task_done: {
    label: 'notifications.event.task_done.label',
    description: 'notifications.event.task_done.description',
    icon: 'check',
    lamp: 'proceed',
  },
  task_failed: {
    label: 'notifications.event.task_failed.label',
    description: 'notifications.event.task_failed.description',
    icon: 'alert',
    lamp: 'stop',
  },
  task_needs_attention: {
    label: 'notifications.event.task_needs_attention.label',
    description: 'notifications.event.task_needs_attention.description',
    icon: 'alert',
    lamp: 'caution',
  },
  pr_review: {
    label: 'notifications.event.pr_review.label',
    description: 'notifications.event.pr_review.description',
    icon: 'pr',
    lamp: 'route',
  },
  consent_request: {
    label: 'notifications.event.consent_request.label',
    description: 'notifications.event.consent_request.description',
    icon: 'user',
    lamp: 'route',
  },
  access_request: {
    label: 'notifications.event.access_request.label',
    description: 'notifications.event.access_request.description',
    icon: 'user',
    lamp: 'caution',
  },
  participation_request: {
    label: 'notifications.event.participation_request.label',
    description: 'notifications.event.participation_request.description',
    icon: 'user',
    lamp: 'caution',
  },
} as const satisfies Record<
  NotificationEvent,
  {
    label: MessageKey;
    description: MessageKey;
    icon: IconName;
    lamp: 'proceed' | 'caution' | 'stop' | 'route';
  }
>;

/** Message keys of the channel names; translate at render. */
export const CHANNEL_LABEL = {
  in_app: 'notifications.channel.in_app',
  email: 'notifications.channel.email',
  slack: 'notifications.channel.slack',
  discord: 'notifications.channel.discord',
  webhook: 'notifications.channel.webhook',
  push: 'notifications.channel.push',
} as const satisfies Record<NotificationChannel, MessageKey>;
