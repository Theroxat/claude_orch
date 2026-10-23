# Notifications

orch tells you when something needs you: a task you created is merged or fails, a PR waits for review, a task is offered to you, or someone asks to join your pool or your server. Notifications show up in the app (the bell in the header) and, if you want, in Slack, Discord, any JSON webhook or by e-mail.

<img src="screenshot-notifications.png" alt="The bell panel: latest notifications, unread ones marked" width="100%">

## Events

| Event                     | Sent to                                           | When                                                                                 |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Task done**             | The task's creator and the member who ran it      | The task's PR is merged                                                              |
| **Task failed**           | The creator and the member whose machine ran it   | A run fails, produces no changes, or is lost (the agent stopped reporting)           |
| **Needs attention**       | The creator and the project owner                 | A task stops being dispatched after repeated setup (`env`) failures                  |
|                           | The agent's owner                                 | Claude rejects the login of one of your agents (run `orch login` on that machine)    |
| **PR ready for review**   | The project owner and the creator                 | orch opens the PR of a task, or someone opens a PR on a task branch                  |
| **Task offered to you**   | The member it is offered to                       | A consent request (`APPROVAL` mode) waits for your answer                            |
| **Access request**        | Admins (`ORCH_ADMIN_GITHUB_LOGINS`) who signed in | Someone asks for access to the server                                                |
| **Participation request** | The project owner                                 | Someone asks to join the pool of a project that requires approval (once per request) |

You are never notified about something you did yourself in the web app (for example, approving your own request).

## Channels

Set them up on **My Server → Notifications**, then choose, per event, which channels it goes to. By default every event goes to the app only. Each channel has a **Send test** button that sends one message right away and shows the result.

<img src="screenshot-notification-settings.png" alt="Notification settings: channel targets and the event x channel matrix" width="100%">

| Channel | What you enter                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------- |
| In-app  | Nothing. The bell shows the unread count; notifications are kept 90 days (`NOTIFY_RETENTION_DAYS`) |
| E-mail  | An address, confirmed by a link (see below). Only offered when the server has SMTP settings        |
| Slack   | A Slack [incoming webhook](https://api.slack.com/messaging/webhooks) URL. Mattermost works too     |
| Discord | A channel [webhook](https://support.discord.com/hc/en-us/articles/228383668) URL                   |
| Webhook | Any `https` URL that accepts a JSON `POST`                                                         |

Webhook URLs are secrets (anyone who has one can post to your channel). orch stores them encrypted with `ORCH_ENCRYPTION_KEY` and only ever shows a masked hint such as `https://hooks.slack.com/…k9Qp`. To change one, paste a new URL; **Remove** deletes it.

### Generic webhook payload

```json
{
  "version": 1,
  "id": "cm3…",
  "event": "task_failed",
  "title": "Run failed: Add rate limiting to /search",
  "body": "acme/api#42: tests failed. The task went back to the pool.",
  "url": "https://orch.example.com/backlog?task=cm2…",
  "projectId": "cm1…",
  "taskId": "cm2…",
  "createdAt": "2026-10-22T09:14:03.120Z"
}
```

`event` is one of `task_done`, `task_failed`, `task_needs_attention`, `pr_review`, `consent_request`, `access_request`, `participation_request`. `url` is the PR for `task_done` and `pr_review`, otherwise a page of the web app. Any `2xx` answer counts as delivered; redirects are not followed.

## Delivery

Notifications never slow down the action that caused them: they are prepared in the background after the action is recorded in the audit log. External deliveries are retried on network errors, timeouts (10 s), `408`, `429` and `5xx` answers, with exponential backoff (2 s, 8 s, 32 s by default, `NOTIFY_MAX_ATTEMPTS` attempts in total). Other `4xx` answers (for example a deleted Slack hook) stop at once. Failures are written to the server log with the channel and the user, never the URL.

Retries are kept in memory: a server restart drops deliveries still waiting for a retry. In-app notifications are written to the database first and are not affected.

## Security: no requests to private networks

A webhook URL is chosen by a member, so the server checks it to make sure it cannot be used to reach machines on its own network (SSRF):

- only `https` URLs without credentials are accepted;
- host names such as `localhost`, `*.local`, `*.internal` or single-label names are refused, and so are IP addresses in private, loopback, link-local (including cloud metadata `169.254.169.254`), carrier-grade NAT, multicast and reserved ranges, IPv4 and IPv6 (including IPv4-mapped forms);
- the check is repeated at delivery on every address the name resolves to, and the connection goes to the checked address, so a DNS answer that changes after the check cannot point the request inside.

A consequence: a Slack-compatible server on your LAN (for example a self-hosted Mattermost on a private IP) cannot be used as a webhook target.

## E-mail (SMTP)

E-mail is optional. Set these in `deploy/server/.env` and restart the server:

```sh
SMTP_HOST=smtp.example.com
SMTP_PORT=587          # 465 with SMTP_SECURE=true
SMTP_SECURE=false      # true: TLS from the first byte; false: STARTTLS when offered
SMTP_USER=orch@example.com
SMTP_PASSWORD=...
SMTP_FROM="orch <orch@example.com>"
```

Without `SMTP_HOST` the e-mail column is greyed out in the settings. A permanent SMTP refusal (`5xx`, for example an unknown address) is not retried.

### Confirming your e-mail address

orch never sends a notification or a test message to an address you have not confirmed, otherwise anyone could make the server write to any mailbox.

1. Enter your address and save. It shows as **Pending confirmation** and orch sends **one** e-mail with a confirmation link.
2. Open the link. It lands on a page of the web app (sign in first if needed) with a **Confirm** button. Pressing it confirms the address, which then shows as **Verified**. Only that button confirms: mail scanners and link previews that merely open the link change nothing.
3. If the e-mail did not arrive or the link expired, press **Resend confirmation**. Each new link cancels the previous one.

Links work once and expire after 24 hours. Only a hash of the token is stored. Changing the address makes it pending again and cancels any link sent to the old one. Answers to the confirmation endpoints never say whether an address is known to the server.

Confirmation e-mails are limited to 3 per hour and 10 per day per member (the first one and every resend count; past the limit the address is saved as pending and **Resend confirmation** answers `429` until the window moves on). **Send test** is limited to 5 per minute.

Addresses saved before this check existed must be confirmed once: they stay pending, so no e-mail is sent to them until you press **Resend confirmation** and open the link. orch does not read your GitHub e-mail addresses (that needs an extra GitHub permission), so a matching address is not confirmed automatically.

See {doc}`configuration` for every variable.
