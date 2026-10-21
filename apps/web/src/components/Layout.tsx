import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useOffers } from '../pages/Requests';
import { useMe, useResetSession } from '../auth';

const links = [
  { to: '/projects', label: 'Projects' },
  { to: '/discover', label: 'Discover' },
  { to: '/pool', label: 'Pool' },
  { to: '/requests', label: 'Requests' },
  { to: '/backlog', label: 'Backlog' },
  { to: '/my-server', label: 'My Server' },
];

export function Layout() {
  const me = useMe().data;
  const pending = useOffers().data?.length ?? 0;
  const navigate = useNavigate();
  const reset = useResetSession();
  const logout = useMutation({
    mutationFn: () => api<unknown>('POST', '/auth/logout'),
    onSuccess: () => {
      reset();
      navigate('/login', { replace: true });
    },
  });
  return (
    <div>
      <header className="topbar">
        <strong>orch</strong>
        <nav>
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {l.label}
              {l.to === '/requests' && pending > 0 && (
                <span className="nav-badge" aria-label={`${pending} pending requests`}>
                  {pending}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        {me && (
          <div className="user">
            {me.avatarUrl ? (
              <img className="avatar" src={me.avatarUrl} alt={me.githubLogin} />
            ) : (
              <span className="avatar" />
            )}
            <span>{me.name ?? me.githubLogin}</span>
            <button onClick={() => logout.mutate()}>Log out</button>
          </div>
        )}
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
