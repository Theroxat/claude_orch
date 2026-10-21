import { describe, expect, it } from 'vitest';
import { ParticipationUpdateSchema, ProjectSchema } from './index';

describe('shared schemas', () => {
  it('accepts a valid participation update', () => {
    const r = ParticipationUpdateSchema.safeParse({ active: true, percent: 30, mode: 'APPROVAL' });
    expect(r.success).toBe(true);
  });

  it('rejects a percent above 100', () => {
    const r = ParticipationUpdateSchema.safeParse({ active: true, percent: 101, mode: 'AUTO' });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed repo full name', () => {
    const r = ProjectSchema.shape.fullName.safeParse('not-a-repo');
    expect(r.success).toBe(false);
  });
});
