import { z } from 'zod';

export const UserSchema = z.object({
  id: z.string(),
  githubId: z.coerce.bigint(),
  login: z.string().min(1),
  name: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  paused: z.boolean(),
  maxConcurrent: z.number().int().min(1),
  maxPendingTasks: z.number().int().min(0),
});
export type User = z.infer<typeof UserSchema>;

/** What the web client may see about a user. */
export const PublicUserSchema = UserSchema.pick({
  id: true,
  login: true,
  name: true,
  avatarUrl: true,
});
export type PublicUser = z.infer<typeof PublicUserSchema>;
