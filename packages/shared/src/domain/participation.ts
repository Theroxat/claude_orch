import { z } from 'zod';
import { Model, ParticipationMode } from './enums';

export const ParticipationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  projectId: z.string(),
  active: z.boolean(),
  /** Set by an owner when the project requires approval; null = pending. */
  approvedAt: z.coerce.date().nullable(),
  percent: z.number().int().min(0).max(100),
  mode: ParticipationMode,
  allowedModels: z.array(Model).min(1),
});
export type Participation = z.infer<typeof ParticipationSchema>;

/** Payload a member sends to change their own participation. */
export const ParticipationUpdateSchema = z.object({
  active: z.boolean(),
  percent: z.number().int().min(0).max(100),
  mode: ParticipationMode,
  allowedModels: z.array(Model).min(1).optional(),
});
export type ParticipationUpdate = z.infer<typeof ParticipationUpdateSchema>;
