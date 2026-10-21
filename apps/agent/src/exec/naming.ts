/** Names derived from a task: branch, container, network, image, screen session, labels. */

/** Label put on every container, network and image of a task (orphan GC after a restart). */
export const TASK_LABEL = 'orch.task';
export const ISSUE_LABEL = 'orch.issue';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Assignment ids end up in paths and docker names: refuse anything unusual. */
export function assertSafeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Unsafe assignment id: ${JSON.stringify(id)}`);
  return id;
}

/** Lowercase ASCII slug, words joined by "-", at most `max` chars, never empty. */
export function slugify(title: string, max = 40): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = slug.slice(0, max).replace(/-+$/g, '');
  return cut === '' ? 'task' : cut;
}

/** `orch/issue-<n>-<slug>` (PLAN 5.1). */
export function branchName(issueNumber: number, title: string): string {
  return `orch/issue-${issueNumber}-${slugify(title)}`;
}

/** Conservative check of a git branch name received from the server. */
export function isValidBranch(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.split('/').some((p) => p.startsWith('.'))
  );
}

/** The server's branch name when valid, else `orch/issue-<n>-<slug>`. */
export function pickBranch(serverBranch: string, issueNumber: number, title: string): string {
  return serverBranch && isValidBranch(serverBranch)
    ? serverBranch
    : branchName(issueNumber, title);
}

const dockerSafe = (id: string) => assertSafeId(id).toLowerCase().replace(/_/g, '-');

export const containerName = (issueNumber: number, assignmentId: string) =>
  `orch-task-${issueNumber}-${dockerSafe(assignmentId)}`;
export const networkName = (assignmentId: string) => `orch-net-${dockerSafe(assignmentId)}`;
export const imageTag = (assignmentId: string) => `orch-task-${dockerSafe(assignmentId)}:latest`;
export const composeProject = (assignmentId: string) => `orch-task-${dockerSafe(assignmentId)}`;
export const COMPOSE_PROJECT_PREFIX = 'orch-task-';
export const screenName = (issueNumber: number) => `issue-${issueNumber}`;

export const attachCommand = (issueNumber: number) =>
  `docker compose -f ~/orch/compose.yaml exec agent screen -r ${screenName(issueNumber)}`;

export const taskLabels = (assignmentId: string, issueNumber: number): Record<string, string> => ({
  [TASK_LABEL]: assignmentId,
  [ISSUE_LABEL]: String(issueNumber),
});

/** Claude CLI model alias for the protocol enum. */
export const claudeModel = (model: string) => model.toLowerCase();

const ISSUE_RE = /^(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#)?(\d+)$/;

/** Parses `<n>` or `<owner/repo>#<n>`. */
export function parseIssueRef(ref: string): { project?: string; issue: number } | null {
  const m = ISSUE_RE.exec(ref.trim());
  if (!m) return null;
  const issue = Number(m[2]);
  if (!Number.isSafeInteger(issue) || issue <= 0) return null;
  return m[1] ? { project: m[1], issue } : { issue };
}
