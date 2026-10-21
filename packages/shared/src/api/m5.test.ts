import { describe, expect, it } from 'vitest';
import { SubmitTaskInputSchema, mcpAddCommand } from './m5';
import { TaskOfferPayloadSchema } from '../protocol/messages';

describe('m5 contract', () => {
  it('builds the claude mcp add command', () => {
    expect(mcpAddCommand('https://orch.example.org/', 'orch_pat_x')).toBe(
      'claude mcp add --transport http --scope user orch https://orch.example.org/mcp --header "Authorization: Bearer orch_pat_x"',
    );
  });

  it('defaults dispatch to pool and dependsOn to []', () => {
    const r = SubmitTaskInputSchema.parse({
      projectFullName: 'acme/app',
      tasks: [
        {
          ref: 'a',
          title: 't',
          description: 'd',
          acceptanceCriteria: ['ok'],
          size: 'S',
          model: 'sonnet',
        },
      ],
    });
    expect(r.dispatch).toEqual({ mode: 'pool' });
    expect(r.tasks[0]!.dependsOn).toEqual([]);
    expect(() => SubmitTaskInputSchema.parse({ ...r, integrationBranch: 'feat/../x' })).toThrow();
  });

  it('task.offer accepts the additive initiatedBy field', () => {
    const base = {
      assignmentId: 'a1',
      kind: 'CLAIM',
      expiresAt: null,
      task: {
        taskId: 't',
        project: { id: 'p', fullName: 'acme/app', defaultBranch: 'main' },
        issueNumber: 1,
        title: 'x',
        prompt: 'x',
        bodyHash: 'h',
        acceptanceCriteria: [],
        size: 'S',
        model: 'SONNET',
        baseBranch: 'main',
        branchName: 'orch/issue-1-x',
        createdBy: { login: 'o' },
      },
    };
    expect(TaskOfferPayloadSchema.parse({ ...base, initiatedBy: 'server' }).initiatedBy).toBe(
      'server',
    );
    expect(TaskOfferPayloadSchema.parse(base).initiatedBy).toBeUndefined();
  });
});
