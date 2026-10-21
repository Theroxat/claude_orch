import { z } from 'zod';
import { GithubRole } from './enums';

export const ProjectPermissionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  githubRole: GithubRole,
  /** null = derive from githubRole; set only by the project owner. */
  canSubmit: z.boolean().nullable(),
  canParticipate: z.boolean().nullable(),
  syncedAt: z.coerce.date(),
});
export type ProjectPermission = z.infer<typeof ProjectPermissionSchema>;
