import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationPreferences,
  type NotificationSettingsView,
  type UpdateNotificationSettingsRequest,
} from '@orch/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { ApiError } from '../api/client';
import {
  fetchNotificationSettings,
  resendEmailConfirmation,
  rotateWebhookSecret,
  pushSubscribe,
  pushUnsubscribe,
  sendTestNotification,
  updateNotificationSettings,
} from '../api/endpoints';
import { useMe } from '../auth';
import { motionAllowed } from '../ui/motion';
import {
  currentSubscription,
  notificationPermission,
  pushSupported,
  subscribeBrowser,
} from '../push/browser';
import { CHANNEL_LABEL, EVENT_META } from '../ui/notificationMeta';
import { useToast } from '../ui/Toast';
import { CopyButton } from './CopyButton';

const SIGNING_DOCS =
  'https://claude-orch.readthedocs.io/en/latest/notifications.html#verifying-webhook-signatures';

const KEY = ['notifications', 'settings'] as const;

type UrlChannel = 'slack' | 'discord' | 'webhook';
const URL_FIELD = {
  slack: 'slackWebhookUrl',
  discord: 'discordWebhookUrl',
  webhook: 'webhookUrl',
} as const;
const URL_COPY: Record<UrlChannel, { label: string; placeholder: string; hint: string }> = {
  slack: {
    label: 'Slack incoming webhook URL',
    placeholder: 'https://hooks.slack.com/services/...',
    hint: 'Messages post to the channel the webhook was created for.',
  },
  discord: {
    label: 'Discord webhook URL',
    placeholder: 'https://discord.com/api/webhooks/...',
    hint: 'Messages post to the channel the webhook was created for.',
  },
  webhook: {
    label: 'JSON webhook URL',
    placeholder: 'https://example.com/orch-hook',
    hint: 'Receives each notification as a JSON POST.',
  },
};
const URL_CHANNELS: UrlChannel[] = ['slack', 'discord', 'webhook'];

const ROLE_NOTE: Partial<Record<NotificationEvent, string>> = {
  access_request: 'Admins',
  participation_request: 'Project owners',
};

function configured(s: NotificationSettingsView, c: NotificationChannel): boolean {
  if (c === 'in_app') return true;
  if (c === 'email') return s.email.available && s.email.status === 'verified';
  if (c === 'push') return s.push.available && s.push.subscriptions > 0;
  return s[c].configured;
}

/** The "Notifications" card of My server: where to send notifications and which events go where. */
export function NotificationSettings() {
  const settings = useQuery({ queryKey: KEY, queryFn: fetchNotificationSettings });
  const section = useRef<HTMLElement>(null);
  const { hash } = useLocation();
  const ready = settings.isSuccess;
  // The full secret lives here only: never in the query cache, gone once dismissed.
  const [secret, setSecret] = useState<string | null>(null);
  const reveal = (view: NotificationSettingsView) => {
    if (view.webhookSecret) setSecret(view.webhookSecret);
    return { ...view, webhookSecret: undefined };
  };
  useEffect(() => {
    if (hash !== '#notifications' || !ready) return;
    section.current?.scrollIntoView?.({ behavior: motionAllowed() ? 'smooth' : 'auto' });
  }, [hash, ready]);

  return (
    <section id="notifications" ref={section} className="notify" aria-labelledby="notify-title">
      <div className="section-title">
        <h2 id="notify-title">Notifications</h2>
      </div>
      <p className="lede">
        Choose where orch reaches you when a task finishes, fails or waits for you.
      </p>
      {settings.isPending && <p className="hint">Loading notification settings...</p>}
      {settings.error && <p className="error">{settings.error.message}</p>}
      {secret && <SecretReveal secret={secret} onDone={() => setSecret(null)} />}
      {settings.data && (
        <SettingsForm key={formKey(settings.data)} data={settings.data} reveal={reveal} />
      )}
    </section>
  );
}

/**
 * The form restarts from the saved settings after each save. Browser subscriptions change on their
 * own (this browser toggled, another one added) and must not discard edits in progress.
 */
const formKey = (d: NotificationSettingsView) => JSON.stringify({ ...d, push: undefined });

