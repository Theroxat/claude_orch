import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnboardingStepId } from '@orch/shared';
import {
  ViewTransition,
  addTransitionType,
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import {
  completeOnboarding,
  dismissOnboarding,
  fetchDiscover,
  fetchMyAgents,
  fetchMyProjects,
} from '../api/endpoints';
import { useMe, useResetSession } from '../auth';
import { RepoPicker } from '../components/AddRepoDialog';
import { CopyButton } from '../components/CopyButton';
import { useOnboarding } from '../components/GettingStarted';
import { InstallCommandBlock, LOGIN_COMMAND } from '../components/InstallAgentCard';
import { McpCommand } from '../components/McpCommand';
import { OwnerParticipation } from '../components/OwnerParticipation';
import { ParticipationForm } from '../components/ParticipationForm';
import { VersionFooter } from '../components/VersionFooter';
import { errorMessage } from '../i18n/errors.ts';
import { useRich, useT, type MessageKey } from '../i18n/index.ts';
import { Brand } from '../ui/Brand';

/** Step changes slide in the direction of travel (a view transition when supported). */
function go(direction: 'forward' | 'back', update: () => void) {
  startTransition(() => {
    addTransitionType(direction);
    update();
  });
}

/** Server state is polled this often while a step is waiting for the user. */
export const POLL_MS = 3000;
/** Pause on the green check before moving on by itself. */
export const ADVANCE_DELAY_MS = 1200;

type ScreenId = 'welcome' | 'repo' | 'join' | 'machine' | 'claude' | 'mcp' | 'done';
type Path = 'own' | 'join';

const TITLES = {
  welcome: 'welcome.wizard.title.welcome',
  repo: 'welcome.wizard.title.repo',
  join: 'welcome.wizard.title.join',
  machine: 'welcome.wizard.title.machine',
  claude: 'welcome.wizard.title.claude',
  mcp: 'welcome.wizard.title.mcp',
  done: 'welcome.wizard.title.done',
} as const satisfies Record<ScreenId, MessageKey>;

const EXPLAIN = {
  welcome: 'welcome.wizard.explain.welcome',
  repo: 'welcome.wizard.explain.repo',
  join: 'welcome.wizard.explain.join',
  machine: 'welcome.wizard.explain.machine',
  claude: 'welcome.wizard.explain.claude',
  mcp: 'welcome.wizard.explain.mcp',
  done: 'welcome.wizard.explain.done',
} as const satisfies Record<ScreenId, MessageKey>;

const SUMMARY = [
  ['github_app_installed', 'welcome.wizard.summary.github_app_installed'],
  ['project_added', 'welcome.wizard.summary.project_added'],
  ['participation_set', 'welcome.wizard.summary.participation_set'],
  ['agent_connected', 'welcome.wizard.summary.agent_connected'],
  ['claude_connected', 'welcome.wizard.summary.claude_connected'],
  ['mcp_connected', 'welcome.wizard.summary.mcp_connected'],
] as const satisfies readonly (readonly [OnboardingStepId, MessageKey])[];

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
  const t = useT();
  const mine = useQuery({
    queryKey: ['projects', 'mine'],
    queryFn: fetchMyProjects,
    enabled: done,
  });
  const first = mine.data?.[0];
  return done ? (
    <>
      <p className="wizard-status ok" role="status" aria-live="polite">
        <span aria-hidden="true">✓</span> {t('welcome.wizard.repo.already')}
      </p>
      {first && (
        <OwnerParticipation
          project={first}
          title={t('welcome.wizard.repo.lend', { name: first.fullName })}
        />
      )}
    </>
  ) : (
    <>
      <RepoPicker onAdded={() => undefined} pollMs={POLL_MS} />
      <p className="hint" role="status" aria-live="polite">
        {t('welcome.wizard.repo.waiting')}
      </p>
    </>
  );
}

