/**
 * Server <-> agent message types (PLAN section 4.4). Both sides validate every frame with these.
 * Task-related messages (offer, claim, status, token...) are defined now and used from M3/M4.
 */
import { z } from 'zod';
import { Model, ParticipationMode } from '../domain/enums';
import {
  AckMessageSchema,
  EnvelopeBaseSchema,
  IsoDateTime,
  PROTOCOL_VERSION,
  envelopeOf,
  newMessageId,
} from './envelope';

// ---------- shared payload parts ----------

export const ExecMode = z.enum(['AUTO', 'MANUAL']);
export type ExecMode = z.infer<typeof ExecMode>;

export const AssignmentKind = z.enum(['AUTO_OFFER', 'CONSENT_REQUEST', 'CLAIM']);
export type AssignmentKind = z.infer<typeof AssignmentKind>;

export const TaskSize = z.enum(['S', 'M', 'L']);
export type TaskSize = z.infer<typeof TaskSize>;

export const RunningTaskSchema = z.object({
  assignmentId: z.string(),
  taskId: z.string(),
  state: z.string(),
  lastSeq: z.number().int().nonnegative(),
});

export const TokenCountsSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
});
export type TokenCounts = z.infer<typeof TokenCountsSchema>;

export const ParticipationConfigSchema = z.object({
  projectId: z.string(),
  fullName: z.string(),
  percent: z.number().int().min(0).max(100),
  mode: ParticipationMode,
  allowedModels: z.array(Model),
});

/** Config part shared by `welcome` and `config.update`. `paused` is the effective server-side state. */
export const AgentConfigPayloadSchema = z.object({
  heartbeatSec: z.number().int().positive(),
  usageSec: z.number().int().positive(),
  paused: z.boolean(),
  participations: z.array(ParticipationConfigSchema),
});
export type AgentConfigPayload = z.infer<typeof AgentConfigPayloadSchema>;

// ---------- agent -> server payloads ----------

export const HelloPayloadSchema = z.object({
  agentVersion: z.string().max(64),
  capabilities: z.array(z.enum(['auto', 'manual', 'devcontainer'])),
  localPaused: z.boolean(),
  maxConcurrent: z.number().int().positive(),
  running: z.array(RunningTaskSchema),
  /** True when the member ran `orch login` (the token file exists and is non-empty). */
  claudeTokenPresent: z.boolean().optional(),
});
export type HelloPayload = z.infer<typeof HelloPayloadSchema>;

export const HeartbeatPayloadSchema = z.object({
  running: z.number().int().nonnegative(),
  localPaused: z.boolean(),
  load: z
    .object({
      cpu: z.number().nonnegative(),
      memFreeMb: z.number().nonnegative(),
      diskFreeMb: z.number().nonnegative(),
    })
    .partial()
    .optional(),
});
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

/** All figures are ESTIMATES from local logs (PLAN 5.7, R2). */
export const UsageReportPayloadSchema = z.object({
  estimate: z.literal(true),
  /** Null when no 5-hour block is active. */
  windowStart: IsoDateTime.nullable(),
  windowResetAt: IsoDateTime.nullable(),
  tokens: TokenCountsSchema,
  weighted: z.number().nonnegative(),
  /** Weighted tokens per model name. */
  byModel: z.record(z.string(), z.number().nonnegative()),
  /** Weighted tokens per projectId, plus "personal". */
  byProject: z.record(z.string(), z.number().nonnegative()),
  /** Estimated usable weighted capacity per 5-hour window. */
  capacityEstimate: z.number().nonnegative().nullable(),
  rateLimitedUntil: IsoDateTime.optional(),
  source: z.enum(['jsonl', 'stream', 'mixed']),
  /** Recomputed on each report; flips to true right after `orch login`. */
  claudeTokenPresent: z.boolean().optional(),
});
export type UsageReportPayload = z.infer<typeof UsageReportPayloadSchema>;

