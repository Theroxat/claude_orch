import type { NotificationEvent } from '@orch/shared';
import type { NotificationDraft } from './events';

/** A notification as it leaves the server, with an absolute link. */
export interface OutgoingNotification extends NotificationDraft {
  id: string;
  /** Absolute URL (app paths resolved against the public base URL), or null. */
  link: string | null;
  createdAt: Date;
}

export const EVENT_LABELS: Record<NotificationEvent, string> = {
  task_done: 'Task done',
  task_failed: 'Task failed',
  task_needs_attention: 'Needs attention',
  pr_review: 'PR ready for review',
  consent_request: 'Task waiting for your approval',
  access_request: 'Access request',
  participation_request: 'Participation request',
};

/** Discord embed colours, matched to the web app's status colours. */
const EVENT_COLORS: Record<NotificationEvent, number> = {
  task_done: 0x2ea44f,
  task_failed: 0xd1242f,
  task_needs_attention: 0xd97706,
  pr_review: 0x8250df,
  consent_request: 0xd97757,
  access_request: 0x0969da,
  participation_request: 0x0969da,
};

export function absoluteLink(baseUrl: string, url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('/')) return `${baseUrl.replace(/\/+$/, '')}${url}`;
  return url;
}

/** Slack mrkdwn: only &, < and > are special. */
const slackEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Slack incoming webhook (also accepted by Mattermost and Rocket.Chat). */
export function slackPayload(n: OutgoingNotification) {
  const title = slackEscape(n.title);
  const heading = n.link ? `*<${n.link}|${title}>*` : `*${title}*`;
  return {
    text: `${n.title}: ${n.body}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${heading}\n${slackEscape(n.body)}` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `orch · ${EVENT_LABELS[n.event]}` }],
      },
    ],
  };
}

/** Discord webhook: one embed, mentions disabled so a task title cannot ping @everyone. */
export function discordPayload(n: OutgoingNotification) {
  return {
    username: 'orch',
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: n.title.slice(0, 256),
        description: n.body.slice(0, 4096),
        ...(n.link ? { url: n.link } : {}),
        color: EVENT_COLORS[n.event],
        timestamp: n.createdAt.toISOString(),
        footer: { text: `orch · ${EVENT_LABELS[n.event]}` },
      },
    ],
  };
}

/** Generic JSON webhook. Versioned so receivers can tell future shapes apart. */
export function genericPayload(n: OutgoingNotification) {
  return {
    version: 1,
    id: n.id,
    event: n.event,
    title: n.title,
    body: n.body,
    url: n.link,
    projectId: n.projectId,
    taskId: n.taskId,
    createdAt: n.createdAt.toISOString(),
  };
}

export function emailMessage(n: OutgoingNotification, baseUrl: string) {
  const settings = absoluteLink(baseUrl, '/my-server#notifications');
  const lines = [n.body, ''];
  if (n.link) lines.push(n.link, '');
  lines.push('--', `orch · ${EVENT_LABELS[n.event]}`, `Notification settings: ${settings}`);
  return { subject: `[orch] ${n.title}`, text: lines.join('\n') };
}
