/**
 * Server <-> agent WSS envelope (PLAN section 4.3).
 *
 * Transport: `wss://<domain>/agent/ws`, credential in `Authorization: Bearer orch_agent_<id>.<secret>`
 * (never in the URL). Auth failure at upgrade time is answered with HTTP 401 before the socket opens.
 *
 * Delivery rules:
 *  - Every message whose type is in `ACKED_TYPES` must be answered with an `ack` whose `replyTo`
 *    is the original `id`. The sender retries unacked messages with the SAME id.
 *  - Receivers dedupe on (agentId, id).
 *  - `seq` is an optional per-sender monotonic counter (outbox order). Replays keep their seq.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** WebSocket close codes used by the server. */
export const CloseCode = {
  NORMAL: 1000,
  /** A newer connection for the same agent replaced this one. */
  SUPERSEDED: 4001,
  /** The agent credential was revoked. Do not reconnect. */
  REVOKED: 4003,
  /** No heartbeat within the timeout. */
  HEARTBEAT_TIMEOUT: 4008,
  /** Malformed or invalid message (bad envelope, failed schema). */
  PROTOCOL_ERROR: 4009,
  /** Major protocol version mismatch: run `docker compose pull`. Do not reconnect. */
  VERSION_MISMATCH: 4010,
  /** Credential rejected after the socket opened. Do not reconnect. */
  UNAUTHORIZED: 4401,
  /**
   * The owner's access was removed or denied by an admin (or cannot be verified). NOT fatal: the
   * credential stays valid, so the agent retries with a long backoff and comes back once the
   * owner is approved again.
   */
  ACCESS_SUSPENDED: 4403,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Close codes after which the agent must stop reconnecting. */
export const FATAL_CLOSE_CODES: readonly number[] = [
  CloseCode.REVOKED,
  CloseCode.VERSION_MISMATCH,
  CloseCode.UNAUTHORIZED,
];

/** Credential format returned by enrollment: `orch_agent_<agentId>.<secret>`. */
export const AGENT_CREDENTIAL_PREFIX = 'orch_agent_';
export const AgentCredentialSchema = z
  .string()
  .regex(/^orch_agent_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,}$/);

export function parseAgentCredential(
  credential: string,
): { agentId: string; secret: string } | null {
  if (!AgentCredentialSchema.safeParse(credential).success) return null;
  const rest = credential.slice(AGENT_CREDENTIAL_PREFIX.length);
  const dot = rest.indexOf('.');
  return { agentId: rest.slice(0, dot), secret: rest.slice(dot + 1) };
}

export const MessageId = z.string().min(1).max(128);
export const IsoDateTime = z.string().datetime({ offset: true });

export const EnvelopeBaseSchema = z.object({
  v: z.number().int().positive(),
  id: MessageId,
  type: z.string().min(1).max(64),
  ts: IsoDateTime,
  replyTo: MessageId.optional(),
  seq: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});
export type EnvelopeBase = z.infer<typeof EnvelopeBaseSchema>;

/** Builds a typed envelope schema for one message type. */
export function envelopeOf<T extends string, P extends z.ZodTypeAny>(type: T, payload: P) {
  return EnvelopeBaseSchema.extend({ type: z.literal(type), payload });
}

/** Payload of `ack`. `ok: false` means the receiver processed the message and refused it. */
export const AckPayloadSchema = z.object({
  ok: z.boolean(),
  /** True when the message id was already seen (dedupe hit). */
  duplicate: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type AckPayload = z.infer<typeof AckPayloadSchema>;

/** `ack` requires `replyTo`. */
export const AckMessageSchema = envelopeOf('ack', AckPayloadSchema).extend({ replyTo: MessageId });

let counter = 0;
/** Sortable, unique enough message id (time prefix + random). */
export function newMessageId(now: number = Date.now()): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
  counter = (counter + 1) % 1_679_616;
  return `${now.toString(36).padStart(9, '0')}${counter.toString(36).padStart(4, '0')}${rand}`;
}
