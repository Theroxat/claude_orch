import { describe, expect, it } from 'vitest';
import { classifyFailure, summarizeFailure } from './failure';
import { redactSecrets } from '../redact';
import { parseAgentMessage, agentMessage } from '../protocol';

describe('classifyFailure', () => {
  it('classifies the v0.5.0 production errors', () => {
    expect(classifyFailure('docker compose failed: env file /some/path/.env not found')).toBe(
      'env',
    );
    expect(
      classifyFailure(
        'claude exited with code 1: Failed to authenticate. API Error: 401 OAuth access token is invalid.',
      ),
    ).toBe('claude_auth');
  });

  it('classifies setup, limits, timeouts and the rest', () => {
    expect(classifyFailure('docker compose failed (exit 1): env file .env not found')).toBe('env');
    expect(
      classifyFailure(
        'Sidecars (compose.yaml) failed at "docker compose up": a service did not start [x]',
      ),
    ).toBe('env');
    expect(classifyFailure('docker build failed (exit 1): failed to solve: no such file')).toBe(
      'env',
    );
    expect(classifyFailure('Error response from daemon: pull access denied for foo')).toBe('env');
    expect(classifyFailure('devcontainer build.dockerfile "x" does not exist')).toBe('env');
    expect(classifyFailure('No Claude token. Run "orch login".')).toBe('claude_auth');
    expect(classifyFailure('API Error: 401 {"type":"authentication_error"}')).toBe('claude_auth');
    expect(
      classifyFailure('rate limited: claude exited with code 1: Claude AI usage limit reached|1'),
    ).toBe('rate_limited');
    expect(classifyFailure('claude exited with code 1: 429 Too Many Requests')).toBe(
      'rate_limited',
    );
    expect(classifyFailure('Timed out after 30 min; the run was stopped.')).toBe('timeout');
    expect(classifyFailure('claude exited with code 1 (error_during_execution): oops')).toBe(
      'task',
    );
    // Claude's own output may mention compose: it ran, so it is a task failure.
    expect(classifyFailure('claude exited with code 2: docker compose failed in my tests')).toBe(
      'task',
    );
    expect(classifyFailure('Push failed: ! [rejected] (non-fast-forward)')).toBe('task');
    expect(classifyFailure('no_changes')).toBe('task');
    expect(classifyFailure(undefined)).toBe('task');
    expect(classifyFailure('')).toBe('task');
  });
});

describe('summarizeFailure', () => {
  it('redacts secrets, shortens absolute paths and truncates', () => {
    expect(summarizeFailure('docker compose failed: env file /some/path/.env not found')).toBe(
      'docker compose failed: env file .env not found',
    );
    const s = summarizeFailure(
      'git push https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r failed sk-ant-oat01-SECRET',
    );
    expect(s).not.toContain('ghs_abc');
    expect(s).not.toContain('SECRET');
    expect(s).toContain('github.com/o/r');
    expect(summarizeFailure('x'.repeat(500), 50)).toHaveLength(50);
    expect(redactSecrets('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [REDACTED]');
  });
});

describe('task.finished failureClass', () => {
  it('is optional (older agents) and validated when present', () => {
    const base = {
      assignmentId: 'a1',
      seq: 1,
      outcome: 'failed' as const,
      usage: { weighted: 0, input: 0, output: 0 },
      error: 'boom',
    };
    expect(parseAgentMessage(JSON.stringify(agentMessage('task.finished', base))).ok).toBe(true);
    expect(
      parseAgentMessage(
        JSON.stringify(agentMessage('task.finished', { ...base, failureClass: 'env' })),
      ).ok,
    ).toBe(true);
    expect(
      parseAgentMessage(
        JSON.stringify(agentMessage('task.finished', { ...base, failureClass: 'nope' } as never)),
      ).ok,
    ).toBe(false);
  });
});
