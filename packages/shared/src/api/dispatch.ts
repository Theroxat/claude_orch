/** M4 dispatch targeting, shared by task creation (m3) and the M4 views. */
import { z } from 'zod';

export const DispatchMode = z.enum(['pool', 'members', 'broadcast']);
export type DispatchMode = z.infer<typeof DispatchMode>;

/**
 * - `pool` (default): the best candidate per the assignment algorithm.
 * - `members`: only these members (user ids). They must participate in the project.
 * - `broadcast` (project owner only): ONE execution. The best AUTO-mode candidate gets an auto
 *   offer and every eligible APPROVAL-mode member gets a request at the same time. The first
 *   acceptance wins; the other offers and requests are withdrawn.
 * Consent is never bypassed: approval-mode members only ever get requests.
 */
export const DispatchRequestSchema = z
  .object({
    mode: DispatchMode,
    memberIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .refine((d) => d.mode !== 'members' || (d.memberIds?.length ?? 0) > 0, {
    message: 'memberIds is required when mode is "members"',
    path: ['memberIds'],
  });
export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;

export const DispatchViewSchema = z.object({
  mode: DispatchMode,
  /** Empty unless mode is `members`. */
  memberIds: z.array(z.string()),
});
export type DispatchView = z.infer<typeof DispatchViewSchema>;
