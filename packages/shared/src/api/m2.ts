/**
 * M2 REST contract: agents (member machines), enrollment, usage summary, pause.
 *
 * Routes:
 *   POST   /api/agents/enrollment-tokens                 -> CreateEnrollmentTokenResponse (201)
 *          Single use, valid 15 min, the raw token is shown ONCE (only its hash is stored).
 *   POST   /api/agents/enroll   EnrollRequest            -> EnrollResponse (201)   PUBLIC
 *          Alias: POST /agent/enroll (called by install.sh). 401 `invalid_token` when the token
 *          is unknown, expired or already used. The token is spent atomically.
 *   GET    /api/agents/mine                              -> AgentView[]
 *   POST   /api/agents/:id/pause                         -> AgentView   (owner of the agent only)
 *   POST   /api/agents/:id/resume                        -> AgentView   (owner of the agent only)
 *   GET    /api/agents/outdated-count                    -> { count } my agents with updateAvailable
 *   POST   /api/agents/:id/update  { whenIdle? }         -> AgentView (202) (owner only, audited)
 *          Sends `agent.update` with the server-decided image. 409 `agent_offline`,
 *          `update_unsupported` (agent too old for one-click update), `up_to_date`,
 *          `server_version_unknown` (server runs a `dev` build).
 *   DELETE /api/agents/:id                               204, revokes the credential and closes
 *                                                        the live socket (code 4003)
 *   GET    /install.sh                                   text/x-shellscript, server URL substituted
 *   GET    /agent/compose.yaml                           text/yaml, deploy/agent/compose.yaml
 *   GET    /agent/ws                                     WebSocket, see ../protocol
 *
 * Errors: HTTP status + `{ error: { code, message } }` (see ApiErrorSchema in m1).
 */
import { z } from 'zod';
import { UpdateStatus } from '../protocol/messages';

export const ENROLLMENT_TOKEN_TTL_SEC = 15 * 60;

export const CreateEnrollmentTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  /** `curl -fsSL <base>/install.sh | sh -s -- --token <token>` */
  installCommand: z.string(),
});
export type CreateEnrollmentTokenResponse = z.infer<typeof CreateEnrollmentTokenResponseSchema>;

const MachineName = z.string().trim().min(1).max(100);
const AgentVersion = z.string().trim().min(1).max(64);

/**
 * Accepts the short form `{ token, machineName, agentVersion }` and the install.sh form
 * `{ token, machine: { hostname, os, arch, agentVersion, dockerVersion } }`.
 */
export const EnrollRequestSchema = z
  .object({
    token: z.string().min(1).max(200),
    machineName: MachineName.optional(),
    agentVersion: AgentVersion.optional(),
    machine: z
      .object({
        hostname: MachineName.optional(),
        os: z.string().max(32).optional(),
        arch: z.string().max(32).optional(),
        agentVersion: AgentVersion.optional(),
        dockerVersion: z.string().max(64).optional(),
      })
      .optional(),
  })
  .refine((r) => r.machineName ?? r.machine?.hostname, {
    message: 'machineName (or machine.hostname) is required',
    path: ['machineName'],
  });
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

export const EnrollResponseSchema = z.object({
  agentId: z.string(),
  /** `orch_agent_<agentId>.<secret>`; shown once, stored hashed. */
  credential: z.string(),
});
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

/** Latest usage report summary. Every figure is an ESTIMATE. */
export const AgentUsageSummarySchema = z.object({
  estimate: z.literal(true),
  reportedAt: z.string(),
  windowStart: z.string().nullable(),
  windowResetAt: z.string().nullable(),
  weighted: z.number(),
  capacityEstimate: z.number().nullable(),
  /** weighted / capacityEstimate, null when the capacity is unknown. */
  usedFraction: z.number().nullable(),
  rateLimitedUntil: z.string().nullable(),
});
export type AgentUsageSummary = z.infer<typeof AgentUsageSummarySchema>;

export const AgentUpdateInfoSchema = z.object({
  status: UpdateStatus,
  targetVersion: z.string(),
  code: z.string().nullable(),
  detail: z.string().nullable(),
  requestedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type AgentUpdateInfo = z.infer<typeof AgentUpdateInfoSchema>;

export const AgentUpdateRequestSchema = z.object({ whenIdle: z.boolean().optional() }).strict();
export type AgentUpdateRequest = z.infer<typeof AgentUpdateRequestSchema>;

export const OutdatedCountResponseSchema = z.object({ count: z.number().int().nonnegative() });
export type OutdatedCountResponse = z.infer<typeof OutdatedCountResponseSchema>;

export const AgentViewSchema = z.object({
  id: z.string(),
  machineName: z.string(),
  version: z.string().nullable(),
  connected: z.boolean(),
  lastSeenAt: z.string().nullable(),
  lastUsage: AgentUsageSummarySchema.nullable(),
  paused: z.boolean(),
  revokedAt: z.string().nullable(),
  /** Reported by the agent: has the member run `orch login`? Null/absent = unknown. */
  claudeTokenPresent: z.boolean().nullish(),
  /** Version agents should run (the server's release version); null when the server is `dev`. */
  latestAgentVersion: z.string().nullable().optional(),
  /** True when `version` is a release older than `latestAgentVersion` (never for `dev`). */
  updateAvailable: z.boolean().optional(),
  /** True when the agent is connected and supports one-click update (`agent.update`). */
  canSelfUpdate: z.boolean().optional(),
  /** Last update request and its progress (null when none). */
  update: AgentUpdateInfoSchema.nullable().optional(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

export const AgentListResponseSchema = z.array(AgentViewSchema);