function JoinScreen() {
  const t = useT();
  const q = useQuery({
    queryKey: ['projects', 'discover'],
    queryFn: fetchDiscover,
    refetchInterval: POLL_MS,
  });
  const items = q.data ?? [];
  const pending = items.some((i) => i.myParticipation?.status === 'pending');
  return (
    <>
      {q.isPending && <p className="hint">{t('common.status.loading')}</p>}
      {q.error && <p className="error">{errorMessage(q.error)}</p>}
      {q.isSuccess && items.length === 0 && <p className="hint">{t('welcome.wizard.join.none')}</p>}
      {items.map((item) => (
        <article className="card" key={item.project.id} aria-label={item.project.fullName}>
          <h2>{item.project.fullName}</h2>
          <p className="hint">
            {t('welcome.wizard.join.owner', { login: item.owner.githubLogin })}
          </p>
          <ParticipationForm key={item.myParticipation?.id ?? 'new'} item={item} />
        </article>
      ))}
      {pending && (
        <p className="hint" role="status" aria-live="polite">
          {t('welcome.wizard.join.waitingApproval')}
        </p>
      )}
    </>
  );
}

function MachineScreen({ done }: { done: boolean }) {
  const t = useT();
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
      <p className="hint">{t('welcome.wizard.machine.hint')}</p>
      <Status done={done} waiting={t('welcome.wizard.machine.waiting')}>
        {machine
          ? t('welcome.wizard.machine.connectedNamed', { name: machine })
          : t('welcome.wizard.machine.connected')}
      </Status>
    </>
  );
}

function ClaudeScreen({ done, machineUp }: { done: boolean; machineUp: boolean }) {
  const t = useT();
  return (
    <>
      <p>{t('welcome.wizard.claude.intro')}</p>
      <pre className="code">{LOGIN_COMMAND}</pre>
      <div className="row">
        <CopyButton text={LOGIN_COMMAND} big />
      </div>
      {!machineUp && !done && <p className="hint">{t('welcome.wizard.claude.machineDown')}</p>}
      <Status done={done} waiting={t('welcome.wizard.claude.waiting')}>
        {t('welcome.wizard.claude.connected')}
      </Status>
    </>
  );
}

function McpScreen({ done }: { done: boolean }) {
  const t = useT();
  const rich = useRich();
  return (
    <>
      <McpCommand big />
      <p>{rich('welcome.wizard.mcp.then', { code: (c) => <code>{c}</code> })}</p>
      <Status done={done} waiting={t('welcome.wizard.mcp.waiting')}>
        {t('welcome.wizard.mcp.connected')}
      </Status>
      <p className="hint">{t('welcome.wizard.mcp.tryPrompt')}</p>
      <blockquote className="wizard-prompt">{t('welcome.wizard.mcp.prompt')}</blockquote>
    </>
  );
}

function DoneScreen({ states }: { states: Map<OnboardingStepId, boolean> }) {
  const t = useT();
  const rich = useRich();
  const code = (c: ReactNode) => <code>{c}</code>;
  const n = '<n>';
  return (
    <>
      <ul className="plain wizard-summary">
        {SUMMARY.map(([id, label]) => (
          <li key={id}>
            <span
              role="img"
              aria-label={
                states.get(id)
                  ? t('welcome.wizard.done.stepDone')
                  : t('welcome.wizard.done.stepNotDone')
              }
              className={states.get(id) ? 'ok' : ''}
            >
              {states.get(id) ? '✓' : '○'}
            </span>{' '}
            {t(label)}
          </li>
        ))}
      </ul>
      <p className="row">
        <Link className="btn primary" to="/backlog">
          {t('welcome.wizard.done.backlog')}
        </Link>
        <Link className="btn" to="/pool">
          {t('welcome.wizard.done.pool')}
        </Link>
        <Link className="btn" to="/projects">
          {t('welcome.wizard.done.projects')}
        </Link>
      </p>
      <h2>{t('welcome.wizard.done.cheatSheet')}</h2>
      <ul className="plain">
        <li>{rich('welcome.wizard.done.status', { code })}</li>
        <li>{rich('welcome.wizard.done.take', { code }, { n })}</li>
        <li>{rich('welcome.wizard.done.attach', { code }, { n })}</li>
        <li>{rich('welcome.wizard.done.finish', { code }, { n })}</li>
      </ul>
    </>
  );
}

