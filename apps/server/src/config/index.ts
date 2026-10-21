import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ORCH_BASE_URL: z.string().url().default('http://localhost:8470'),
  DATABASE_URL: z.string().min(1),
  // GitHub App settings are optional until the OAuth phase; they must be set in production then.
  GITHUB_APP_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_APP_SLUG: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_APP_PRIVATE_KEY_PATH: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
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
  /** Safety reserve s of PLAN section 6. */
  BUDGET_SAFETY_RESERVE: z.coerce.number().min(0).max(0.9).default(0.2),
  OPUS_FACTOR: z.coerce.number().positive().default(5),
  /** Weighted tokens of a Pro 5h window: base of the S/M/L task estimates. */
  PRO_WINDOW_WEIGHTED: z.coerce.number().positive().default(44_000),
  /** Grace added to the S/M/L execution timeouts before an auto run is declared lost. */
  EXEC_LEASE_GRACE_SEC: z.coerce.number().int().nonnegative().default(900),
  /** Running assignments of an agent unseen (and disconnected) for this long become LOST. */
  AGENT_LEASE_SEC: z.coerce.number().int().positive().default(1_800),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Parses and validates the environment. Throws a readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
