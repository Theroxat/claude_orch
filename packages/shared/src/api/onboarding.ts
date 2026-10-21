/**
 * Onboarding contract: `GET /api/onboarding` (cookie session) -> OnboardingResponse.
 * Computed from existing data (no table). Each step is `done` (true/false) with a `state`:
 * `unknown` means the server cannot tell yet (never counts as done).
 *
 * `claude_connected` is `unknown` until the agent reports the Claude token presence. Field the
 * agent should send: `claudeTokenPresent: boolean` (optional) in the `hello` payload and in the
 * `usage.report` payload.
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
});
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const OnboardingResponseSchema = z.object({
  steps: z.array(OnboardingStepSchema),
});
export type OnboardingResponse = z.infer<typeof OnboardingResponseSchema>;
