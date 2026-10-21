import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnboardingStepId } from '@orch/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  completeOnboarding,
  dismissOnboarding,
  fetchDiscover,
  fetchMyAgents,
  fetchMyProjects,
} from '../api/endpoints';
import { useMe } from '../auth';
import { RepoPicker } from '../components/AddRepoDialog';
import { CopyButton } from '../components/CopyButton';
import { useOnboarding } from '../components/GettingStarted';
import { InstallCommandBlock, LOGIN_COMMAND } from '../components/InstallAgentCard';
import { McpCommand } from '../components/McpCommand';
import { ParticipationForm } from '../components/ParticipationForm';
import { VersionFooter } from '../components/VersionFooter';

/** Server state is polled this often while a step is waiting for the user. */
export const POLL_MS = 3000;
/** Pause on the green check before moving on by itself. */
export const ADVANCE_DELAY_MS = 1200;

type ScreenId = 'welcome' | 'repo' | 'join' | 'machine' | 'claude' | 'mcp' | 'done';
type Path = 'own' | 'join';

const TITLES: Record<ScreenId, string> = {
  welcome: 'Welcome to orch',
  repo: 'Add your repository',
  join: 'Join a project',
  machine: 'Install your machine',
  claude: 'Connect Claude on your machine',
  mcp: 'Connect Claude Code (MCP)',
  done: "You're all set",
};

const SUMMARY: [OnboardingStepId, string][] = [
  ['github_app_installed', 'GitHub App installed'],
  ['project_added', 'Project added or joined'],
  ['participation_set', 'Participation set'],
  ['agent_connected', 'Machine connected'],
  ['claude_connected', 'Claude connected on your machine'],
  ['mcp_connected', 'Claude Code connected (MCP)'],
];

function Status({
  done,
  waiting,
  children,
}: {
  done: boolean;
  waiting: string;
  children: ReactNode;
}) {
  return (
    <p className={`wizard-status ${done ? 'ok' : ''}`} role="status" aria-live="polite">
      {done ? (
        <>
          <span aria-hidden="true">✓</span> {children}
        </>
      ) : (
        <>
          <span className="spinner" aria-hidden="true" /> {waiting}
        </>
      )}
    </p>
  );
}

function RepoScreen({ done }: { done: boolean }) {
  return done ? (
    <p className="wizard-status ok" role="status" aria-live="polite">
      <span aria-hidden="true">✓</span> You already have a repository in orch.
    </p>
  ) : (
    <>
      <RepoPicker onAdded={() => undefined} pollMs={POLL_MS} />
      <p className="hint" role="status" aria-live="polite">
        Waiting for repositories to appear. This page checks every few seconds.
      </p>
    </>
  );
}

function JoinScreen() {
  const q = useQuery({
    queryKey: ['projects', 'discover'],
    queryFn: fetchDiscover,
    refetchInterval: POLL_MS,
  });
  const items = q.data ?? [];
  const pending = items.some((i) => i.myParticipation?.status === 'pending');
  return (
    <>
      {q.isPending && <p className="hint">Loading...</p>}
      {q.error && <p className="error">{q.error.message}</p>}
      {q.isSuccess && items.length === 0 && (
        <p className="hint">
          No project to join yet. Ask a teammate to add their repository and give you access.
        </p>
      )}
      {items.map((item) => (
        <article className="card" key={item.project.id} aria-label={item.project.fullName}>
          <h2>{item.project.fullName}</h2>
          <p className="hint">owner: {item.owner.githubLogin}</p>
          <ParticipationForm key={item.myParticipation?.id ?? 'new'} item={item} />
        </article>
      ))}
      {pending && (
        <p className="hint" role="status" aria-live="polite">
          Waiting for the owner&apos;s approval. You can carry on, nothing is blocked.
        </p>
      )}
    </>
  );
}

function MachineScreen({ done }: { done: boolean }) {
  const agents = useQuery({
    queryKey: ['agents', 'mine'],
    queryFn: fetchMyAgents,
    refetchInterval: POLL_MS,
  });
  const live = (agents.data ?? []).filter((a) => !a.revokedAt);
  const machine = (live.find((a) => a.connected) ?? live[0])?.machineName;
  return (
    <>
      <InstallCommandBlock big />
      <p className="hint">Run this on the machine where you develop (it needs Docker).</p>
      <Status done={done} waiting="Waiting for your machine to connect…">
        Connected{machine ? `: ${machine}` : ''}
      </Status>
    </>
  );
}

