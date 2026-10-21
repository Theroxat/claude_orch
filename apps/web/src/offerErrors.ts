import { ApiError } from './api/client';

const MESSAGES: Record<string, string> = {
  offer_closed: 'This request is no longer available: it was taken, withdrawn or has expired.',
  paused: 'Your agent is paused: resume it in My Server first.',
  no_agent_online: 'Your machine is offline: start your agent first.',
  concurrency: 'Your agent is already running a task: wait for it to finish.',
  not_participating: 'You no longer participate in this project.',
};

export function offerErrorMessage(e: unknown): string {
  if (e instanceof ApiError) return MESSAGES[e.code] ?? e.message;
  return e instanceof Error ? e.message : 'Something went wrong.';
}
