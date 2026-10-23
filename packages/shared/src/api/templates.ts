/**
 * Task templates: reusable task skeletons with `{{placeholders}}`.
 *
 * REST routes (cookie session, JSON, every route under /api):
 *   GET    /api/templates?projectId=        -> TaskTemplateView[]
 *          The built-in templates (read-only, defined in code), the caller's personal templates
 *          and, with `projectId` (a project the caller can see), that project's shared templates.
 *   POST   /api/templates                   CreateTemplateRequest -> TaskTemplateView (201)
 *          scope `personal`: anyone. scope `project`: the project owner only (403 otherwise, 404
 *          when the project is not visible to the caller).
 *   PATCH  /api/templates/:id               UpdateTemplateRequest -> TaskTemplateView
 *          Personal: its owner (404 for others). Project: the project owner (403 for other
 *          members). Built-ins: 403 `template_readonly`.
 *   DELETE /api/templates/:id               -> 204 (same rights as PATCH)
 *   POST   /api/templates/:id/render        RenderTemplateRequest -> RenderedTemplate
 *          Same rights as "use": personal = owner, project = anyone who sees the project.
 *          400 `missing_variables` / `unknown_variables` / `invalid_variable`.
 *
 * Rendering is a pure function (`renderTemplate`) shared by the web preview, the REST render
 * endpoint and the MCP `submit_task` tool: values are inserted in ONE pass (a value containing
 * `{{x}}` is never expanded again), HTML comments are neutralised (the issue body carries a
 * hidden orch metadata block), the title is collapsed to one line.
 *
 * Errors: HTTP status + `{ error: { code, message } }` (see ApiErrorSchema in m1).
 */
import { z } from 'zod';
import { Model } from '../domain/enums';
import { TaskSize } from '../protocol/messages';

export const TEMPLATE_LIMITS = {
  name: 80,
  description: 400,
  title: 200,
  body: 20_000,
  criterion: 500,
  criteria: 30,
  labels: 5,
  placeholders: 20,
  value: 5_000,
  perScope: 50,
} as const;

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g;
/** Any `{{...}}` group, to spot malformed placeholders. */
const BRACES_RE = /\{\{([^{}]*)\}\}/g;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Distinct placeholder names, in order of first appearance. */
export function extractPlaceholders(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(PLACEHOLDER_RE)) seen.add(m[1]!);
  }
  return [...seen];
}

/** `{{ not valid }}`-style braces whose content is not a placeholder name. */
export function malformedPlaceholders(...texts: string[]): string[] {
  const bad: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(BRACES_RE)) {
      if (!NAME_RE.test(m[1]!.trim())) bad.push(m[0]);
    }
  }
  return bad;
}

export type TemplatePart = { type: 'text'; value: string } | { type: 'slot'; name: string };

/** Splits a template text into literal text and placeholder slots (for rich previews). */
export function splitTemplate(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
    parts.push({ type: 'slot', name: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Makes a user value safe to put in an issue body: no control chars, no HTML comment markers. */
export function sanitizeValue(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, '')
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .trim();
}

export type TemplateErrorCode = 'missing_variables' | 'unknown_variables' | 'invalid_variable';

export class TemplateError extends Error {
  constructor(
    readonly code: TemplateErrorCode,
    message: string,
    readonly names: string[],
  ) {
    super(message);
  }
}

function fill(text: string, values: Record<string, string>, singleLine: boolean): string {
  const out = text.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = values[name] ?? '';
    return singleLine ? v.replace(/\s+/g, ' ') : v;
  });
  return singleLine ? out.replace(/\s+/g, ' ').trim() : out;
}

export type DependenciesMode = 'none' | 'ask';

export interface TemplateSource {
  titleTemplate: string;
  bodyTemplate: string;
  acceptanceCriteria: string[];
  size: TaskSize;
  model: Model;
  labels: string[];
  dependenciesMode: DependenciesMode;
}

export interface RenderedTemplate {
  title: string;
  body: string;
  acceptanceCriteria: string[];
  size: TaskSize;
  model: Model;
  labels: string[];
  dependenciesMode: DependenciesMode;
}