function ClaudeScreen({ done, machineUp }: { done: boolean; machineUp: boolean }) {
  return (
    <>
      <p>
        At the end of the install you were asked to connect Claude. If you skipped it, run this on
        your machine:
      </p>
      <pre className="code">{LOGIN_COMMAND}</pre>
      <div className="row">
        <CopyButton text={LOGIN_COMMAND} big />
      </div>
      {!machineUp && !done && (
        <p className="hint">Your machine is not connected yet (previous step).</p>
      )}
      <Status done={done} waiting="Waiting for Claude to be connected…">
        Claude is connected on your machine
      </Status>
    </>
  );
}

function McpScreen({ done }: { done: boolean }) {
  return (
    <>
      <McpCommand big />
      <p>
        Then, in Claude Code, type <code>/mcp</code> → <code>orch</code> → Authenticate.
      </p>
      <Status done={done} waiting="Waiting for Claude Code to connect…">
        Claude Code is connected
      </Status>
      <p className="hint">Then try a prompt such as:</p>
      <blockquote className="wizard-prompt">
        Split this feature into small tasks and send them to the orch pool
      </blockquote>
    </>
  );
}

function DoneScreen({ states }: { states: Map<OnboardingStepId, boolean> }) {
  return (
    <>
      <ul className="plain wizard-summary">
        {SUMMARY.map(([id, label]) => (
          <li key={id}>
            <span
              role="img"
              aria-label={states.get(id) ? 'Done' : 'Not done'}
              className={states.get(id) ? 'ok' : ''}
            >
              {states.get(id) ? '✓' : '○'}
            </span>{' '}
            {label}
          </li>
        ))}
      </ul>
      <p className="row">
        <Link className="btn primary" to="/backlog">
          Backlog
        </Link>
        <Link className="btn" to="/pool">
          Pool
        </Link>
        <Link className="btn" to="/projects">
          Projects
        </Link>
      </p>
      <h2>Cheat sheet</h2>
      <ul className="plain">
        <li>
          <code>orch status</code>: check your agent
        </li>
        <li>
          <code>orch take &lt;n&gt;</code>: take task n
        </li>
        <li>
          <code>orch attach &lt;n&gt;</code>: watch or join task n
        </li>
        <li>
          <code>orch done &lt;n&gt;</code>: finish task n
        </li>
      </ul>
    </>
  );
}

