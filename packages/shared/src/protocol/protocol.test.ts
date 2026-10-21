import { describe, expect, it } from 'vitest';
import {
  CloseCode,
  FATAL_CLOSE_CODES,
  agentMessage,
  parseAgentCredential,
  parseAgentMessage,
  parseServerMessage,
  serverMessage,
} from './index';
import { EnrollRequestSchema } from '../api/m2';

describe('protocol', () => {
  it('round-trips an agent heartbeat', () => {
    const m = agentMessage('heartbeat', { running: 0, localPaused: false });
    const r = parseAgentMessage(JSON.stringify(m));
    expect(r.ok && r.message.type).toBe('heartbeat');
  });

  it('round-trips a server welcome', () => {
    const m = serverMessage('welcome', {
      agentId: 'a1',
      serverTime: new Date().toISOString(),
      heartbeatSec: 30,
      usageSec: 300,
      paused: false,
      participations: [],
    });
    expect(parseServerMessage(m).ok).toBe(true);
  });

  it('requires replyTo on ack', () => {
    const m = agentMessage('ack', { ok: true });
    const r = parseAgentMessage(m);
    expect(r.ok).toBe(false);
    expect(parseAgentMessage({ ...m, replyTo: 'x' }).ok).toBe(true);
  });

  it('flags a version mismatch and bad JSON', () => {
    const m = { ...agentMessage('pause.set', { paused: true }), v: 2 };
    const r = parseAgentMessage(m);
    expect(!r.ok && r.code).toBe('version_mismatch');
    const j = parseAgentMessage('{nope');
    expect(!j.ok && j.code).toBe('invalid_json');
  });

  it('rejects an unknown type and a bad payload', () => {
    const m = agentMessage('pause.set', { paused: true });
    expect(parseAgentMessage({ ...m, type: 'nope' }).ok).toBe(false);
    expect(parseAgentMessage({ ...m, payload: { paused: 'yes' } }).ok).toBe(false);
  });

  it('generates unique message ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => agentMessage('ack', { ok: true }).id));
    expect(ids.size).toBe(1000);
  });

  it('parses credentials', () => {
    const secret = 'A'.repeat(43);
    expect(parseAgentCredential(`orch_agent_agt_x1.${secret}`)).toEqual({
      agentId: 'agt_x1',
      secret,
    });
    expect(parseAgentCredential('nope')).toBeNull();
    expect(parseAgentCredential(`orch_agent_.${secret}`)).toBeNull();
  });

  it('marks revoked and version mismatch as fatal', () => {
    expect(FATAL_CLOSE_CODES).toContain(CloseCode.REVOKED);
    expect(FATAL_CLOSE_CODES).not.toContain(CloseCode.SUPERSEDED);
  });

  it('accepts both enroll request shapes', () => {
    expect(
      EnrollRequestSchema.safeParse({ token: 't', machineName: 'm', agentVersion: '1' }).success,
    ).toBe(true);
    expect(EnrollRequestSchema.safeParse({ token: 't', machine: { hostname: 'h' } }).success).toBe(
      true,
    );
    expect(EnrollRequestSchema.safeParse({ token: 't' }).success).toBe(false);
  });
});
