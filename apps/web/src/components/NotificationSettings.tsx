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
import { errorMessage } from '../i18n/errors.ts';
import { formatDateTime } from '../i18n/format.ts';
import { useRich, useT, type MessageKey } from '../i18n/index.ts';
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
const URL_COPY = {
  slack: {
    label: 'notifications.settings.slack.label',
    placeholder: 'https://hooks.slack.com/services/...',
    hint: 'notifications.settings.slack.hint',
  },
  discord: {
    label: 'notifications.settings.discord.label',
    placeholder: 'https://discord.com/api/webhooks/...',
    hint: 'notifications.settings.discord.hint',
  },
  webhook: {
    label: 'notifications.settings.webhook.label',
    placeholder: 'https://example.com/orch-hook',
    hint: 'notifications.settings.webhook.hint',
  },
} as const satisfies Record<
  UrlChannel,
  { label: MessageKey; placeholder: string; hint: MessageKey }
>;
const URL_CHANNELS: UrlChannel[] = ['slack', 'discord', 'webhook'];

const ROLE_NOTE: Partial<Record<NotificationEvent, MessageKey>> = {
  access_request: 'notifications.settings.roleAdmins',
  participation_request: 'notifications.settings.roleOwners',
};

function configured(s: NotificationSettingsView, c: NotificationChannel): boolean {
  if (c === 'in_app') return true;
  if (c === 'email') return s.email.available && s.email.status === 'verified';
  if (c === 'push') return s.push.available && s.push.subscriptions > 0;
  return s[c].configured;
}

