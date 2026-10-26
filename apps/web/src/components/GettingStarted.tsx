import { useQuery } from '@tanstack/react-query';
import type { OnboardingStep, OnboardingStepId } from '@orch/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { fetchInstallUrl, fetchOnboarding } from '../api/endpoints';
import { AddRepoDialog } from './AddRepoDialog';
import { errorMessage } from '../i18n/errors.ts';
import { useRich, useT, type MessageKey } from '../i18n/index.ts';
import { claudeRejectedText, relativeTime } from './AgentCard';

export const DISMISS_KEY = 'orch.gettingStarted.dismissed';

export function useOnboarding(intervalMs = 15_000) {
  return useQuery({
    queryKey: ['onboarding'],
    queryFn: fetchOnboarding,
    refetchInterval: intervalMs,
    refetchOnWindowFocus: true,
  });
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(v: boolean) {
  try {
    if (v) localStorage.setItem(DISMISS_KEY, '1');
    else localStorage.removeItem(DISMISS_KEY);
  } catch {
    // storage unavailable: the card just comes back on reload
  }
}

const TITLES = {
  github_app_installed: 'welcome.card.title.github_app_installed',
  project_added: 'welcome.card.title.project_added',
  participation_set: 'welcome.card.title.participation_set',
  agent_connected: 'welcome.card.title.agent_connected',
  claude_connected: 'welcome.card.title.claude_connected',
  mcp_connected: 'welcome.card.title.mcp_connected',
} as const satisfies Record<OnboardingStepId, MessageKey>;

const EXPLAIN = {
  github_app_installed: 'welcome.card.explain.github_app_installed',
  project_added: 'welcome.card.explain.project_added',
  participation_set: 'welcome.card.explain.participation_set',
  agent_connected: 'welcome.card.explain.agent_connected',
  claude_connected: 'welcome.card.explain.claude_connected',
  mcp_connected: 'welcome.card.explain.mcp_connected',
} as const satisfies Record<OnboardingStepId, MessageKey>;

export function GettingStarted() {
  const t = useT();
  const rich = useRich();
  const q = useOnboarding();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [adding, setAdding] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const steps = q.data?.steps;
  if (!steps) return null;
  const done = steps.filter((s) => s.done).length;
  const allDone = done === steps.length;
  // An unknown step (the agent does not report it yet) must not trap the user.
  const canDismiss = steps.every((s) => s.state !== 'todo');

  const dismiss = (v: boolean) => {
    writeDismissed(v);
    setDismissed(v);
  };

  if (dismissed && canDismiss) {
    return (
      <div className="row">
        <button className="ghost" onClick={() => dismiss(false)}>
          {t('welcome.card.show')}
        </button>
      </div>
    );
  }

  const installApp = async () => {
    setInstallError(null);
    try {
      const { url } = await fetchInstallUrl();
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setInstallError(
        e instanceof Error && e.message ? errorMessage(e) : t('welcome.card.installLinkError'),
      );
    }
  };

  const actions = (s: OnboardingStep): ReactNode => {
    switch (s.id) {
      case 'github_app_installed':
        return (
          <button className="primary" onClick={() => void installApp()}>
            {t(TITLES.github_app_installed)}
          </button>
        );
      case 'project_added':
        return (
          <>
            <button className="primary" onClick={() => setAdding(true)}>
              {t('welcome.card.addRepo')}
            </button>
            <Link className="btn" to="/discover">
              {t('welcome.card.joinProject')}
            </Link>
          </>
        );
      case 'participation_set':
        return (
          <Link className="btn primary" to="/discover">
            {t('welcome.card.joinProject')}
          </Link>
        );
      case 'agent_connected':
        return (
          <Link className="btn primary" to="/my-server">
            {t(TITLES.agent_connected)}
          </Link>
        );
      case 'claude_connected':
        return (
          <>
            <button className="primary" onClick={() => setShowLogin((v) => !v)}>
              {t(TITLES.claude_connected)}
            </button>
            {showLogin && (
              <p className="reveal">
                {rich('welcome.card.runLogin', { code: (c) => <code>{c}</code> })}
              </p>
            )}
          </>
        );
      case 'mcp_connected':
        return (
          <Link className="btn primary" to="/claude-code">
            {t(TITLES.mcp_connected)}
          </Link>
        );
    }
  };

  return (
    <section className="card getting-started" aria-label={t('welcome.card.ariaLabel')}>
      <div className="card-head">
        <h2>{t('welcome.card.heading')}</h2>
        <div className="row">
          <span className="badge ok">
            {t('welcome.card.progress', { done, total: steps.length })}
          </span>
          {!allDone && (
            <Link className="btn" to="/welcome">
              {t('welcome.card.openWizard')}
            </Link>
          )}
        </div>
      </div>
      {allDone && <p className="hint">{t('welcome.card.allSet')}</p>}
      <ol>
        {steps.map((s, i) => (
          <li
            key={s.id}
            className={s.done ? 'done' : s.state === 'unknown' ? 'unknown' : ''}
            data-testid={`step-${s.id}`}
          >
            <span
              className="check"
              role="img"
              aria-label={
                s.done
                  ? t('welcome.card.stateDone')
                  : s.state === 'unknown'
                    ? t('welcome.card.stateUnknown')
                    : t('welcome.card.stateTodo')
              }
            >
              {s.done ? '✓' : s.state === 'unknown' ? '?' : i + 1}
            </span>
            <div className="step-body">
              <strong className="step-title">{t(TITLES[s.id])}</strong>
              <div className="hint">{t(EXPLAIN[s.id])}</div>
              {s.id === 'claude_connected' &&
                s.state === 'todo' &&
                s.reason === 'claude_login_expired' && (
                  <p className="warning">
                    {claudeRejectedText(
                      { claudeAuthError: s.errorClass },
                      s.agentName ? (
                        <> {t('welcome.card.onMachine', { name: s.agentName })}</>
                      ) : null,
                    )}
                  </p>
                )}
              {s.id === 'claude_connected' && s.done && (
                <p className="hint">
                  {s.reason === 'claude_login_unverified'
                    ? rich('welcome.card.loginUnverified', { code: (c) => <code>{c}</code> })
                    : s.reason === 'claude_check_inconclusive'
                      ? t('welcome.card.inconclusive', {
                          error: s.errorClass ?? t('welcome.card.inconclusiveFallback'),
                          when: relativeTime(s.checkedAt),
                        })
                      : s.checkedAt
                        ? t('welcome.card.verified', { when: relativeTime(s.checkedAt) })
                        : null}
                </p>
              )}
              {!s.done && <div className="step-actions">{actions(s)}</div>}
            </div>
          </li>
        ))}
      </ol>
      {installError && <p className="error">{installError}</p>}
      {canDismiss && (
        <button className="ghost" onClick={() => dismiss(true)}>
          {t('welcome.card.hide')}
        </button>
      )}
      {adding && <AddRepoDialog onClose={() => setAdding(false)} />}
    </section>
  );
}