export const OfferAcceptPayloadSchema = z.object({
  assignmentId: z.string(),
  execMode: ExecMode,
});

export const OfferRejectReason = z.enum([
  'paused',
  'budget',
  'concurrency',
  'model_not_allowed',
  'not_participating',
  'user_declined',
  'error',
]);
export const OfferRejectPayloadSchema = z.object({
  assignmentId: z.string(),
  reason: OfferRejectReason,
  detail: z.string().max(2000).optional(),
});

/**
 * `config.request` (no ack): the agent asks for its current config, e.g. when an AUTO_OFFER names
 * a project missing from its synced participation list. The server answers `config.update` with
 * `replyTo` = the request id. Older servers answer `error` (invalid_message) with the same
 * `replyTo`; the agent then keeps its config (and treats a timeout the same way).
 */
export const ConfigRequestPayloadSchema = z.object({
  reason: z.string().max(200).optional(),
});

export const TaskClaimPayloadSchema = z.object({
  projectFullName: z.string(),
  issueNumber: z.number().int().positive(),
});

export const TaskState = z.enum(['preparing', 'building', 'running', 'pushing', 'finished']);
export const TaskStatusPayloadSchema = z.object({
  assignmentId: z.string(),
  seq: z.number().int().positive(),
  state: TaskState,
  detail: z.string().max(2000).optional(),
  progress: z.number().min(0).max(1).optional(),
});

export const TaskPushedPayloadSchema = z.object({
  assignmentId: z.string(),
  seq: z.number().int().positive(),
  branch: z.string(),
  headSha: z.string(),
  changedFiles: z.number().int().nonnegative(),
  summary: z.string().max(10_000),
});

