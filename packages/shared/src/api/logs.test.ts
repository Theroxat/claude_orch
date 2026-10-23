import { describe, expect, it } from 'vitest';
import { AGENT_ACKED_TYPES, agentMessage, parseAgentMessage } from '../protocol/messages';
import { stripAnsi } from './logs';

describe('task.log', () => {
  it('parses a batch and is never acked (best effort)', () => {
    const m = agentMessage('task.log', {
      assignmentId: 'a1',
      chunk: 1,
      entries: [{ ts: 1, kind: 'tool', tool: 'Bash', text: 'pnpm test' }],
      dropped: 2,
    });
    const r = parseAgentMessage(JSON.stringify(m));
    expect(r.ok).toBe(true);
    expect(AGENT_ACKED_TYPES).not.toContain('task.log');
  });

  it('rejects oversized entries', () => {
    const m = agentMessage('task.log', {
      assignmentId: 'a1',
      chunk: 1,
      entries: [{ ts: 1, kind: 'text', text: 'x'.repeat(5000) }],
    });
    expect(parseAgentMessage(JSON.stringify(m)).ok).toBe(false);
  });
});

describe('stripAnsi', () => {
  it('removes colors, cursor moves, OSC titles and control bytes', () => {
    expect(stripAnsi('\u001b[1;31mred\u001b[0m \u001b[2K\u001b]0;title\u0007ok\u0000')).toBe(
      'red ok',
    );
    expect(stripAnsi('tab\tand\nnewline')).toBe('tab\tand\nnewline');
  });
});
