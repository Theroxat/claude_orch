import { lazy, type ComponentType } from 'react';

type Loader = () => Promise<ComponentType>;
type Page = { load: Loader; Component: ComponentType };

/**
 * A code-split page. `load` is memoized, so hovering a link warms the chunk; once the chunk
 * is in, the page renders directly instead of suspending for a frame.
 */
function page<M>(importer: () => Promise<M>, pick: (m: M) => ComponentType): Page {
  let pending: Promise<ComponentType> | null = null;
  let ready: ComponentType | null = null;
  const load: Loader = () =>
    (pending ??= importer().then((m) => {
      ready = pick(m);
      return ready;
    }));
  const Lazy = lazy(() => load().then((C) => ({ default: C })));
  function Component() {
    const C = ready;
    return C ? <C /> : <Lazy />;
  }
  return { load, Component };
}

const table = {
  '/projects': page(
    () => import('./pages/Projects'),
    (m) => m.Projects,
  ),
  '/discover': page(
    () => import('./pages/Discover'),
    (m) => m.Discover,
  ),
  '/pool': page(
    () => import('./pages/Pool'),
    (m) => m.Pool,
  ),
  '/requests': page(
    () => import('./pages/Requests'),
    (m) => m.Requests,
  ),
  '/backlog': page(
    () => import('./pages/Backlog'),
    (m) => m.Backlog,
  ),
  '/claude-code': page(
    () => import('./pages/ClaudeCode'),
    (m) => m.ClaudeCode,
  ),
  '/my-server': page(
    () => import('./pages/MyServer'),
    (m) => m.MyServer,
  ),
  '/admin/access': page(
    () => import('./pages/AdminAccess'),
    (m) => m.AdminAccess,
  ),
  '/welcome': page(
    () => import('./pages/Welcome'),
    (m) => m.Welcome,
  ),
  '/login': page(
    () => import('./pages/Login'),
    (m) => m.Login,
  ),
  '/confirm-email': page(
    () => import('./pages/ConfirmEmail'),
    (m) => m.ConfirmEmail,
  ),
  '/oauth/consent': page(
    () => import('./pages/OAuthConsent'),
    (m) => m.OAuthConsent,
  ),
};

export type PagePath = keyof typeof table;

export const pages = Object.fromEntries(
  Object.entries(table).map(([path, p]) => [path, p.Component]),
) as Record<PagePath, ComponentType>;

export const loaders = Object.fromEntries(
  Object.entries(table).map(([path, p]) => [path, p.load]),
) as Record<PagePath, Loader>;

export function preload(path: string) {
  if (path in table) void table[path as PagePath].load().catch(() => undefined);
}
