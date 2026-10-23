import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  CreateTemplateRequestSchema,
  TemplateError,
  TemplateFieldsSchema,
  builtinViews,
  extractPlaceholders,
  previewTemplate,
  renderTemplate,
  sanitizeValue,
  splitTemplate,
} from './index';

const tpl = {
  titleTemplate: 'Fix {{what}}',
  bodyTemplate: 'Fix {{what}} in {{ where }}.',
  acceptanceCriteria: ['{{what}} is fixed'],
  size: 'S' as const,
  model: 'SONNET' as const,
  labels: [],
  dependenciesMode: 'none' as const,
};

describe('templates', () => {
  it('extracts placeholders once, in order', () => {
    expect(extractPlaceholders('{{a}} {{ b }} {{a}}', '{{c}}')).toEqual(['a', 'b', 'c']);
    expect(splitTemplate('x {{a}} y')).toEqual([
      { type: 'text', value: 'x ' },
      { type: 'slot', name: 'a' },
      { type: 'text', value: ' y' },
    ]);
  });

  it('renders in one pass and reports missing or unknown variables', () => {
    const r = renderTemplate(tpl, { what: 'the {{where}}', where: 'parser' });
    expect(r.body).toBe('Fix the {{where}} in parser.');
    expect(r.title).toBe('Fix the {{where}}');
    expect(() => renderTemplate(tpl, { what: 'x' })).toThrow(TemplateError);
    try {
      renderTemplate(tpl, { what: 'x', where: '  ' });
    } catch (e) {
      expect((e as TemplateError).code).toBe('missing_variables');
      expect((e as TemplateError).names).toEqual(['where']);
    }
    expect(() => renderTemplate(tpl, { what: 'x', where: 'y', z: '1' })).toThrow(/Unknown/);
  });

  it('neutralises HTML comments and control characters, keeps the title on one line', () => {
    expect(sanitizeValue('a<!--b-->\u0007c\r\nd')).toBe('a&lt;!--b--&gt;c\nd');
    const r = renderTemplate(tpl, { what: 'a\n\nb', where: 'c' });
    expect(r.title).toBe('Fix a b');
  });

  it('previews without throwing and keeps unfilled slots visible', () => {
    expect(previewTemplate(tpl, { what: 'bug' }).body).toBe('Fix bug in {{where}}.');
  });

  it('validates fields', () => {
    const ok = { name: 'n', bodyTemplate: 'x {{a}}' };
    expect(TemplateFieldsSchema.safeParse(ok).success).toBe(true);
    const create = (over: object) =>
      CreateTemplateRequestSchema.safeParse({ scope: 'personal', ...ok, ...over }).success;
    expect(create({})).toBe(true);
    expect(create({ bodyTemplate: '{{1bad}}' })).toBe(false);
    expect(create({ bodyTemplate: 'a <!-- b -->' })).toBe(false);
    expect(create({ labels: ['ok label', 'also:ok'] })).toBe(true);
    expect(create({ labels: ['bad,label'] })).toBe(false);
    expect(CreateTemplateRequestSchema.safeParse({ scope: 'project', ...ok }).success).toBe(false);
  });

  it('ships four valid built-ins that render with their own placeholders', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.name)).toEqual([
      'Fix a bug',
      'Upgrade a dependency',
      'Add tests',
      'Refactor module',
    ]);
    for (const v of builtinViews()) {
      expect(v.placeholders.length).toBeGreaterThan(0);
      const vars = Object.fromEntries(v.placeholders.map((p) => [p, `<${p}>`]));
      const r = renderTemplate(v, vars);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.body).not.toMatch(/\{\{/);
    }
  });
});
