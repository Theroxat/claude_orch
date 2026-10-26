import { z } from 'zod';
import { DEFAULT_AGENT_IMAGE_REPO, IMAGE_REPO_RE } from '@orch/shared';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

/** Comma-separated list -> trimmed, lower-cased, non-empty entries. */
const csvLower = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ORCH_BASE_URL: z.url().default('http://localhost:8470'),
  /**
   * Public URL users and agents reach orch at (for example https://orch.selfhostr.io). When set it
   * wins over ORCH_BASE_URL. Behind Cloudflare Tunnel the request reaches the server over plain
   * HTTP, so OAuth callbacks, install commands and the Secure cookie flag derive from this value.
   */
  ORCH_PUBLIC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  /**
   * Which peers may set X-Forwarded-* headers (Fastify trustProxy): `true`, `false`, or a
   * comma-separated list of addresses, CIDRs or the aliases loopback, linklocal, uniquelocal.
   * Default: private networks only, so the Caddy container is trusted and the internet is not.
   */
  ORCH_TRUST_PROXY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default('loopback,linklocal,uniquelocal')
      .transform((v): boolean | string => (v === 'true' ? true : v === 'false' ? false : v)),
  ),
  /**
   * Rate limiting (in-memory, single instance). Limits are per window (RATE_LIMIT_WINDOW_SEC):
   * API per signed-in user (else per IP), auth/OAuth per IP, webhook per IP, MCP per token,
   * expensive reads per user. 0 on a *_MAX value is not allowed; set RATE_LIMIT_ENABLED=false
   * to turn the HTTP limiter off.
   */
  RATE_LIMIT_ENABLED: z.preprocess(
    emptyToUndefined,
    z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  ),
  RATE_LIMIT_WINDOW_SEC: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(60),
  ),
  RATE_LIMIT_API_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(300),
  ),
  RATE_LIMIT_AUTH_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(60),
  ),
  RATE_LIMIT_WEBHOOK_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(600),
  ),
  RATE_LIMIT_MCP_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(120),
  ),
  RATE_LIMIT_HEAVY_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(60),
  ),
  /** Live-log streams (SSE) opened per user per window: counts connections, not events. */
  RATE_LIMIT_STREAM_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(30),
  ),
  /** New agent WebSocket connections per IP per window. */
  RATE_LIMIT_AGENT_CONNECT_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(30),
  ),
  /** Messages per second per agent connection; above it the socket is closed (4429). 0 = off. */
  RATE_LIMIT_AGENT_MSG_PER_SEC: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().default(100),
  ),
  /** Release version of this server (set at image build). `dev` for local builds. */
  ORCH_VERSION: z
    .string()
    .default('dev')
    .transform((v) => v.trim().replace(/^v/, '') || 'dev'),
  /** Image repository agents are updated from (tag = server version). */
  ORCH_AGENT_IMAGE_REPO: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(IMAGE_REPO_RE, 'must be an image repository without tag, e.g. ghcr.io/org/orch-agent')
      .default(DEFAULT_AGENT_IMAGE_REPO),
  ),
  DATABASE_URL: z.string().min(1),
  // GitHub App settings are optional until the OAuth phase; they must be set in production then.
  GITHUB_APP_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_APP_SLUG: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_APP_PRIVATE_KEY_PATH: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  /** GitHub REST API base URL. Only changed for GitHub Enterprise or the E2E fake GitHub. */
  GITHUB_API_URL: z.preprocess(
    emptyToUndefined,
    z
      .url()
      .default('https://api.github.com')
      .transform((u) => u.replace(/\/+$/, '')),
  ),
  /** GitHub web base URL (OAuth authorize / token exchange). Same caveat as GITHUB_API_URL. */
  GITHUB_WEB_URL: z.preprocess(
    emptyToUndefined,
    z
      .url()
      .default('https://github.com')
      .transform((u) => u.replace(/\/+$/, '')),
  ),
  /** Who may sign in. GitHub logins and/or orgs (case-insensitive, comma-separated). */
  ORCH_ALLOWED_GITHUB_LOGINS: csvLower,
  ORCH_ALLOWED_GITHUB_ORGS: csvLower,
  /**
   * Admins (GitHub logins, case-insensitive, comma-separated): always allowed to sign in, and they
   * approve or deny access requests and create invite links on the Access page.
   */
  ORCH_ADMIN_GITHUB_LOGINS: csvLower,
  /** Explicit opt-out of the allowlist: any GitHub account may sign in. Production only needs it. */
  ORCH_ALLOW_ANY_GITHUB_USER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** How long an org-membership check of a signed-in user is cached. */
  ORCH_ALLOWLIST_CACHE_SEC: z.coerce.number().int().nonnegative().default(300),
  /**
   * GitHub outage policy: when an org-membership check fails (network, 5xx, rate limit, revoked
   * App authorization), the user's last known decision is reused if younger than this, then
   * access is denied (fail closed).
   */
  ORCH_ACCESS_GRACE_SEC: z.coerce.number().int().nonnegative().default(900),
  /** How long a user's role on a repository is cached before GitHub is asked again. */
  ORCH_REPO_ACCESS_TTL_SEC: z.coerce.number().int().nonnegative().default(300),
  /**
   * GitHub outage on a private repository: the last verified role is reused if younger than this,
   * then access is denied.
   */
  ORCH_REPO_ACCESS_GRACE_SEC: z.coerce.number().int().nonnegative().default(900),
  ORCH_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  // Files served to member machines. Default: resolved from the repository root.
  ORCH_INSTALL_SH_PATH: z.preprocess(emptyToUndefined, z.string().optional()),
  ORCH_AGENT_COMPOSE_PATH: z.preprocess(emptyToUndefined, z.string().optional()),
  // Agent gateway timings.
  AGENT_HEARTBEAT_SEC: z.coerce.number().int().positive().default(30),
  AGENT_USAGE_SEC: z.coerce.number().int().positive().default(300),
  AGENT_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  AGENT_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  RETENTION_PURGE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  // Dispatcher (M4).
  DISPATCHER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  DISPATCHER_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  /** PENDING auto offers expire after this (PLAN 4.5: 60 s). */
  AUTO_OFFER_TTL_SEC: z.coerce.number().int().positive().default(60),
  /** PENDING consent requests expire after this (PLAN 4.5: 30 min). */
  CONSENT_REQUEST_TTL_SEC: z.coerce.number().int().positive().default(1_800),
  /** A usage report older than this makes the member ineligible for auto offers. */
  USAGE_STALE_SEC: z.coerce.number().int().positive().default(900),
  /**
   * EXTRA safety reserve applied by the server. The safety reserve s of PLAN section 6 (20 %) is
   * already applied by the agent: its `capacityEstimate` is `limit x (1 - s)`. Default 0, so the
   * reserve counts once; raise it only to keep more headroom on top of the agent's.
   */
  BUDGET_SAFETY_RESERVE: z.coerce.number().min(0).max(0.9).default(0),
  OPUS_FACTOR: z.coerce.number().positive().default(5),
  /** Weighted tokens of a Pro 5h window: base of the S/M/L task estimates. */
  PRO_WINDOW_WEIGHTED: z.coerce.number().positive().default(44_000),
  /** Grace added to the S/M/L execution timeouts before an auto run is declared lost. */
  EXEC_LEASE_GRACE_SEC: z.coerce.number().int().nonnegative().default(900),
  /** Prometheus `/metrics`: 404 unless true. Never expose it publicly (see docs/observability.md). */
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Optional bearer token required on `/metrics` (in addition to keeping it off the public proxy). */
  METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  /** OpenTelemetry traces: enabled only when set (OTLP/HTTP endpoint, e.g. http://otel:4318). */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.url().optional()),
  /** Running assignments of an agent unseen (and disconnected) for this long become LOST. */
  AGENT_LEASE_SEC: z.coerce.number().int().positive().default(1_800),
  // Notifications.
  /** Attempts per external delivery (Slack, Discord, webhook, e-mail) before giving up. */
  NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  /** First retry delay; each next one is 4x longer (2 s, 8 s, 32 s by default). */
  NOTIFY_RETRY_BASE_MS: z.coerce.number().int().positive().default(2_000),
  /** In-app notifications older than this are deleted. */
  NOTIFY_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  /** Optional SMTP server for e-mail notifications. The e-mail channel exists only when set. */
  SMTP_HOST: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** `true`: TLS from the first byte (port 465). `false`: STARTTLS when the server offers it. */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Sender, e.g. `orch <orch@example.com>`. Default: orch@<host of the public URL>. */
  SMTP_FROM: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * Web Push (VAPID). Generate with `npx web-push generate-vapid-keys`. All three, or none: without
   * them the browser channel is unavailable. SUBJECT is a `mailto:` address or an https URL that
   * push services can contact.
   */
  VAPID_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  VAPID_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  VAPID_SUBJECT: z.preprocess(emptyToUndefined, z.string().optional()),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Parses and validates the environment. Throws a readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  const vapid = [c.VAPID_PUBLIC_KEY, c.VAPID_PRIVATE_KEY, c.VAPID_SUBJECT];
  if (vapid.some(Boolean)) {
    if (!vapid.every(Boolean)) {
      throw new Error(
        'Invalid configuration:\n  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together',
      );
    }
    if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(c.VAPID_SUBJECT!)) {
      throw new Error(
        'Invalid configuration:\n  VAPID_SUBJECT: use a mailto: address or an https URL',
      );
    }
  }
  if (c.ORCH_PUBLIC_URL) c.ORCH_BASE_URL = c.ORCH_PUBLIC_URL;
  return c;
}

