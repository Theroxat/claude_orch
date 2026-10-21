import { NavLink, Outlet } from 'react-router-dom';

const links = [
  { to: '/projects', label: 'My projects' },
  { to: '/discover', label: 'Discover' },
  { to: '/pool', label: 'Pool' },
  { to: '/backlog', label: 'Backlog' },
  { to: '/my-server', label: 'My server' },
];

export function Layout() {
  return (
    <div>
      <header>
        <strong>orch</strong>
        <nav>
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} style={{ marginLeft: 16 }}>
              {l.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
