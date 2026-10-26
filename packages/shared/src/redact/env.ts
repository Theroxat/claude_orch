/**
 * Which environment values (devcontainer `containerEnv`, build args, compose `environment` and
 * `env_file` values of the sidecars) are treated as known secrets of a run.
 */
import { MIN_SECRET_LEN } from './known';
import { shannonEntropy } from './patterns';

const SECRET_KEY_RE = /secret|token|passw|pwd|key|credential|auth|private|dsn|salt|cookie|session/i;

/** Values that are common configuration, never masked whatever their key says. */
const COMMON = new Set([
  'development',
  'production',
  'staging',
  'localhost',
  'postgres',
  'postgresql',
  'password',
  'changeme',
  'example',
  'secret',
  'default',
  'disabled',
  'enabled',
  'true',
  'false',
  'admin',
  'root',
  'redis',
  'mysql',
  'mongodb',
  'test',
  'testing',
  'debug',
  'info',
  'warning',
  'error',
  'utf-8',
  'utf8',
  'en_US.UTF-8',
  'C.UTF-8',
]);

/**
 * Whether `value` (of the env variable `key`) is masked as a known secret:
 * - 8+ characters, not a common word, not a number / version, not a path;
 * - a URL: only its password part (`scheme://user:PASS@host`), returned separately;
 * - with a secret-looking key (`*_TOKEN`, `*PASSWORD*`, `*_KEY`, `*_DSN`...): any other value;
 * - otherwise only random-looking values (12+ chars, entropy >= 3.5 bits/char, letters and
 *   digits), so `NODE_ENV=production` or `DB_HOST=db.internal` stay readable.
 */
export function envSecretValues(key: string, value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const v = value.trim();
  if (v.length < MIN_SECRET_LEN) return [];
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:([^/\s@]+)@/i.exec(v);
  if (url) return url[1] && url[1].length >= MIN_SECRET_LEN ? [url[1]] : [];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return [];
  if (COMMON.has(v) || COMMON.has(v.toLowerCase())) return [];
  if (/^[\d.,:_\s-]+$/.test(v) || /^v?\d+(?:\.\d+)+\S*$/.test(v)) return [];
  if (/^(?:\/|\.\.?\/|~\/)/.test(v)) return [];
  if (SECRET_KEY_RE.test(key)) return [v];
  if (v.length >= 12 && shannonEntropy(v) >= 3.5 && /[A-Za-z]/.test(v) && /\d/.test(v)) return [v];
  return [];
}

/** Secret values of an env map (`{ KEY: value }`) or list (`["KEY=value", ...]`). */
export function envSecrets(env: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(env)) {
    for (const e of env) {
      if (typeof e !== 'string') continue;
      const i = e.indexOf('=');
      if (i > 0) out.push(...envSecretValues(e.slice(0, i), e.slice(i + 1)));
    }
  } else if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      out.push(...envSecretValues(k, v));
    }
  }
  return out;
}

/**
 * Secret values of a resolved compose model (`docker compose config --format json`): every
 * service's `environment` (which includes its `env_file` values once resolved) and build args.
 */
export function composeSecrets(model: unknown): string[] {
  const out: string[] = [];
  const services = (model as { services?: unknown } | null)?.services;
  if (!services || typeof services !== 'object') return out;
  for (const svc of Object.values(services as Record<string, unknown>)) {
    if (!svc || typeof svc !== 'object') continue;
    const s = svc as { environment?: unknown; build?: { args?: unknown } };
    out.push(...envSecrets(s.environment));
    if (s.build && typeof s.build === 'object') out.push(...envSecrets(s.build.args));
  }
  return out;
}
