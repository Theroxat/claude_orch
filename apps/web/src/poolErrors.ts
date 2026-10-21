import { ApiError } from './api/client';

/**
 * The pool of a project is visible to its owner and active participants only. A submitter who
 * does not participate gets a 404 (or a `not_participating` answer): say so instead of
 * "Project not found" or nothing at all.
 */
export function poolErrorMessage(e: unknown): string {
  if (e instanceof ApiError && (e.status === 404 || e.code === 'not_participating')) {
    return 'You do not participate in this project, so its pool is not visible to you. Join it from Discover to pick members.';
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}