export function Welcome() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe().data;
  const [path, setPath] = useState<Path>('own');
  const [index, setIndex] = useState(0);
  const order: ScreenId[] = useMemo(
    () =>
      path === 'own'
        ? ['welcome', 'repo', 'join', 'machine', 'claude', 'mcp', 'done']
        : ['welcome', 'join', 'repo', 'machine', 'claude', 'mcp', 'done'],
    [path],
  );
  const screen = order[index]!;
  const onboarding = useOnboarding(screen === 'welcome' || screen === 'done' ? 15_000 : POLL_MS);
  const mine = useQuery({ queryKey: ['projects', 'mine'], queryFn: fetchMyProjects });

  const states = useMemo(() => {
    const m = new Map<OnboardingStepId, boolean>();
    for (const s of onboarding.data?.steps ?? []) m.set(s.id, s.done);
    return m;
  }, [onboarding.data]);
  const ownsRepo = !!me && (mine.data ?? []).some((p) => p.ownerId === me.id);
  const doneByScreen: Record<ScreenId, boolean> = {
    welcome: false,
    repo: ownsRepo,
    join: states.get('participation_set') === true,
    machine: states.get('agent_connected') === true,
    claude: states.get('claude_connected') === true,
    mcp: states.get('mcp_connected') === true,
    done: false,
  };
  const done = doneByScreen[screen];
  const loaded = onboarding.isSuccess && mine.isSuccess;

  // Auto-advance when the current step flips from todo to done while the user is on it.
  const wasDone = useRef<{ screen: ScreenId; done: boolean } | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const prev = wasDone.current;
    wasDone.current = { screen, done };
    if (screen === 'welcome' || screen === 'done') return;
    if (!prev || prev.screen !== screen || prev.done || !done) return;
    const t = setTimeout(
      () => setIndex((i) => Math.min(i + 1, order.length - 1)),
      ADVANCE_DELAY_MS,
    );
    return () => clearTimeout(t);
  }, [screen, done, loaded, order.length]);

  // Focus the title on each step change (first render included: the page just opened).
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, [screen]);

  const complete = useMutation({
    mutationFn: completeOnboarding,
    onSuccess: (u) => qc.setQueryData(['me'], u),
  });
  const exit = useMutation({
    mutationFn: dismissOnboarding,
    onSuccess: (u) => qc.setQueryData(['me'], u),
    onSettled: () => navigate('/projects'),
  });
  const completedAt = me?.onboardingCompletedAt;
  const completeNow = complete.mutate;
  useEffect(() => {
    if (screen === 'done' && me && !completedAt) completeNow();
  }, [screen, me, completedAt, completeNow]);

  const next = () => setIndex((i) => Math.min(i + 1, order.length - 1));
  const back = () => setIndex((i) => Math.max(i - 1, 0));
  const choose = (p: Path) => {
    setPath(p);
    setIndex(1);
  };
  const last = index === order.length - 1;

  const explain: Record<ScreenId, string> = {
    welcome:
      'orch shares a to-do list between teammates; each of you runs tasks on your own machine with your own Claude subscription.',
    repo: 'Install the orch GitHub App on your repository, then pick it. It joins the shared to-do list.',
    join: 'Pick a teammate’s project and choose how much of your Claude capacity you lend to it.',
    machine:
      'The agent runs tasks on the machine that has your Claude subscription. Generate your install command and run it there.',
    claude: 'Sign in to Claude once on that machine so tasks can run with your subscription.',
    mcp: 'Let Claude Code view the pool and send tasks to it through orch.',
    done: 'Here is what is set up, and a few commands you will use every day.',
  };

  return (
    <div className="wizard">
      <header className="wizard-top">
        <strong>orch</strong>
        <button onClick={() => exit.mutate()} disabled={exit.isPending}>
          Exit setup
        </button>
      </header>
      <main className="wizard-main">
        <div
          className="wizard-progress"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={order.length}
          aria-valuenow={index + 1}
          aria-valuetext={`Step ${index + 1} of ${order.length}`}
        >
          <div style={{ width: `${((index + 1) / order.length) * 100}%` }} />
        </div>
        <p className="hint">
          Step {index + 1} of {order.length}
        </p>
        <h1 ref={title} tabIndex={-1}>
          {TITLES[screen]}
        </h1>
        <p>{explain[screen]}</p>
        {screen === 'join' && done && (
          <p className="wizard-status ok" role="status">
            <span aria-hidden="true">✓</span> Already done. You can continue.
          </p>
        )}

        {screen === 'welcome' && (
          <div className="wizard-choice">
            <button className="primary big" onClick={() => choose('own')}>
              I want to add my own repository
            </button>
            <button className="big" onClick={() => choose('join')}>
              I&apos;m joining a teammate&apos;s project
            </button>
            <p className="hint">You can do both later.</p>
          </div>
        )}
        {screen === 'repo' && <RepoScreen done={done} />}
        {screen === 'join' && <JoinScreen />}
        {screen === 'machine' && <MachineScreen done={done} />}
        {screen === 'claude' && (
          <ClaudeScreen done={done} machineUp={states.get('agent_connected') === true} />
        )}
        {screen === 'mcp' && <McpScreen done={done} />}
        {screen === 'done' && <DoneScreen states={states} />}

        <nav className="wizard-nav" aria-label="Wizard navigation">
          <button onClick={back} disabled={index === 0}>
            Back
          </button>
          {screen !== 'welcome' && !last && (
            <>
              <button onClick={next}>Skip for now</button>
              {done && (
                <button className="primary" onClick={next}>
                  Continue
                </button>
              )}
            </>
          )}
          {last && (
            <button className="primary" onClick={() => navigate('/projects')}>
              Finish
            </button>
          )}
        </nav>
      </main>
      <VersionFooter />
    </div>
  );
}
