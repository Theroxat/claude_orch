import { z } from 'zod';
import { Policy, Visibility } from './enums';

export const ProjectSchema = z.object({
  id: z.string(),
  githubRepoId: z.coerce.bigint(),
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/repo"'),
  installationId: z.string(),
  defaultBranch: z.string().min(1),
  isPrivate: z.boolean(),
  visibility: Visibility,
  participationPolicy: Policy,
  submissionPolicy: Policy,
  poolLabel: z.string().min(1),
  requireParticipantApproval: z.boolean(),
  archivedAt: z.coerce.date().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectSettingsUpdateSchema = ProjectSchema.pick({
  visibility: true,
  participationPolicy: true,
  submissionPolicy: true,
  poolLabel: true,
  requireParticipantApproval: true,
}).partial();
export type ProjectSettingsUpdate = z.infer<typeof ProjectSettingsUpdateSchema>;