export function placeholdersOf(
  t: Pick<TemplateSource, 'titleTemplate' | 'bodyTemplate' | 'acceptanceCriteria'>,
): string[] {
  return extractPlaceholders(t.titleTemplate, t.bodyTemplate, ...t.acceptanceCriteria);
}

/** Validates the variables against the template's placeholders and returns the sanitised values. */
export function checkVariables(
  names: string[],
  variables: Record<string, string>,
): Record<string, string> {
  const unknown = Object.keys(variables).filter((k) => !names.includes(k));
  if (unknown.length > 0) {
    throw new TemplateError(
      'unknown_variables',
      `Unknown variables: ${unknown.join(', ')}`,
      unknown,
    );
  }
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const n of names) {
    const raw = variables[n];
    const v = sanitizeValue(typeof raw === 'string' ? raw : '');
    if (v === '') missing.push(n);
    else if (v.length > TEMPLATE_LIMITS.value) {
      throw new TemplateError(
        'invalid_variable',
        `Variable "${n}" is longer than ${TEMPLATE_LIMITS.value} characters`,
        [n],
      );
    } else values[n] = v;
  }
  if (missing.length > 0) {
    throw new TemplateError(
      'missing_variables',
      `Missing variables: ${missing.join(', ')}`,
      missing,
    );
  }
  return values;
}

/** Renders a template. Throws `TemplateError` when a variable is missing, unknown or too long. */
export function renderTemplate(
  t: TemplateSource,
  variables: Record<string, string>,
): RenderedTemplate {
  const values = checkVariables(placeholdersOf(t), variables);
  const title = fill(t.titleTemplate, values, true).slice(0, TEMPLATE_LIMITS.title).trim();
  const body = fill(t.bodyTemplate, values, false).trim();
  if (body.length > 60_000) {
    throw new TemplateError('invalid_variable', 'The rendered description is too long', []);
  }
  return {
    title,
    body,
    acceptanceCriteria: t.acceptanceCriteria
      .map((c) => fill(c, values, true).slice(0, TEMPLATE_LIMITS.criterion))
      .filter((c) => c !== ''),
    size: t.size,
    model: t.model,
    labels: t.labels,
    dependenciesMode: t.dependenciesMode,
  };
}

/** Like `renderTemplate`, but never throws: unfilled placeholders stay visible (live preview). */
export function previewTemplate(
  t: TemplateSource,
  variables: Record<string, string>,
): RenderedTemplate {
  const values: Record<string, string> = {};
  for (const n of placeholdersOf(t)) {
    const v = sanitizeValue(variables[n] ?? '').slice(0, TEMPLATE_LIMITS.value);
    values[n] = v === '' ? `{{${n}}}` : v;
  }
  return {
    title: fill(t.titleTemplate, values, true),
    body: fill(t.bodyTemplate, values, false).trim(),
    acceptanceCriteria: t.acceptanceCriteria.map((c) => fill(c, values, true)),
    size: t.size,
    model: t.model,
    labels: t.labels,
    dependenciesMode: t.dependenciesMode,
  };
}

// ---------- schemas ----------

export const DependenciesModeSchema = z.enum(['none', 'ask']);

export const TemplateScope = z.enum(['builtin', 'personal', 'project']);
export type TemplateScope = z.infer<typeof TemplateScope>;

export const TemplateLabel = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,49}$/, 'Invalid label');

const singleLine = (s: string) => !/[\r\n]/.test(s);
const noComment = (s: string) => !s.includes('<!--') && !s.includes('-->');

const nameField = z
  .string()
  .trim()
  .min(1)
  .max(TEMPLATE_LIMITS.name)
  .refine(singleLine, 'Must be a single line');
const descriptionField = z.string().trim().max(TEMPLATE_LIMITS.description);
const titleField = z
  .string()
  .max(TEMPLATE_LIMITS.title)
  .refine(singleLine, 'Must be a single line')
  .refine(noComment, 'HTML comments are not allowed');
const bodyField = z
  .string()
  .max(TEMPLATE_LIMITS.body)
  .refine((s) => s.trim() !== '', 'Required')
  .refine(noComment, 'HTML comments are not allowed');