export const TaskFinishedPayloadSchema = z.object({
  assignmentId: z.string(),
  seq: z.number().int().positive(),
  outcome: z.enum(['succeeded', 'failed', 'cancelled', 'no_changes']),
  usage: z.object({
    weighted: z.number().nonnegative(),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  error: z.string().max(4000).optional(),
});

export const TokenRequestPayloadSchema = z.object({
  requestId: z.string(),
  assignmentId: z.string(),
  purpose: z.enum(['clone', 'push']),
});

export const DoneRequestPayloadSchema = z.object({ assignmentId: z.string() });

/** `orch list`: tasks this member could take now (M3, additive). */
export const TasksListRequestPayloadSchema = z.object({
  projectFullName: z.string().optional(),
});
export type TasksListRequestPayload = z.infer<typeof TasksListRequestPayloadSchema>;

export const PauseSetPayloadSchema = z.object({ paused: z.boolean() });
export type PauseSetPayload = z.infer<typeof PauseSetPayloadSchema>;

// ---------- server -> agent payloads ----------

export const WelcomePayloadSchema = AgentConfigPayloadSchema.extend({
  agentId: z.string(),
  serverTime: IsoDateTime,
});
export type WelcomePayload = z.infer<typeof WelcomePayloadSchema>;

/**
 * `config.update`: pushed whenever the effective config changes (pause, participation created,
 * edited, approved, rejected or removed, project settings or removal), and sent as the answer to
 * `config.request` (with `replyTo`). `participations` is always the full current list.
 */
export const ConfigUpdatePayloadSchema = AgentConfigPayloadSchema;

/**
 * `task.offer`. Kinds:
 *  - CLAIM: answer to `task.claim` (manual mode, M3). The assignment is already accepted.
 *  - AUTO_OFFER (M4): the member's participation is active, approved and in AUTO mode. The agent
 *    re-checks its local guard (pause, concurrency, budget), then answers `offer.accept`
 *    `{ execMode: "AUTO" }` and runs `claude -p`, or `offer.reject` with a reason. Unanswered
 *    offers expire at `expiresAt` (then `task.cancel` reason "expired").
 *  - CONSENT_REQUEST (M4): sent only with `accepted: true`, after the member accepted the request
 *    (web, or `offer.accept` from `orch accept <id>`). The agent answers `offer.accept`
 *    `{ execMode: "AUTO" }` and runs it like an AUTO_OFFER.
 * Fields marked M4 are optional so older agents keep parsing the frame.
 */
export const TaskOfferPayloadSchema = z.object({
  assignmentId: z.string(),
  kind: AssignmentKind,
  expiresAt: IsoDateTime.nullable(),
  /** M4: how the agent must run it. AUTO = `claude -p`, MANUAL = screen session. */
  execMode: ExecMode.optional(),
  /** M4: true when the member already consented (CONSENT_REQUEST accepted, or CLAIM). */
  accepted: z.boolean().optional(),
  /** M4: hard execution limit in seconds (size S/M/L = 30/90/180 min). */
  timeoutSec: z.number().int().positive().optional(),
  /**
   * M5: who started a CLAIM. `agent` = answer to the agent's own `task.claim` (has `replyTo`).
   * `server` = the member took the task elsewhere (MCP `take_task`): the claim is already accepted
   * on the server, no `replyTo`; the agent answers `offer.accept` MANUAL and prepares it like
   * its own claim, or `offer.reject` if its local guard refuses.
   */
  initiatedBy: z.enum(['agent', 'server']).optional(),
  task: z.object({
    taskId: z.string(),
    project: z.object({ id: z.string(), fullName: z.string(), defaultBranch: z.string() }),
    issueNumber: z.number().int().positive(),
    title: z.string(),
    prompt: z.string(),
    bodyHash: z.string(),
    acceptanceCriteria: z.array(z.string()),
    size: TaskSize,
    model: Model,
    baseBranch: z.string(),
    branchName: z.string(),
    createdBy: z.object({ login: z.string() }),
    /** M4: integration branch, when set (`baseBranch` already equals it: the PR base). */
    integrationBranch: z.string().nullable().optional(),
  }),
});
export type TaskOfferPayload = z.infer<typeof TaskOfferPayloadSchema>;

/**
 * M4 `offer.request` (notification, no ack): an approval-mode member has a request waiting.
 * Nothing starts until the member accepts it on the web (`POST /api/offers/:id/accept`) or with
 * `orch accept <assignmentId>` (agent sends `offer.accept`). `orch reject` sends `offer.reject`.
 */
export const OfferRequestPayloadSchema = z.object({
  assignmentId: z.string(),
  expiresAt: IsoDateTime.nullable(),
  task: z.object({
    taskId: z.string(),
    project: z.object({ id: z.string(), fullName: z.string() }),
    issueNumber: z.number().int().positive(),
    title: z.string(),
    size: TaskSize,
    model: Model,
    createdBy: z.object({ login: z.string() }),
  }),
});
export type OfferRequestPayload = z.infer<typeof OfferRequestPayloadSchema>;

/** M4 `offer.withdrawn` (notification, no ack): a pending request is gone (taken, expired...). */
export const OfferWithdrawnPayloadSchema = z.object({
  assignmentId: z.string(),
  reason: z.string(),
});
export type OfferWithdrawnPayload = z.infer<typeof OfferWithdrawnPayloadSchema>;

export const TaskCancelPayloadSchema = z.object({ assignmentId: z.string(), reason: z.string() });

export const TokenGrantPayloadSchema = z.object({
  requestId: z.string(),
  token: z.string(),
  expiresAt: IsoDateTime,
  repository: z.string(),
  permissions: z.record(z.string(), z.enum(['read', 'write'])),
});

export const TokenDenyPayloadSchema = z.object({ requestId: z.string(), reason: z.string() });

export const PrOpenedPayloadSchema = z.object({
  assignmentId: z.string(),
  prNumber: z.number().int().positive(),
  prUrl: z.string().url(),
});

export const TasksListItemSchema = z.object({
  taskId: z.string(),
  projectFullName: z.string(),
  issueNumber: z.number().int().positive(),
  title: z.string(),
  size: TaskSize,
  model: Model,
  createdBy: z.object({ login: z.string() }),
});
/** Answer to `tasks.list.request` (`replyTo` = the request id): takeable tasks only. */
export const TasksListPayloadSchema = z.object({ tasks: z.array(TasksListItemSchema) });
export type TasksListPayload = z.infer<typeof TasksListPayloadSchema>;

export const CleanupPayloadSchema = z.object({ assignmentId: z.string() });

export const ErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  replyTo: z.string().optional(),
});