function SettingsForm({
  data,
  reveal,
}: {
  data: NotificationSettingsView;
  reveal: (v: NotificationSettingsView) => NotificationSettingsView;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = !!useMe().data?.isAdmin;
  const [prefs, setPrefs] = useState<NotificationPreferences>(data.preferences);
  const [email, setEmail] = useState(data.email.address ?? '');
  const [urls, setUrls] = useState<Record<UrlChannel, string>>({
    slack: '',
    discord: '',
    webhook: '',
  });
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: updateNotificationSettings,
    onSuccess: (view) => {
      qc.setQueryData(KEY, reveal(view));
      setProblem(null);
      toast('Notification settings saved');
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : 'Could not save the settings'),
  });
  const clear = useMutation({
    mutationFn: updateNotificationSettings,
    onSuccess: (view, vars) => {
      qc.setQueryData(KEY, view);
      setProblem(null);
      toast(`${vars.email === '' ? 'E-mail address' : 'Webhook'} removed`);
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : 'Could not remove the target'),
  });
  const test = useMutation({
    mutationFn: sendTestNotification,
    onSuccess: (r, channel) => {
      const name = CHANNEL_LABEL[channel];
      if (r.ok) toast(`Test sent to ${name}`);
      else if (r.error === 'not_configured') toast(`${name} is not set up yet`, 'info');
      else toast(`Test to ${name} failed: ${r.error ?? 'unknown error'}`, 'info');
    },
    onError: (e, channel) =>
      toast(`Test to ${CHANNEL_LABEL[channel]} failed: ${e.message}`, 'info'),
  });

  const rotate = useMutation({
    mutationFn: rotateWebhookSecret,
    onSuccess: (view) => {
      qc.setQueryData(KEY, reveal(view));
      toast('New signing secret generated');
    },
    onError: (e) =>
      toast(e instanceof ApiError ? e.message : 'Could not rotate the secret', 'info'),
  });

  const resend = useMutation({
    mutationFn: resendEmailConfirmation,
    onSuccess: () => toast('Confirmation e-mail sent. Check your inbox.'),
    onError: (e) =>
      toast(e instanceof ApiError ? e.message : 'Could not send the confirmation e-mail', 'info'),
  });

  const toggle = (event: NotificationEvent, channel: NotificationChannel, on: boolean) =>
    setPrefs((p) => {
      const current = p[event] ?? [];
      const next = on ? [...current, channel] : current.filter((c) => c !== channel);
      return { ...p, [event]: NOTIFICATION_CHANNELS.filter((c) => next.includes(c)) };
    });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const body: UpdateNotificationSettingsRequest = { preferences: prefs };
    for (const c of URL_CHANNELS) {
      const v = urls[c].trim();
      if (v) body[URL_FIELD[c]] = v;
    }
    const trimmed = email.trim();
    if (data.email.available && trimmed !== (data.email.address ?? '')) body.email = trimmed;
    save.mutate(body);
  };

  const badUrl = problem !== null;
  return (
    <form className="card notify-card" onSubmit={onSubmit} noValidate>
      <h3 className="notify-sub">Where to send</h3>
      <div className="notify-targets">
        <div className="notify-target">
          <div className="notify-target-head">
            <label htmlFor="notify-email">E-mail address</label>
            <span className="hint">
              {data.email.available
                ? 'Notifications are sent to this address once you have confirmed it.'
                : 'This server has no mail settings, so e-mail is unavailable. Ask an admin to set them up.'}
            </span>
          </div>
          <div className="notify-target-body">
            <input
              id="notify-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              disabled={!data.email.available}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TargetActions
              name="E-mail"
              canRemove={!!data.email.address}
              canTest={configured(data, 'email')}
              busy={clear.isPending}
              onRemove={() => clear.mutate({ email: '' })}
              onTest={() => test.mutate('email')}
            />
          </div>
          {data.email.available && data.email.status !== 'none' && (
            <div className="notify-status">
              {data.email.status === 'verified' ? (
                <span className="badge ok">Verified</span>
              ) : (
                <>
                  <span className="badge pending">Pending confirmation</span>
                  <span className="hint">
                    Nothing is sent to this address until you open the link we e-mailed.
                  </span>
                  <button type="button" disabled={resend.isPending} onClick={() => resend.mutate()}>
                    Resend confirmation
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {URL_CHANNELS.map((c) => {
          const copy = URL_COPY[c];
          const view = data[c];
          return (
            <div className="notify-target" key={c}>
              <div className="notify-target-head">
                <label htmlFor={`notify-${c}`}>{copy.label}</label>
                <span className="hint">
                  {view.configured ? (
                    <>
                      Set: <code>{view.hint ?? 'hidden'}</code>. Paste a new URL to replace it.
                    </>
                  ) : (
                    copy.hint
                  )}
                </span>
              </div>
              <div className="notify-target-body">
                <input
                  id={`notify-${c}`}
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={view.configured ? 'Replace the URL' : copy.placeholder}
                  value={urls[c]}
                  aria-invalid={(badUrl && urls[c].trim() !== '') || undefined}
                  onChange={(e) => setUrls((u) => ({ ...u, [c]: e.target.value }))}
                />
                <TargetActions
                  name={CHANNEL_LABEL[c]}
                  canRemove={view.configured}
                  canTest={view.configured}
                  busy={clear.isPending}
                  onRemove={() => clear.mutate({ [URL_FIELD[c]]: null })}
                  onTest={() => test.mutate(c)}
                />
              </div>
              {c === 'webhook' && data.webhook.configured && (
                <div className="notify-status">
                  <span>
                    Signing secret: <code>{data.webhook.secretHint ?? 'none yet'}</code>
                  </span>
                  <button type="button" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
                    {data.webhook.secretHint ? 'Rotate secret' : 'Generate secret'}
                  </button>
                  <a href={SIGNING_DOCS} target="_blank" rel="noreferrer">
                    How to verify signatures
                  </a>
                  {data.webhook.previousSecretExpiresAt && (
                    <span className="hint">
                      The previous secret also signs until{' '}
                      {new Date(data.webhook.previousSecretExpiresAt).toLocaleString()}.
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <BrowserTarget data={data} onTest={() => test.mutate('push')} />
        <div className="notify-target">
          <div className="notify-target-head">
            <span className="notify-label">In the app</span>
            <span className="hint">The bell in the header. Always available.</span>
          </div>
          <div className="notify-target-body">
            <TargetActions
              name="In the app"
              canRemove={false}
              canTest
              busy={false}
              onRemove={() => undefined}
              onTest={() => test.mutate('in_app')}
            />
          </div>
        </div>
      </div>

      <h3 className="notify-sub">What to send</h3>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">Event</th>
              {NOTIFICATION_CHANNELS.map((c) => (
                <th scope="col" key={c} data-off={!configured(data, c) || undefined}>
                  {CHANNEL_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_EVENTS.map((ev) => {
              const meta = EVENT_META[ev];
              const role = ROLE_NOTE[ev];
              const relevant = ev !== 'access_request' || isAdmin;
              return (
                <tr key={ev} data-muted={!relevant || undefined}>
                  <th scope="row">
                    <span className="matrix-event">
                      {meta.label}
                      {role && <span className="tag">{role}</span>}
                    </span>
                    <span className="hint">{meta.description}</span>
                  </th>
                  {NOTIFICATION_CHANNELS.map((c) => {
                    const ok = configured(data, c);
                    return (
                      <td key={c}>
                        <input
                          type="checkbox"
                          checked={ok && (prefs[ev] ?? []).includes(c)}
                          disabled={!ok}
                          aria-label={`${meta.label} on ${CHANNEL_LABEL[c]}`}
                          title={ok ? undefined : `${CHANNEL_LABEL[c]} is not set up`}
                          onChange={(e) => toggle(ev, c, e.target.checked)}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">Greyed-out channels need a target above. Save a target to turn it on.</p>

      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="card-foot">
        <button type="submit" className="primary" disabled={save.isPending}>
          Save notification settings
        </button>
      </div>
    </form>
  );
}

type BrowserState = 'checking' | 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

/** "Enable browser notifications": subscribes this browser to Web Push, after asking permission. */
function BrowserTarget({ data, onTest }: { data: NotificationSettingsView; onTest: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { available, publicKey, subscriptions } = data.push;
  const [state, setState] = useState<BrowserState>(
    !pushSupported() ? 'unsupported' : !available ? 'unavailable' : 'checking',
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state !== 'checking') return;
    let live = true;
    currentSubscription()
      .then((sub) => {
        if (!live) return;
        if (sub) setState('on');
        else setState(notificationPermission() === 'denied' ? 'denied' : 'off');
      })
      .catch(() => live && setState('off'));
    return () => {
      live = false;
    };
  }, [state]);

  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  const enable = async () => {
    if (!publicKey) return;
    setBusy(true);
    try {
      // Asked in the click handler: browsers only show the prompt after a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        if (permission !== 'denied') toast('Browser notifications were not enabled', 'info');
        return;
      }
      const sub = await subscribeBrowser(publicKey);
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        throw new Error('The browser returned an incomplete subscription');
      }
      await pushSubscribe({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
      setState('on');
      toast('Browser notifications enabled');
      await refresh();
    } catch (e) {
      toast(
        `Could not enable browser notifications: ${e instanceof Error ? e.message : e}`,
        'info',
      );
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const sub = await currentSubscription();
      if (sub) {
        await pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setState('off');
      toast('Browser notifications turned off');
      await refresh();
    } catch (e) {
      toast(
        `Could not turn off browser notifications: ${e instanceof Error ? e.message : e}`,
        'info',
      );
    } finally {
      setBusy(false);
    }
  };

  const hint: Record<BrowserState, string> = {
    checking: 'Checking this browser...',
    unsupported:
      'This browser cannot show notifications. On iPhone and iPad, add orch to the Home Screen first.',
    unavailable:
      'This server has no push keys, so browser notifications are unavailable. Ask an admin to set them up.',
    denied:
      "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.",
    off: 'Show a system notification on this device, even when orch is closed.',
    on:
      subscriptions > 1
        ? `This browser is on. ${subscriptions} browsers receive notifications.`
        : 'This browser receives notifications.',
  };
  const locked = busy || state === 'checking' || state === 'unsupported' || state === 'unavailable';

  return (
    <div className="notify-target">
      <div className="notify-target-head">
        <span className="notify-label">Browser</span>
        <span className="hint" id="notify-browser-hint">
          {hint[state]}
        </span>
      </div>
      <div className="notify-target-body">
        <label className="notify-switch">
          <input
            id="notify-browser"
            type="checkbox"
            checked={state === 'on'}
            disabled={locked || state === 'denied'}
            aria-describedby="notify-browser-hint"
            onChange={(e) => void (e.target.checked ? enable() : disable())}
          />
          Enable browser notifications
        </label>
        <TargetActions
          name="Browser"
          canRemove={false}
          canTest={available && subscriptions > 0}
          busy={busy}
          onRemove={() => undefined}
          onTest={onTest}
        />
      </div>
    </div>
  );
}

function TargetActions({
  name,
  canRemove,
  canTest,
  busy,
  onRemove,
  onTest,
}: {
  name: string;
  canRemove: boolean;
  canTest: boolean;
  busy: boolean;
  onRemove: () => void;
  onTest: () => void;
}) {
  return (
    <span className="notify-actions">
      <button
        type="button"
        disabled={!canTest}
        onClick={onTest}
        aria-label={`Send test to ${name}`}
      >
        Send test
      </button>
      {canRemove && (
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={onRemove}
          aria-label={`Remove ${name}`}
        >
          Remove
        </button>
      )}
    </span>
  );
}

/** The signing secret, shown once after it is created or rotated. */
function SecretReveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <div className="card notify-secret" role="alert">
      <h3 className="notify-sub">Webhook signing secret</h3>
      <p className="hint">
        Copy it now: it is shown only once. Receivers use it to verify the{' '}
        <code>webhook-signature</code> header, and should dedupe on <code>webhook-id</code>.
      </p>
      <div className="notify-status">
        <code className="notify-secret-value">{secret}</code>
        <CopyButton text={secret} label="Copy secret" />
        <button type="button" onClick={onDone}>
          I have saved it
        </button>
      </div>
    </div>
  );
}
