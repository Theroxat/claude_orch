import { createHash } from 'node:crypto';
import { Model, TaskSize } from '@orch/shared';
import { z } from 'zod';

/** Machine-readable orch metadata stored in a hidden block of the GitHub issue body. */
export const IssueMetaSchema = z.object({
  v: z.literal(1),
  size: TaskSize.catch('M'),
  model: Model.catch('SONNET'),
  acceptanceCriteria: z.array(z.string()).catch([]),
  /** Issue numbers of the tasks this one depends on. */
  dependsOn: z.array(z.number().int().positive()).catch([]),
  integrationBranch: z.string().nullable().catch(null),
});
export type IssueMeta = z.infer<typeof IssueMetaSchema>;

const BEGIN = '<!-- orch:begin -->';
const END = '<!-- orch:end -->';
const BLOCK_RE = /<!-- orch:begin -->([\s\S]*?)<!-- orch:end -->/;
const META_RE = /<!-- orch:meta (\{[\s\S]*?\}) -->/;

/** Issue body: the description, then a visible checklist and the hidden metadata. */
export function buildIssueBody(description: string, meta: IssueMeta): string {
  const json = JSON.stringify(meta).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const lines = [BEGIN];
  if (meta.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance criteria', ...meta.acceptanceCriteria.map((c) => `- [ ] ${c}`), '');
  }
  lines.push(`<!-- orch:meta ${json} -->`, END);
  return `${description.trim()}\n\n${lines.join('\n')}\n`;
}

/** Splits an issue body into the plain description and the orch metadata (if any). */
export function parseIssueBody(body: string | null | undefined): {
  description: string;
  meta: IssueMeta | null;
} {
  const text = body ?? '';
  const block = BLOCK_RE.exec(text);
  let meta: IssueMeta | null = null;
  if (block) {
    const m = META_RE.exec(block[1] ?? '');
    if (m) {
      try {
        const parsed = IssueMetaSchema.safeParse(JSON.parse(m[1] ?? ''));
        if (parsed.success) meta = parsed.data;
      } catch {
        meta = null;
      }
    }
  }
  const description = text.replace(BLOCK_RE, '').trim();
  return { description, meta };
}

export const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex');

export function branchNameFor(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `orch/issue-${issueNumber}${slug ? `-${slug}` : ''}`;
}

/**
 * `task.createdBy` of a task offer: the agent credits the creator as the commit author. A GitHub
 * id outside the safe integer range is left out (the agent then keeps its own identity).
 */
export function creatorOf(u: { login: string; githubId: bigint }): {
  login: string;
  githubId?: number;
} {
  const id = Number(u.githubId);
  return Number.isSafeInteger(id) && id > 0 ? { login: u.login, githubId: id } : { login: u.login };
}