// ---------- message unions ----------

export const AgentMessageSchemas = {
  hello: envelopeOf('hello', HelloPayloadSchema),
  heartbeat: envelopeOf('heartbeat', HeartbeatPayloadSchema),
  'usage.report': envelopeOf('usage.report', UsageReportPayloadSchema),
  'offer.accept': envelopeOf('offer.accept', OfferAcceptPayloadSchema),
  'offer.reject': envelopeOf('offer.reject', OfferRejectPayloadSchema),
  'task.claim': envelopeOf('task.claim', TaskClaimPayloadSchema),
  'task.status': envelopeOf('task.status', TaskStatusPayloadSchema),
  'task.pushed': envelopeOf('task.pushed', TaskPushedPayloadSchema),
  'task.finished': envelopeOf('task.finished', TaskFinishedPayloadSchema),
  'token.request': envelopeOf('token.request', TokenRequestPayloadSchema),
  'done.request': envelopeOf('done.request', DoneRequestPayloadSchema),
  'pause.set': envelopeOf('pause.set', PauseSetPayloadSchema),
  'tasks.list.request': envelopeOf('tasks.list.request', TasksListRequestPayloadSchema),
  'config.request': envelopeOf('config.request', ConfigRequestPayloadSchema),
  ack: AckMessageSchema,
} as const;

export const ServerMessageSchemas = {
  welcome: envelopeOf('welcome', WelcomePayloadSchema),
  'config.update': envelopeOf('config.update', ConfigUpdatePayloadSchema),
  'task.offer': envelopeOf('task.offer', TaskOfferPayloadSchema),
  'task.cancel': envelopeOf('task.cancel', TaskCancelPayloadSchema),
  'token.grant': envelopeOf('token.grant', TokenGrantPayloadSchema),
  'token.deny': envelopeOf('token.deny', TokenDenyPayloadSchema),
  'pr.opened': envelopeOf('pr.opened', PrOpenedPayloadSchema),
  'tasks.list': envelopeOf('tasks.list', TasksListPayloadSchema),
  'offer.request': envelopeOf('offer.request', OfferRequestPayloadSchema),
  'offer.withdrawn': envelopeOf('offer.withdrawn', OfferWithdrawnPayloadSchema),
  cleanup: envelopeOf('cleanup', CleanupPayloadSchema),
  error: envelopeOf('error', ErrorPayloadSchema),
  ack: AckMessageSchema,
} as const;