/** The "Notifications" card of My server: where to send notifications and which events go where. */
export function NotificationSettings() {
  const t = useT();
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
        <h2 id="notify-title">{t('notifications.settings.title')}</h2>
      </div>
      <p className="lede">{t('notifications.settings.lede')}</p>
      {settings.isPending && <p className="hint">{t('notifications.settings.loading')}</p>}
      {settings.error && <p className="error">{errorMessage(settings.error)}</p>}
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
  const t = useT();
  const rich = useRich();
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
      toast(t('notifications.settings.saved'));
    },
    onError: (e) =>
      setProblem(e instanceof ApiError ? errorMessage(e) : t('notifications.settings.saveFailed')),
  });
  const clear = useMutation({
    mutationFn: updateNotificationSettings,
    onSuccess: (view, vars) => {
      qc.setQueryData(KEY, view);
      setProblem(null);
      toast(
        vars.email === ''
          ? t('notifications.settings.emailRemoved')
          : t('notifications.settings.webhookRemoved'),
      );
    },
    onError: (e) =>
      setProblem(
        e instanceof ApiError ? errorMessage(e) : t('notifications.settings.removeFailed'),
      ),
  });
  const test = useMutation({
    mutationFn: sendTestNotification,
    onSuccess: (r, channel) => {
      const name = t(CHANNEL_LABEL[channel]);
      if (r.ok) toast(t('notifications.settings.testSent', { name }));
      else if (r.error === 'not_configured')
        toast(t('notifications.settings.testNotSetUp', { name }), 'info');
      else
        toast(
          t('notifications.settings.testFailed', {
            name,
            error: r.error ?? t('notifications.settings.unknownError'),
          }),
          'info',
        );
    },
    onError: (e, channel) =>
      toast(
        t('notifications.settings.testFailed', {
          name: t(CHANNEL_LABEL[channel]),
          error: errorMessage(e),
        }),
        'info',
      ),
  });

  const rotate = useMutation({
    mutationFn: rotateWebhookSecret,
    onSuccess: (view) => {
      qc.setQueryData(KEY, reveal(view));
      toast(t('notifications.settings.signing.generated'));
    },
    onError: (e) =>
      toast(
        e instanceof ApiError ? errorMessage(e) : t('notifications.settings.signing.rotateFailed'),
        'info',
      ),
  });

  const resend = useMutation({
    mutationFn: resendEmailConfirmation,
    onSuccess: () => toast(t('notifications.settings.email.resent')),
    onError: (e) =>
      toast(
        e instanceof ApiError ? errorMessage(e) : t('notifications.settings.email.resendFailed'),
        'info',
      ),
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
      <h3 className="notify-sub">{t('notifications.settings.whereToSend')}</h3>
      <div className="notify-targets">
        <div className="notify-target">
          <div className="notify-target-head">
            <label htmlFor="notify-email">{t('notifications.settings.email.label')}</label>
            <span className="hint">
              {data.email.available
                ? t('notifications.settings.email.available')
                : t('notifications.settings.email.unavailable')}
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
              name={t(CHANNEL_LABEL.email)}
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
                <span className="badge ok">{t('notifications.settings.email.verified')}</span>
              ) : (
                <>
                  <span className="badge pending">{t('notifications.settings.email.pending')}</span>
                  <span className="hint">{t('notifications.settings.email.pendingHint')}</span>
                  <button type="button" disabled={resend.isPending} onClick={() => resend.mutate()}>
                    {t('notifications.settings.email.resend')}
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
                <label htmlFor={`notify-${c}`}>{t(copy.label)}</label>
                <span className="hint">
                  {view.configured
                    ? rich(
                        'notifications.settings.urlSet',
                        { code: (c) => <code>{c}</code> },
                        { hint: view.hint ?? t('notifications.settings.urlHidden') },
                      )
                    : t(copy.hint)}
                </span>
              </div>
              <div className="notify-target-body">
                <input
                  id={`notify-${c}`}
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    view.configured ? t('notifications.settings.replaceUrl') : copy.placeholder
                  }
                  value={urls[c]}
                  aria-invalid={(badUrl && urls[c].trim() !== '') || undefined}
                  onChange={(e) => setUrls((u) => ({ ...u, [c]: e.target.value }))}
                />
                <TargetActions
                  name={t(CHANNEL_LABEL[c])}
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
                    {rich(
                      'notifications.settings.signing.secret',
                      { code: (x) => <code>{x}</code> },
                      {
                        hint: data.webhook.secretHint ?? t('notifications.settings.signing.none'),
                      },
                    )}
                  </span>
                  <button type="button" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
                    {data.webhook.secretHint
                      ? t('notifications.settings.signing.rotate')
                      : t('notifications.settings.signing.generate')}
                  </button>
                  <a href={SIGNING_DOCS} target="_blank" rel="noreferrer">
                    {t('notifications.settings.signing.docs')}
                  </a>
                  {data.webhook.previousSecretExpiresAt && (
                    <span className="hint">
                      {t('notifications.settings.signing.previous', {
                        date: formatDateTime(data.webhook.previousSecretExpiresAt),
                      })}
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
            <span className="notify-label">{t(CHANNEL_LABEL.in_app)}</span>
            <span className="hint">{t('notifications.settings.inApp.hint')}</span>
          </div>
          <div className="notify-target-body">
            <TargetActions
              name={t(CHANNEL_LABEL.in_app)}
              canRemove={false}
              canTest
              busy={false}
              onRemove={() => undefined}
              onTest={() => test.mutate('in_app')}
            />
          </div>
        </div>
      </div>

      <h3 className="notify-sub">{t('notifications.settings.whatToSend')}</h3>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">{t('notifications.settings.event')}</th>
              {NOTIFICATION_CHANNELS.map((c) => (
                <th scope="col" key={c} data-off={!configured(data, c) || undefined}>
                  {t(CHANNEL_LABEL[c])}
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
                      {t(meta.label)}
                      {role && <span className="tag">{t(role)}</span>}
                    </span>
                    <span className="hint">{t(meta.description)}</span>
                  </th>
                  {NOTIFICATION_CHANNELS.map((c) => {
                    const ok = configured(data, c);
                    return (
                      <td key={c}>
                        <input
                          type="checkbox"
                          checked={ok && (prefs[ev] ?? []).includes(c)}
                          disabled={!ok}
                          aria-label={t('notifications.settings.eventOnChannel', {
                            event: t(meta.label),
                            channel: t(CHANNEL_LABEL[c]),
                          })}
                          title={
                            ok
                              ? undefined
                              : t('notifications.settings.channelNotSetUp', {
                                  channel: t(CHANNEL_LABEL[c]),
                                })
                          }
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
      <p className="hint">{t('notifications.settings.greyedHint')}</p>

      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="card-foot">
        <button type="submit" className="primary" disabled={save.isPending}>
          {t('notifications.settings.save')}
        </button>
      </div>
    </form>
  );
}

type BrowserState = 'checking' | 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

/** "Enable browser notifications": subscribes this browser to Web Push, after asking permission. */
function BrowserTarget({ data, onTest }: { data: NotificationSettingsView; onTest: () => void }) {
  const t = useT();
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
        if (permission !== 'denied') toast(t('notifications.settings.browser.notEnabled'), 'info');
        return;
      }
      const sub = await subscribeBrowser(publicKey);
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        throw new Error(t('notifications.push.incompleteSubscription'));
      }
      await pushSubscribe({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
      setState('on');
      toast(t('notifications.settings.browser.enabled'));
      await refresh();
    } catch (e) {
      toast(
        t('notifications.settings.browser.enableFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
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
      toast(t('notifications.settings.browser.disabled'));
      await refresh();
    } catch (e) {
      toast(
        t('notifications.settings.browser.disableFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
        'info',
      );
    } finally {
      setBusy(false);
    }
  };

  const hint: Record<BrowserState, string> = {
    checking: t('notifications.settings.browser.checking'),
    unsupported: t('notifications.settings.browser.unsupported'),
    unavailable: t('notifications.settings.browser.unavailable'),
    denied: t('notifications.settings.browser.denied'),
    off: t('notifications.settings.browser.off'),
    on:
      subscriptions > 1
        ? t('notifications.settings.browser.onMany', { count: subscriptions })
        : t('notifications.settings.browser.onOne'),
  };
  const locked = busy || state === 'checking' || state === 'unsupported' || state === 'unavailable';

  return (
    <div className="notify-target">
      <div className="notify-target-head">
        <span className="notify-label">{t(CHANNEL_LABEL.push)}</span>
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
          {t('notifications.settings.browser.enable')}
        </label>
        <TargetActions
          name={t(CHANNEL_LABEL.push)}
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
  const t = useT();
  return (
    <span className="notify-actions">
      <button
        type="button"
        disabled={!canTest}
        onClick={onTest}
        aria-label={t('notifications.settings.sendTo', { name })}
      >
        {t('notifications.settings.send')}
      </button>
      {canRemove && (
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={onRemove}
          aria-label={t('notifications.settings.removeTarget', { name })}
        >
          {t('notifications.settings.remove')}
        </button>
      )}
    </span>
  );
}

/** The signing secret, shown once after it is created or rotated. */
function SecretReveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  const t = useT();
  const rich = useRich();
  return (
    <div className="card notify-secret" role="alert">
      <h3 className="notify-sub">{t('notifications.settings.signing.revealTitle')}</h3>
      <p className="hint">
        {rich('notifications.settings.signing.revealHint', { code: (x) => <code>{x}</code> })}
      </p>
      <div className="notify-status">
        <code className="notify-secret-value">{secret}</code>
        <CopyButton text={secret} label={t('notifications.settings.signing.copy')} />
        <button type="button" onClick={onDone}>
          {t('notifications.settings.signing.saved')}
        </button>
      </div>
    </div>
  );
}