/**
 * True when the environment restricts who may sign in: allowed logins, allowed orgs or admins,
 * unless ORCH_ALLOW_ANY_GITHUB_USER=true.
 * Access approved on the Access page (APPROVED grants in the database) restricts it too; see
 * signInPolicyError.
 */
export function signInIsRestricted(
  c: Pick<
    Config,
    | 'ORCH_ALLOWED_GITHUB_LOGINS'
    | 'ORCH_ALLOWED_GITHUB_ORGS'
    | 'ORCH_ADMIN_GITHUB_LOGINS'
    | 'ORCH_ALLOW_ANY_GITHUB_USER'
  >,
): boolean {
  // The explicit opt-out wins: admins and grants then do not switch on allowlist mode.
  if (c.ORCH_ALLOW_ANY_GITHUB_USER) return false;
  return (
    c.ORCH_ALLOWED_GITHUB_LOGINS.length > 0 ||
    c.ORCH_ALLOWED_GITHUB_ORGS.length > 0 ||
    c.ORCH_ADMIN_GITHUB_LOGINS.length > 0
  );
}

/**
 * Production startup rule: refuse to run when anyone with a GitHub account could sign in, unless
 * ORCH_ALLOW_ANY_GITHUB_USER=true. `hasApprovedGrant`: whether the database holds APPROVED access
 * grants (they restrict sign-in too). Returns the error message, or null when the server may start.
 */
export function signInPolicyError(c: Config, hasApprovedGrant: boolean): string | null {
  if (c.NODE_ENV !== 'production' || c.ORCH_ALLOW_ANY_GITHUB_USER) return null;
  if (signInIsRestricted(c) || hasApprovedGrant) return null;
  return (
    'Invalid configuration:\n  Anyone with a GitHub account could sign in. Set ' +
    'ORCH_ADMIN_GITHUB_LOGINS (admins approve access on the Access page), ' +
    'ORCH_ALLOWED_GITHUB_LOGINS and/or ORCH_ALLOWED_GITHUB_ORGS, or set ' +
    'ORCH_ALLOW_ANY_GITHUB_USER=true to accept that.'
  );
}

/** Async startup check of signInPolicyError; reads the database only when it decides. */
export async function assertSignInPolicy(
  c: Config,
  hasApprovedGrant: () => Promise<boolean>,
): Promise<void> {
  if (signInPolicyError(c, true) === null && signInPolicyError(c, false) === null) return;
  const err = signInPolicyError(c, await hasApprovedGrant());
  if (err) throw new Error(err);
}