const criteriaField = z
  .array(
    z
      .string()
      .max(TEMPLATE_LIMITS.criterion)
      .refine((s) => s.trim() !== '' && singleLine(s), 'One non-empty line each')
      .refine(noComment, 'HTML comments are not allowed'),
  )
  .max(TEMPLATE_LIMITS.criteria);
const labelsField = z.array(TemplateLabel).max(TEMPLATE_LIMITS.labels);

type TextParts = {
  titleTemplate?: string | undefined;
  bodyTemplate?: string | undefined;
  acceptanceCriteria?: string[] | undefined;
};
function checkPlaceholders(t: TextParts, ctx: z.RefinementCtx) {
  const texts = [t.titleTemplate ?? '', t.bodyTemplate ?? '', ...(t.acceptanceCriteria ?? [])];
  const bad = malformedPlaceholders(...texts);
  if (bad.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['bodyTemplate'],
      message: `Invalid placeholder ${bad[0]}: use letters, digits and underscores, e.g. {{module}}`,
    });
  }
  if (extractPlaceholders(...texts).length > TEMPLATE_LIMITS.placeholders) {
    ctx.addIssue({
      code: 'custom',
      path: ['bodyTemplate'],
      message: `At most ${TEMPLATE_LIMITS.placeholders} different placeholders`,
    });
  }
}

/** The editable part of a template. */
export const TemplateFieldsSchema = z.object({
  name: nameField,
  description: descriptionField.default(''),
  titleTemplate: titleField.default(''),
  bodyTemplate: bodyField,
  acceptanceCriteria: criteriaField.default([]),
  size: TaskSize.default('M'),
  model: Model.default('SONNET'),
  labels: labelsField.default([]),
  dependenciesMode: DependenciesModeSchema.default('none'),
});
export type TemplateFields = z.infer<typeof TemplateFieldsSchema>;

export const CreateTemplateRequestSchema = TemplateFieldsSchema.extend({
  scope: z.enum(['personal', 'project']),
  projectId: z.string().min(1).optional(),
}).superRefine((t, ctx) => {
  if (t.scope === 'project' && !t.projectId) {
    ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'projectId is required' });
  }
  checkPlaceholders(t, ctx);
});
export type CreateTemplateRequest = z.input<typeof CreateTemplateRequestSchema>;

export const UpdateTemplateRequestSchema = z
  .object({
    name: nameField,
    description: descriptionField,
    titleTemplate: titleField,
    bodyTemplate: bodyField,
    acceptanceCriteria: criteriaField,
    size: TaskSize,
    model: Model,
    labels: labelsField,
    dependenciesMode: DependenciesModeSchema,
  })
  .partial()
  .superRefine((t, ctx) => checkPlaceholders(t, ctx));
export type UpdateTemplateRequest = z.input<typeof UpdateTemplateRequestSchema>;

export const TemplateVariablesSchema = z.record(
  z.string().regex(NAME_RE),
  z.string().max(TEMPLATE_LIMITS.value * 2),
);

export const RenderTemplateRequestSchema = z.object({
  variables: TemplateVariablesSchema.default({}),
});
export type RenderTemplateRequest = z.input<typeof RenderTemplateRequestSchema>;

export const RenderedTemplateSchema = z.object({
  title: z.string(),
  body: z.string(),
  acceptanceCriteria: z.array(z.string()),
  size: TaskSize,
  model: Model,
  labels: z.array(z.string()),
  dependenciesMode: DependenciesModeSchema,
});

