import { useQuery } from '@tanstack/react-query';
import type { OnboardingStep, OnboardingStepId } from '@orch/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { fetchInstallUrl, fetchOnboarding } from '../api/endpoints';
import { AddRepoDialog } from './AddRepoDialog';

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

const TITLES: Record<OnboardingStepId, string> = {
  github_app_installed: 'Install the GitHub App',
  project_added: 'Add or join a project',
  participation_set: 'Choose how much capacity you lend',
  agent_connected: 'Install your machine',
  claude_connected: 'Connect Claude on your machine',
  mcp_connected: 'Connect Claude Code (MCP)',
};

const EXPLAIN: Record<OnboardingStepId, string> = {
  github_app_installed: 'The orch GitHub App lets orch read issues and open pull requests.',
  project_added: 'Add a repository you administer, or join a project shared with you.',
  participation_set: 'Pick a project and a budget so your machine can take its tasks.',
  agent_connected: 'The agent runs tasks on the machine that has your Claude subscription.',
  claude_connected: 'Sign in to Claude once on that machine so tasks can run.',
  mcp_connected: 'Let Claude Code view the pool and submit tasks through orch.',
};

export function GettingStarted() {
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
        <button onClick={() => dismiss(false)}>Show getting started</button>
      </div>
    );
  }

  const installApp = async () => {
    setInstallError(null);
    try {
      const { url } = await fetchInstallUrl();
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : 'Could not get the install link');
    }
  };

  const actions = (s: OnboardingStep): ReactNode => {
    switch (s.id) {
      case 'github_app_installed':
        return (
          <button className="primary" onClick={() => void installApp()}>
            Install the GitHub App
          </button>
        );
      case 'project_added':
        return (
          <>
            <button className="primary" onClick={() => setAdding(true)}>
              Add a repository
            </button>{' '}
            <Link className="btn" to="/discover">
              Join a project
            </Link>
          </>
        );
      case 'participation_set':
        return (
          <Link className="btn primary" to="/discover">
            Join a project
          </Link>
        );
      case 'agent_connected':
        return (
          <Link className="btn primary" to="/my-server">
            Install your machine
          </Link>
        );
      case 'claude_connected':
        return (
          <>
            <button className="primary" onClick={() => setShowLogin((v) => !v)}>
              Connect Claude on your machine
            </button>
            {showLogin && (
              <p>
                Run <code>orch login</code> on that machine.
              </p>
            )}
          </>
        );
      case 'mcp_connected':
        return (
          <Link className="btn primary" to="/claude-code">
            Connect Claude Code (MCP)
          </Link>
        );
    }
  };

  return (
    <section className="card getting-started" aria-label="Getting started">
      <div className="row between">
        <h2>Getting started</h2>
        <span className="hint">
          {done}/{steps.length} done
        </span>
      </div>
      {allDone && <p className="hint">All set. You can hide this card.</p>}
      {!allDone && (
        <p>
          <Link className="btn" to="/welcome">
            Open the setup wizard
          </Link>
        </p>
      )}
      <ol>
        {steps.map((s) => (
          <li key={s.id} className={s.done ? 'done' : ''} data-testid={`step-${s.id}`}>
            <span
              className="check"
              role="img"
              aria-label={s.done ? 'Done' : s.state === 'unknown' ? 'Unknown' : 'To do'}
            >
              {s.done ? '✓' : s.state === 'unknown' ? '?' : '○'}
            </span>
            <div className="step-body">
              <strong className="step-title">{TITLES[s.id]}</strong>
              <div className="hint">{EXPLAIN[s.id]}</div>
              {s.id === 'claude_connected' &&
                s.state === 'todo' &&
                s.reason === 'claude_login_expired' && (
                  <p className="warning">
                    Claude login expired: run <code>orch login</code>
                  </p>
                )}
              {!s.done && <div>{actions(s)}</div>}
            </div>
          </li>
        ))}
      </ol>
      {installError && <p className="error">{installError}</p>}
      {canDismiss && <button onClick={() => dismiss(true)}>Hide</button>}
      {adding && <AddRepoDialog onClose={() => setAdding(false)} />}
    </section>
  );
}
