/**
 * Onboarding contract: `GET /api/onboarding` (cookie session) -> OnboardingResponse.
 * Computed from existing data (no table). Each step is `done` (true/false) with a `state`:
 * `unknown` means the server cannot tell yet (never counts as done).
 *
 * `claude_connected` comes from the agent-reported `claudeTokenPresent` (in `hello` and
 * `usage.report`): done when any live agent reports true, todo when a live agent reports false,
 * unknown without data.
 */
import { z } from 'zod';

export const OnboardingStepId = z.enum([
  'github_app_installed',
  'project_added',
  'participation_set',
  'agent_connected',
  'claude_connected',
  'mcp_connected',
]);
export type OnboardingStepId = z.infer<typeof OnboardingStepId>;

export const OnboardingStepSchema = z.object({
  id: OnboardingStepId,
  done: z.boolean(),
  state: z.enum(['done', 'todo', 'unknown']),
  /** Why a step is `todo` again, e.g. `claude_login_expired` for `claude_connected`. */
  reason: z.string().optional(),
  /**
   * `claude_connected` detail (v0.5.2). `reason` is `claude_login_expired` (todo: Claude rejected
   * the token), `claude_login_unverified` (done, but no real check yet: run `orch doctor`) or
   * `claude_check_inconclusive` (done, the last check could not run: `errorClass`).
   * Absent `reason` on a done step with `checkedAt`: the login was verified at that time.
   */
  agentName: z.string().optional(),
  checkedAt: z.string().nullish(),
  errorClass: z.string().nullish(),
});
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const OnboardingResponseSchema = z.object({
  steps: z.array(OnboardingStepSchema),
});
export type OnboardingResponse = z.infer<typeof OnboardingResponseSchema>;