export const AgentMessageSchema = z.discriminatedUnion('type', [
  AgentMessageSchemas.hello,
  AgentMessageSchemas.heartbeat,
  AgentMessageSchemas['usage.report'],
  AgentMessageSchemas['offer.accept'],
  AgentMessageSchemas['offer.reject'],
  AgentMessageSchemas['task.claim'],
  AgentMessageSchemas['task.status'],
  AgentMessageSchemas['task.pushed'],
  AgentMessageSchemas['task.finished'],
  AgentMessageSchemas['token.request'],
  AgentMessageSchemas['done.request'],
  AgentMessageSchemas['pause.set'],
  AgentMessageSchemas['tasks.list.request'],
  AgentMessageSchemas['config.request'],
  AgentMessageSchemas.ack,
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type AgentMessageType = AgentMessage['type'];

export const ServerMessageSchema = z.discriminatedUnion('type', [
  ServerMessageSchemas.welcome,
  ServerMessageSchemas['config.update'],
  ServerMessageSchemas['task.offer'],
  ServerMessageSchemas['task.cancel'],
  ServerMessageSchemas['token.grant'],
  ServerMessageSchemas['token.deny'],
  ServerMessageSchemas['pr.opened'],
  ServerMessageSchemas['tasks.list'],
  ServerMessageSchemas['offer.request'],
  ServerMessageSchemas['offer.withdrawn'],
  ServerMessageSchemas.cleanup,
  ServerMessageSchemas.error,
  ServerMessageSchemas.ack,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage['type'];

export type PayloadOf<M extends { type: string; payload: unknown }, T extends M['type']> = Extract<
  M,
  { type: T }
>['payload'];

/** Agent -> server types that change state and need an `ack` (retried with the same id). */
export const AGENT_ACKED_TYPES: readonly AgentMessageType[] = [
  'usage.report',
  'offer.accept',
  'offer.reject',
  'task.claim',
  'task.status',
  'task.pushed',
  'task.finished',
  'done.request',
  'pause.set',
];

/** Server -> agent types that need an `ack`. */
export const SERVER_ACKED_TYPES: readonly ServerMessageType[] = [
  'config.update',
  'task.offer',
  'task.cancel',
  'pr.opened',
  'cleanup',
];

export interface BuildOptions {
  id?: string;
  replyTo?: string;
  seq?: number;
  now?: Date;
}

function build<T extends string, P>(type: T, payload: P, o: BuildOptions = {}) {
  const now = o.now ?? new Date();
  return {
    v: PROTOCOL_VERSION,
    id: o.id ?? newMessageId(now.getTime()),
    type,
    ts: now.toISOString(),
    ...(o.replyTo !== undefined ? { replyTo: o.replyTo } : {}),
    ...(o.seq !== undefined ? { seq: o.seq } : {}),
    payload,
  };
}

/** Builds an agent -> server message (not validated; validate on receipt). */
export function agentMessage<T extends AgentMessageType>(
  type: T,
  payload: PayloadOf<AgentMessage, T>,
  o?: BuildOptions,
): Extract<AgentMessage, { type: T }> {
  return build(type, payload, o) as unknown as Extract<AgentMessage, { type: T }>;
}

/** Builds a server -> agent message. */
export function serverMessage<T extends ServerMessageType>(
  type: T,
  payload: PayloadOf<ServerMessage, T>,
  o?: BuildOptions,
): Extract<ServerMessage, { type: T }> {
  return build(type, payload, o) as unknown as Extract<ServerMessage, { type: T }>;
}

export type ParseResult<M> =
  | { ok: true; message: M }
  | {
      ok: false;
      code: 'invalid_json' | 'invalid_envelope' | 'version_mismatch' | 'invalid_message';
      error: string;
      id?: string;
    };

function parseWith<M>(schema: z.ZodType<M>, raw: string | unknown): ParseResult<M> {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, code: 'invalid_json', error: 'Frame is not JSON' };
    }
  }
  const env = EnvelopeBaseSchema.safeParse(data);
  if (!env.success) return { ok: false, code: 'invalid_envelope', error: env.error.message };
  if (env.data.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'version_mismatch',
      error: `Protocol v${env.data.v} is not supported (expected v${PROTOCOL_VERSION})`,
      id: env.data.id,
    };
  }
  const m = schema.safeParse(data);
  if (!m.success)
    return { ok: false, code: 'invalid_message', error: m.error.message, id: env.data.id };
  return { ok: true, message: m.data };
}

export const parseAgentMessage = (raw: string | unknown) => parseWith(AgentMessageSchema, raw);
export const parseServerMessage = (raw: string | unknown) => parseWith(ServerMessageSchema, raw);