export function Welcome() {
  const t = useT();
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
      () => go('forward', () => setIndex((i) => Math.min(i + 1, order.length - 1))),
      ADVANCE_DELAY_MS,
    );
    return () => clearTimeout(t);
  }, [screen, done, loaded, order.length]);

  // Focus the title on each step change (first render included: the page just opened).
  // Layout effect, not a passive one: inside a <ViewTransition> React defers useEffect until the
  // step animation has finished (~500 ms) although the new step is already live and focusable, so
  // a keyboard user tabbing in that window had focus yanked back to the title.
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
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
  const reset = useResetSession();
  const logout = useMutation({
    mutationFn: () => api<unknown>('POST', '/auth/logout'),
    onSuccess: () => {
      reset();
      navigate('/login', { replace: true });
    },
  });
  const completedAt = me?.onboardingCompletedAt;
  const completeNow = complete.mutate;
  useEffect(() => {
    if (screen === 'done' && me && !completedAt) completeNow();
  }, [screen, me, completedAt, completeNow]);

  const next = () => go('forward', () => setIndex((i) => Math.min(i + 1, order.length - 1)));
  const back = () => go('back', () => setIndex((i) => Math.max(i - 1, 0)));
  const choose = (p: Path) =>
    go('forward', () => {
      setPath(p);
      setIndex(1);
    });
  const last = index === order.length - 1;

  return (
    <div className="wizard">
      <header className="wizard-top">
        <Brand />
        <div className="wizard-actions">
          <button className="ghost" onClick={() => exit.mutate()} disabled={exit.isPending}>
            {t('welcome.wizard.exit')}
          </button>
          <button className="ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
            {t('welcome.wizard.logout')}
          </button>
        </div>
      </header>
      <main className="wizard-main">
        <div
          className="wizard-progress"
          role="progressbar"
          aria-label={t('welcome.wizard.progress')}
          aria-valuemin={1}
          aria-valuemax={order.length}
          aria-valuenow={index + 1}
          aria-valuetext={t('welcome.wizard.stepText', { step: index + 1, total: order.length })}
          style={{ '--steps': order.length } as CSSProperties}
        >
          <div style={{ width: `${((index + 1) / order.length) * 100}%` }} />
        </div>
        <p className="wizard-step">
          {t('welcome.wizard.stepText', { step: index + 1, total: order.length })}
        </p>
        <ViewTransition
          key={screen}
          enter={{ forward: 'step-in-forward', back: 'step-in-back', default: 'none' }}
          exit={{ forward: 'step-out-forward', back: 'step-out-back', default: 'none' }}
          default="none"
        >
          <div className="wizard-screen">
            <h1 ref={title} tabIndex={-1}>
              {t(TITLES[screen])}
            </h1>
            <p className="wizard-explain">{t(EXPLAIN[screen])}</p>
            {screen === 'join' && done && (
              <p className="wizard-status ok" role="status">
                <span aria-hidden="true">✓</span> {t('welcome.wizard.alreadyDone')}
              </p>
            )}

            {screen === 'welcome' && (
              <div className="wizard-choice">
                <button className="primary big" onClick={() => choose('own')}>
                  {t('welcome.wizard.chooseOwn')}
                </button>
                <button className="big" onClick={() => choose('join')}>
                  {t('welcome.wizard.chooseJoin')}
                </button>
                <p className="hint">{t('welcome.wizard.both')}</p>
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
          </div>
        </ViewTransition>

        <nav className="wizard-nav" aria-label={t('welcome.wizard.nav')}>
          <button onClick={back} disabled={index === 0}>
            {t('welcome.wizard.back')}
          </button>
          <span className="spacer" />
          {screen !== 'welcome' && !last && (
            <>
              <button onClick={next}>{t('welcome.wizard.skip')}</button>
              {done && (
                <button className="primary" onClick={next}>
                  {t('welcome.wizard.continue')}
                </button>
              )}
            </>
          )}
          {last && (
            <button className="primary" onClick={() => navigate('/projects')}>
              {t('welcome.wizard.finish')}
            </button>
          )}
        </nav>
      </main>
      <VersionFooter />
    </div>
  );
}
