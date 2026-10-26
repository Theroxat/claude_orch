import { Suspense, ViewTransition, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { dismissOnboarding, fetchPendingCount, pushUnsubscribe } from '../api/endpoints';
import { useOffers } from '../api/offers';
import { useMe, useResetSession } from '../auth';
import { dropBrowserSubscription } from '../push/browser';
import { preload } from '../routes';
import { Brand } from '../ui/Brand';
import { Icon } from '../ui/Icon';
import { motionAllowed } from '../ui/motion';
import { PageFallback } from '../ui/PageFallback';
import { useChangeCount } from '../ui/presence';
import { useTheme } from '../ui/theme';
import { useT, type MessageKey } from '../i18n/index.ts';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';
import { NotificationBell } from './NotificationBell';
import { AgentUpdateBanner } from './AgentUpdateBanner';
import { useOnboarding } from './GettingStarted';
import { VersionFooter } from './VersionFooter';

const DOCS_URL = 'https://claude-orch.readthedocs.io';
const REPO_URL = 'https://github.com/Theroxat/claude_orch';

const links: { to: string; label: MessageKey }[] = [
  { to: '/projects', label: 'layout.nav.projects' },
  { to: '/discover', label: 'layout.nav.discover' },
  { to: '/pool', label: 'layout.nav.pool' },
  { to: '/requests', label: 'layout.nav.requests' },
  { to: '/backlog', label: 'layout.nav.backlog' },
  { to: '/history', label: 'layout.nav.history' },
  { to: '/usage', label: 'layout.nav.usage' },
  { to: '/claude-code', label: 'layout.nav.claudeCode' },
  { to: '/my-server', label: 'layout.nav.myServer' },
];
const ACCESS_LINK = { to: '/admin/access', label: 'layout.nav.access' } as const;

/** Count bubble on a station; replays a short pulse when the number changes. */
function Count({ n, label }: { n: number; label: string }) {
  const changes = useChangeCount(n);
  return (
    <span
      key={changes}
      className="nav-badge"
      data-changed={changes > 0 || undefined}
      aria-label={label}
    >
      {n}
    </span>
  );
}

export function Layout() {
  const t = useT();
  const me = useMe().data;
  const pending = useOffers().data?.length ?? 0;
  const isAdmin = !!me?.isAdmin;
  const accessPending =
    useQuery({
      queryKey: ['admin', 'pending-count'],
      queryFn: fetchPendingCount,
      enabled: isAdmin,
      refetchInterval: 30_000,
    }).data?.count ?? 0;
  const onboarding = useOnboarding().data?.steps;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const reset = useResetSession();
  const qc = useQueryClient();
  const redirected = useRef(false);
  const [theme, toggleTheme] = useTheme();
  // The shell draws itself once per load; later navigations only move the page.
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setBooting(false), 1600);
    return () => clearTimeout(t);
  }, []);
  // Keep the current station in view when the line scrolls (narrow screens).
  const line = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = line.current;
    const current = nav?.querySelector<HTMLElement>('.station.active');
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    const left = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
    nav.scrollTo?.({ left, behavior: motionAllowed() ? 'smooth' : 'auto' });
  }, [pathname]);
  const incomplete = !!onboarding && onboarding.some((x) => !x.done);
  // First visit only: send a member with unfinished onboarding to the wizard once. The server
  // remembers it (dismissedAt), so a reload or another browser does not redirect again.
  useEffect(() => {
    if (redirected.current || !me || !incomplete) return;
    if (me.onboardingCompletedAt || me.onboardingDismissedAt) return;
    redirected.current = true;
    navigate('/welcome', { replace: true });
    void dismissOnboarding()
      .then((u) => qc.setQueryData(['me'], u))
      .catch(() => undefined);
  }, [me, incomplete, navigate, qc]);
  const logout = useMutation({
    mutationFn: async () => {
      await dropBrowserSubscription(pushUnsubscribe);
      return api<unknown>('POST', '/auth/logout');
    },
    onSuccess: () => {
      reset();
      navigate('/login', { replace: true });
    },
  });
  const nav = isAdmin ? [...links, ACCESS_LINK] : links;
  const doneSteps = onboarding?.filter((x) => x.done).length ?? 0;
  return (
    <div className={`shell${booting ? ' booting' : ''}`}>
      <header className="topbar">
        <div className="topbar-row">
          <Link to="/projects" className="brand-link" aria-label={t('layout.header.home')}>
            <Brand />
          </Link>
          <div className="topbar-tools">
            {incomplete && (
              <NavLink
                to="/welcome"
                className="progress-pill"
                onMouseEnter={() => preload('/welcome')}
              >
                {t('layout.header.setupWizard')}
              </NavLink>
            )}
            {onboarding && (
              <NavLink
                to="/projects"
                className="progress-pill"
                aria-label={t('layout.header.gettingStarted', {
                  count: doneSteps,
                  total: onboarding.length,
                })}
                style={{ '--done': doneSteps / Math.max(1, onboarding.length) } as CSSProperties}
              >
                <span className="pill-meter" aria-hidden="true" />
                {doneSteps}/{onboarding.length}
              </NavLink>
            )}
            <a
              className="btn ghost icon-button"
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('layout.header.docs')}
              title={t('layout.header.docs')}
            >
              <Icon name="book" />
            </a>
            <a
              className="btn ghost icon-button"
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('layout.header.repo')}
              title={t('layout.header.repo')}
            >
              <Icon name="github" />
            </a>
            <NotificationBell />
            <button
              type="button"
              className="ghost icon-button"
              onClick={toggleTheme}
              aria-label={t(theme === 'dark' ? 'layout.theme.toLight' : 'layout.theme.toDark')}
              title={t(theme === 'dark' ? 'layout.theme.light' : 'layout.theme.dark')}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <LanguageSwitcher />
            {me && (
              <div className="user">
                {me.avatarUrl ? (
                  <img className="avatar" src={me.avatarUrl} alt={me.githubLogin} />
                ) : (
                  <span className="avatar" data-initial={me.githubLogin.slice(0, 1)} />
                )}
                <span className="user-name">{me.name ?? me.githubLogin}</span>
                <button
                  type="button"
                  className="ghost logout-button"
                  onClick={() => logout.mutate()}
                  title={t('layout.header.logOut')}
                >
                  <Icon name="logout" />
                  <span className="logout-label">{t('layout.header.logOut')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
        <nav className="line" aria-label={t('layout.nav.label')} ref={line}>
          {nav.map((l, i) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) => `station${isActive ? ' active' : ''}`}
              style={{ '--i': i } as CSSProperties}
              onMouseEnter={() => preload(l.to)}
              onFocus={() => preload(l.to)}
            >
              <span className="stop" aria-hidden="true" />
              <span className="station-name">
                {t(l.label)}
                {l.to === '/requests' && pending > 0 && (
                  <Count n={pending} label={t('layout.nav.pendingRequests', { count: pending })} />
                )}
                {l.to === '/admin/access' && accessPending > 0 && (
                  <Count
                    n={accessPending}
                    label={t('layout.nav.pendingAccess', { count: accessPending })}
                  />
                )}
              </span>
            </NavLink>
          ))}
        </nav>
      </header>
      <AgentUpdateBanner />
      <main className="page">
        <ViewTransition key={pathname} enter="page-in" exit="page-out" default="none">
          <div className="page-body">
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </div>
        </ViewTransition>
      </main>
      <VersionFooter />
    </div>
  );
}
