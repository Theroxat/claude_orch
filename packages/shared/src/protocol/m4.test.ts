import { describe, expect, it } from 'vitest';
import { parseServerMessage, serverMessage, type TaskOfferPayload } from './index';
import { CreateTaskRequestSchema } from '../api/m3';
import { DispatchRequestSchema } from '../api/dispatch';

const task: TaskOfferPayload['task'] = {
  taskId: 't1',
  project: { id: 'p1', fullName: 'acme/x', defaultBranch: 'main' },
  issueNumber: 3,
  title: 'T',
  prompt: 'do it',
  bodyHash: 'h',
  acceptanceCriteria: [],
  size: 'S',
  model: 'SONNET',
  baseBranch: 'main',
  branchName: 'orch/issue-3-t',
  createdBy: { login: 'o' },
};

describe('M4 protocol additions', () => {
  it('parses an M3-shaped offer (new fields are optional)', () => {
    const m = serverMessage('task.offer', {
      assignmentId: 'a',
      kind: 'CLAIM',
      expiresAt: null,
      task,
    });
    expect(parseServerMessage(JSON.stringify(m)).ok).toBe(true);
  });

  it('parses an AUTO_OFFER with execMode, timeout and integration branch', () => {
    const m = serverMessage('task.offer', {
      assignmentId: 'a',
      kind: 'AUTO_OFFER',
      expiresAt: new Date().toISOString(),
      execMode: 'AUTO',
      accepted: false,
      timeoutSec: 1800,
      task: { ...task, integrationBranch: 'feat/x', baseBranch: 'feat/x' },
    });
    const r = parseServerMessage(JSON.stringify(m));
    expect(r.ok && r.message.type === 'task.offer' && r.message.payload.execMode).toBe('AUTO');
  });

  it('parses offer.request and offer.withdrawn', () => {
    const req = serverMessage('offer.request', {
      assignmentId: 'a',
      expiresAt: null,
      task: {
        taskId: 't',
        project: { id: 'p', fullName: 'acme/x' },
        issueNumber: 1,
        title: 'T',
        size: 'M',
        model: 'OPUS',
        createdBy: { login: 'o' },
      },
    });
    expect(parseServerMessage(req).ok).toBe(true);
    expect(
      parseServerMessage(serverMessage('offer.withdrawn', { assignmentId: 'a', reason: 'taken' }))
        .ok,
    ).toBe(true);
  });

  it('dispatch is optional on task creation and members needs ids', () => {
    expect(CreateTaskRequestSchema.parse({ title: 'x' }).dispatch).toBeUndefined();
    expect(DispatchRequestSchema.safeParse({ mode: 'members' }).success).toBe(false);
    expect(DispatchRequestSchema.safeParse({ mode: 'members', memberIds: ['u'] }).success).toBe(
      true,
    );
    expect(DispatchRequestSchema.safeParse({ mode: 'broadcast' }).success).toBe(true);
  });
});