export const TaskTemplateViewSchema = z.object({
  id: z.string(),
  scope: TemplateScope,
  projectId: z.string().nullable(),
  projectFullName: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  titleTemplate: z.string(),
  bodyTemplate: z.string(),
  acceptanceCriteria: z.array(z.string()),
  size: TaskSize,
  model: Model,
  labels: z.array(z.string()),
  dependenciesMode: DependenciesModeSchema,
  placeholders: z.array(z.string()),
  createdBy: z.string().nullable(),
  canEdit: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type TaskTemplateView = z.infer<typeof TaskTemplateViewSchema>;

// ---------- built-in templates (code, not database) ----------

type Builtin = TemplateFields & { slug: string };

export const BUILTIN_TEMPLATES: readonly Builtin[] = [
  {
    slug: 'fix-bug',
    name: 'Fix a bug',
    description: 'Reproduce, fix and pin down a defect with a regression test.',
    titleTemplate: 'Fix: {{summary}}',
    bodyTemplate: `## Problem

{{summary}}

## Where it happens

{{location}}

## Steps to reproduce

{{steps}}

## Expected behavior

{{expected}}

## Approach

1. Reproduce the bug and write a failing test that captures it.
2. Find the root cause rather than patching the symptom.
3. Fix it with the smallest change that makes the test pass.
4. Run the full test suite and the linter before finishing.`,
    acceptanceCriteria: [
      'A regression test fails before the fix and passes after it',
      'Expected behavior holds: {{expected}}',
      'The existing test suite, linter and type checks still pass',
    ],
    size: 'M',
    model: 'SONNET',
    labels: ['bug'],
    dependenciesMode: 'none',
  },
  {
    slug: 'upgrade-dependency',
    name: 'Upgrade a dependency',
    description: 'Move one package to a new version and fix what breaks.',
    titleTemplate: 'Upgrade {{package}} to {{version}}',
    bodyTemplate: `## Goal

Upgrade \`{{package}}\` to \`{{version}}\`.

## Notes

{{notes}}

## Approach

1. Read the changelog and migration guide of \`{{package}}\` between the current and the target version.
2. Bump the version in the manifest and refresh the lockfile with the project's package manager.
3. Fix deprecations and breaking changes, touching only what the upgrade requires.
4. Run the build, linter, type checks and tests.

Do not bundle unrelated upgrades or refactors in this change.`,
    acceptanceCriteria: [
      '`{{package}}` is at `{{version}}` in the manifest and the lockfile',
      'Build, linter, type checks and tests pass',
      'No deprecation warnings introduced by this upgrade remain',
    ],
    size: 'S',
    model: 'SONNET',
    labels: ['dependencies'],
    dependenciesMode: 'none',
  },
  {
    slug: 'add-tests',
    name: 'Add tests',
    description: 'Cover an untested area with meaningful, deterministic tests.',
    titleTemplate: 'Add tests for {{target}}',
    bodyTemplate: `## Goal

Add automated tests for \`{{target}}\`.

## Behavior to cover

{{behaviors}}

## Approach

1. Read \`{{target}}\` and the existing tests next to it; follow their style, helpers and naming.
2. Cover the main behavior, edge cases and error paths listed above.
3. Keep tests fast and deterministic: no network, no real clock, no shared state between tests.
4. Do not change production code unless a test reveals a real bug; if so, describe it in the PR.`,
    acceptanceCriteria: [
      'New tests cover the behavior listed for `{{target}}`',
      'Tests are deterministic and pass on repeated runs',
      'The whole suite and the linter pass',
    ],
    size: 'M',
    model: 'SONNET',
    labels: ['tests'],
    dependenciesMode: 'none',
  },
  {
    slug: 'refactor-module',
    name: 'Refactor module',
    description: 'Restructure code for a stated reason without changing behavior.',
    titleTemplate: 'Refactor {{module}}',
    bodyTemplate: `## Goal

Refactor \`{{module}}\`.

## Motivation

{{motivation}}

## Constraints

Behavior must not change: this is a pure refactor.

## Approach

1. Make sure the current behavior is covered by tests; add characterization tests first if it is not.
2. Refactor in small steps, running the tests after each one.
3. Keep the public interface of \`{{module}}\` stable unless the motivation says otherwise.
4. Remove code that becomes dead, and nothing more.`,
    acceptanceCriteria: [
      'Behavior of `{{module}}` is unchanged and its tests pass without modification',
      'The motivation above is addressed',
      'Linter and type checks pass',
    ],
    size: 'L',
    model: 'OPUS',
    labels: ['refactor'],
    dependenciesMode: 'ask',
  },
];

export const builtinId = (slug: string) => `builtin:${slug}`;

export function builtinViews(): TaskTemplateView[] {
  return BUILTIN_TEMPLATES.map(({ slug, ...f }) => ({
    id: builtinId(slug),
    scope: 'builtin' as const,
    projectId: null,
    projectFullName: null,
    ...f,
    placeholders: placeholdersOf(f),
    createdBy: null,
    canEdit: false,
    createdAt: null,
    updatedAt: null,
  }));
}
