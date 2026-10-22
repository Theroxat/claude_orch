import type { NotificationChannel, NotificationEvent } from '@orch/shared';
import type { IconName } from './Icon';

/** Human wording, icon and signal lamp for each notification event. */
export const EVENT_META: Record<
  NotificationEvent,
  {
    label: string;
    description: string;
    icon: IconName;
    lamp: 'proceed' | 'caution' | 'stop' | 'route';
  }
> = {
  task_done: {
    label: 'Task done',
    description: 'The pull request of a task was merged.',
    icon: 'check',
    lamp: 'proceed',
  },
  task_failed: {
    label: 'Task failed',
    description: 'A run failed or was lost.',
    icon: 'alert',
    lamp: 'stop',
  },
  task_needs_attention: {
    label: 'Needs attention',
    description: 'A task stopped starting, or your Claude login is no longer valid.',
    icon: 'alert',
    lamp: 'caution',
  },
  pr_review: {
    label: 'Pull request to review',
    description: 'A pull request was opened for a task and waits for review.',
    icon: 'pr',
    lamp: 'route',
  },
  consent_request: {
    label: 'Task offered to you',
    description: 'A task waits for your approval on your machines.',
    icon: 'user',
    lamp: 'route',
  },
  access_request: {
    label: 'Access request',
    description: 'Someone asked for access to this server. Admins only.',
    icon: 'user',
    lamp: 'caution',
  },
  participation_request: {
    label: 'Participation request',
    description: 'Someone asked to join the pool of one of your projects. Project owners only.',
    icon: 'user',
    lamp: 'caution',
  },
};

export const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: 'In the app',
  email: 'E-mail',
  slack: 'Slack',
  discord: 'Discord',
  webhook: 'Webhook',
};
