/** Same rules as the server's `safeNextPath`: a same-origin relative path, nothing else. */
export function safeReturnPath(next: unknown): string | null {
  if (typeof next !== 'string' || next.length > 4000) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  for (const ch of next) if (ch.charCodeAt(0) < 0x20 || ch === '\\') return null;
  // Coming back to the sign-in page would loop.
  if (next === '/login' || next.startsWith('/login?') || next.startsWith('/login#')) return null;
  return next;
}

/** Login URL that remembers where the user was heading. */
export function loginPathFor(location: { pathname: string; search: string; hash: string }) {
  const next = safeReturnPath(location.pathname + location.search + location.hash);
  // Landing on "/" is the default anyway.
  return next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login';
}
