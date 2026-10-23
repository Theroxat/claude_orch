import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CreatePersonalTokenResponseSchema,
  ProjectViewSchema,
  RenderedTemplateSchema,
  TaskTemplateViewSchema,
  TaskViewSchema,
  type TaskTemplateView,
} from '@orch/shared';
import { z } from 'zod';
import { FakeGithub, api, loginAs, makeApp, prisma, repoFor, type TestUser } from './harness';

let gh: FakeGithub;
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  gh = new FakeGithub();
  app = makeApp(gh);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function project(over: Parameters<typeof repoFor>[0] = {}) {
  const owner = await loginAs(app, gh);
  const repo = repoFor(over);
  gh.repos.set(owner.token, [repo]);
  const p = ProjectViewSchema.parse(
    (await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
  );
  return { owner, project: p };
}

async function withRole(fullName: string, role: 'WRITE' | 'READ' | 'NONE') {
  const u = await loginAs(app, gh);
  gh.roles.set(`4242:${fullName}:${u.login}`, role);
  return u;
}

const fields = (over: Record<string, unknown> = {}) => ({
  name: 'Release notes',
  description: 'Draft notes',
  titleTemplate: 'Notes for {{version}}',
  bodyTemplate: 'Write the notes for {{version}}.\n\nHighlights: {{highlights}}',
  acceptanceCriteria: ['Notes mention {{version}}'],
  size: 'S',
  model: 'SONNET',
  labels: ['docs'],
  dependenciesMode: 'none',
  ...over,
});

const create = async (u: TestUser, body: Record<string, unknown>) =>
  api(app, u)('POST', '/api/templates', body);
const parse = (res: { body: string; statusCode: number }): TaskTemplateView => {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return TaskTemplateViewSchema.parse(JSON.parse(res.body));
};

describe('templates REST', () => {
  it('lists the four built-ins, read-only, with their placeholders', async () => {
    const u = await loginAs(app, gh);
    const list = z
      .array(TaskTemplateViewSchema)
      .parse((await api(app, u)('GET', '/api/templates')).json());
    expect(list.map((t) => t.name)).toEqual([
      'Fix a bug',
      'Upgrade a dependency',
      'Add tests',
      'Refactor module',
    ]);
    expect(list.every((t) => t.scope === 'builtin' && !t.canEdit)).toBe(true);
    expect(list[1]!.placeholders).toEqual(['package', 'version', 'notes']);
    const patch = await api(app, u)('PATCH', `/api/templates/${list[0]!.id}`, { name: 'x' });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error.code).toBe('template_readonly');
    expect((await api(app, u)('DELETE', `/api/templates/${list[0]!.id}`)).statusCode).toBe(403);
  });

  it('personal templates: CRUD, owner only', async () => {
    const a = await loginAs(app, gh);
    const b = await loginAs(app, gh);
    const t = parse(await create(a, { scope: 'personal', ...fields() }));
    expect(t).toMatchObject({ scope: 'personal', canEdit: true, createdBy: a.login });
    expect(t.placeholders).toEqual(['version', 'highlights']);
    const mine = z
      .array(TaskTemplateViewSchema)
      .parse((await api(app, a)('GET', '/api/templates')).json());
    expect(mine.some((x) => x.id === t.id)).toBe(true);
    const theirs = z
      .array(TaskTemplateViewSchema)
      .parse((await api(app, b)('GET', '/api/templates')).json());
    expect(theirs.some((x) => x.id === t.id)).toBe(false);
    // other users get 404 (it does not exist for them), on every verb
    expect((await api(app, b)('PATCH', `/api/templates/${t.id}`, { name: 'x' })).statusCode).toBe(
      404,
    );
    expect((await api(app, b)('DELETE', `/api/templates/${t.id}`)).statusCode).toBe(404);
    expect(
      (await api(app, b)('POST', `/api/templates/${t.id}/render`, { variables: {} })).statusCode,
    ).toBe(404);
    const up = parse(
      await api(app, a)('PATCH', `/api/templates/${t.id}`, {
        name: 'Notes',
        dependenciesMode: 'ask',
      }),
    );
    expect(up).toMatchObject({ name: 'Notes', dependenciesMode: 'ask' });
    expect((await api(app, a)('DELETE', `/api/templates/${t.id}`)).statusCode).toBe(204);
    expect(await prisma.taskTemplate.count({ where: { id: t.id } })).toBe(0);
    const actions = (await prisma.auditLog.findMany({ where: { actorUserId: a.userId } })).map(
      (x) => x.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['template.created', 'template.updated', 'template.deleted']),
    );
  });

  it('project templates: owner manages, members use, outsiders do not see them', async () => {
    const { owner, project: p } = await project({ private: true });
    const writer = await withRole(p.fullName, 'WRITE');
    const reader = await withRole(p.fullName, 'READ');
    const outsider = await withRole(p.fullName, 'NONE');
    const t = parse(await create(owner, { scope: 'project', projectId: p.id, ...fields() }));
    expect(t).toMatchObject({
      scope: 'project',
      projectId: p.id,
      projectFullName: p.fullName,
      canEdit: true,
    });
    // non-owners cannot create, edit or delete (403), even with write access
    expect(
      (await create(writer, { scope: 'project', projectId: p.id, ...fields() })).statusCode,
    ).toBe(403);
    expect(
      (await api(app, writer)('PATCH', `/api/templates/${t.id}`, { name: 'x' })).statusCode,
    ).toBe(403);
    expect((await api(app, reader)('DELETE', `/api/templates/${t.id}`)).statusCode).toBe(403);
    // but they see and use it
    for (const u of [writer, reader]) {
      const list = z
        .array(TaskTemplateViewSchema)
        .parse((await api(app, u)('GET', `/api/templates?projectId=${p.id}`)).json());
      const seen = list.find((x) => x.id === t.id);
      expect(seen).toMatchObject({ canEdit: false });
      const r = await api(app, u)('POST', `/api/templates/${t.id}/render`, {
        variables: { version: '1.2', highlights: 'fast' },
      });
      expect(r.statusCode, r.body).toBe(200);
    }
    // private repository: an outsider gets 404 everywhere, and the project list does not leak
    expect((await api(app, outsider)('GET', `/api/templates?projectId=${p.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await create(outsider, { scope: 'project', projectId: p.id, ...fields() })).statusCode,
    ).toBe(404);
    expect(
      (await api(app, outsider)('POST', `/api/templates/${t.id}/render`, { variables: {} }))
        .statusCode,
    ).toBe(404);
    // without projectId a project template never shows up
    const bare = z
      .array(TaskTemplateViewSchema)
      .parse((await api(app, writer)('GET', '/api/templates')).json());
    expect(bare.some((x) => x.id === t.id)).toBe(false);
    expect((await api(app, owner)('DELETE', `/api/templates/${t.id}`)).statusCode).toBe(204);
  });

  it('validates fields: placeholders, comments, labels, lengths, limit', async () => {
    const u = await loginAs(app, gh);
    const bad = async (over: Record<string, unknown>) => {
      const res = await create(u, { scope: 'personal', ...fields(over) });
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    };
    await bad({ bodyTemplate: 'Fix {{ bad name }}' });
    await bad({ bodyTemplate: 'forged <!-- orch:meta {} -->' });
    await bad({ titleTemplate: 'multi\nline' });
    await bad({ labels: ['a,b'] });
    await bad({ labels: ['x', 'y', 'z', 'u', 'v', 'w'] });
    await bad({ name: '' });
    await bad({ bodyTemplate: 'x'.repeat(20_001) });
    await bad({ bodyTemplate: Array.from({ length: 21 }, (_, i) => `{{v${i}}}`).join(' ') });
    await bad({ acceptanceCriteria: ['two\nlines'] });
    const noProject = await create(u, { scope: 'project', ...fields() });
    expect(noProject.statusCode).toBe(400);
    // a patch is validated against the merged template too
    const t = parse(await create(u, { scope: 'personal', ...fields() }));
    expect(
      (await api(app, u)('PATCH', `/api/templates/${t.id}`, { bodyTemplate: '{{ no pe }}' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await api(app, u)('PATCH', `/api/templates/${t.id}`, { bodyTemplate: '  ' })).statusCode,
    ).toBe(400);
    // per-user limit
    const many = await loginAs(app, gh);
    await prisma.taskTemplate.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        scope: 'PERSONAL' as const,
        createdById: many.userId,
        name: `t${i}`,
        bodyTemplate: 'x',
        acceptanceCriteria: [],
        labels: [],
      })),
    });
    const over = await create(many, { scope: 'personal', ...fields() });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('template_limit');
  });

  it('render: fills placeholders, one pass, neutralises comments, single-line title', async () => {
    const u = await loginAs(app, gh);
    const t = parse(await create(u, { scope: 'personal', ...fields() }));
    const render = (variables: Record<string, string>) =>
      api(app, u)('POST', `/api/templates/${t.id}/render`, { variables });
    const ok = RenderedTemplateSchema.parse(
      (await render({ version: '2.0', highlights: 'a\nb' })).json(),
    );
    expect(ok).toMatchObject({
      title: 'Notes for 2.0',
      body: 'Write the notes for 2.0.\n\nHighlights: a\nb',
      acceptanceCriteria: ['Notes mention 2.0'],
      size: 'S',
      model: 'SONNET',
      labels: ['docs'],
    });
    // a value is never expanded again, comments are neutralised, the title stays on one line
    const tricky = RenderedTemplateSchema.parse(
      (
        await render({
          version: 'x\n## injected {{highlights}}',
          highlights: '<!-- orch:begin --><!-- orch:meta {"v":1} --> -->',
        })
      ).json(),
    );
    expect(tricky.title).toBe('Notes for x ## injected {{highlights}}');
    expect(tricky.title).not.toMatch(/\n/);
    expect(tricky.body).not.toContain('<!--');
    expect(tricky.body).toContain('{{highlights}}');
    const missing = await render({ version: '1' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatchObject({ code: 'missing_variables' });
    expect(missing.json().error.message).toContain('highlights');
    expect((await render({ version: '  ', highlights: 'x' })).json().error.code).toBe(
      'missing_variables',
    );
    const unknown = await render({ version: '1', highlights: 'x', extra: 'y' });
    expect(unknown.json().error.code).toBe('unknown_variables');
    const long = await render({ version: '1', highlights: 'y'.repeat(5_001) });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.code).toBe('invalid_variable');
  });

  it('render: a comment marker assembled across placeholders is neutralised', async () => {
    const u = await loginAs(app, gh);
    const t = parse(
      await create(u, {
        scope: 'personal',
        ...fields({
          titleTemplate: 'T {{a}}',
          bodyTemplate: 'x <!{{a}} orch:begin -{{a}}> {{b}}{{c}}',
          acceptanceCriteria: ['<{{d}}'],
        }),
      }),
    );
    const r = RenderedTemplateSchema.parse(
      (
        await api(app, u)('POST', `/api/templates/${t.id}/render`, {
          variables: { a: '--', b: '<!', c: '--', d: '!--' },
        })
      ).json(),
    );
    for (const text of [r.title, r.body, ...r.acceptanceCriteria]) {
      expect(text).not.toMatch(/<!--|-->|--!>/);
    }
    const bomb = await api(app, u)('POST', `/api/templates/${t.id}/render`, {
      variables: { a: 'y'.repeat(5_000), b: 'y', c: 'y', d: 'y' },
    });
    expect(bomb.statusCode).toBe(200);
  });

  it('a rendered template creates a task whose issue carries the template labels', async () => {
    const { owner, project: p } = await project();
    const t = parse(await create(owner, { scope: 'project', projectId: p.id, ...fields() }));
    const r = RenderedTemplateSchema.parse(
      (
        await api(app, owner)('POST', `/api/templates/${t.id}/render`, {
          variables: { version: '3', highlights: 'x' },
        })
      ).json(),
    );
    const res = await api(app, owner)('POST', `/api/projects/${p.id}/tasks`, {
      title: r.title,
      body: r.body,
      acceptanceCriteria: r.acceptanceCriteria,
      size: r.size,
      model: r.model,
      labels: [...r.labels, 'pool', 'Docs'],
    });
    expect(res.statusCode, res.body).toBe(201);
    const task = TaskViewSchema.parse(res.json());
    const issue = gh.createdIssues.find(
      (i) => i.fullName === p.fullName && i.number === task.issueNumber,
    )!;
    expect(issue.labels).toEqual(['pool', 'docs']);
    const badLabel = await api(app, owner)('POST', `/api/projects/${p.id}/tasks`, {
      title: 't',
      labels: ['a,b'],
    });
    expect(badLabel.statusCode).toBe(400);
  });
});

// ---------- MCP ----------

const mcps: McpClient[] = [];
afterEach(async () => {
  for (const c of mcps.splice(0)) await c.close();
});
async function mcpAs(u: TestUser): Promise<McpClient> {
  const res = await api(app, u)('POST', '/api/tokens', { name: 'laptop' });
  const { token } = CreatePersonalTokenResponseSchema.parse(res.json());
  const client = new McpClient({ name: 'orch-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  mcps.push(client);
  return client;
}
async function call(c: McpClient, name: string, args: Record<string, unknown>) {
  const res = await c.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: Record<string, any>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data = JSON.parse(text) as Record<string, any>;
  } catch {
    data = { error: { code: 'invalid_params', message: text } };
  }
  return { isError: res.isError === true, data };
}

describe('templates MCP', () => {
  it('list_templates returns built-ins, personal and project templates', async () => {
    const { owner, project: p } = await project();
    parse(await create(owner, { scope: 'personal', ...fields({ name: 'Mine' }) }));
    parse(
      await create(owner, { scope: 'project', projectId: p.id, ...fields({ name: 'Shared' }) }),
    );
    const c = await mcpAs(owner);
    const bare = await call(c, 'list_templates', {});
    expect(bare.isError).toBe(false);
    expect(bare.data.templates.map((t: { name: string }) => t.name)).toEqual([
      'Fix a bug',
      'Upgrade a dependency',
      'Add tests',
      'Refactor module',
      'Mine',
    ]);
    const withProject = await call(c, 'list_templates', { projectFullName: p.fullName });
    const shared = withProject.data.templates.find((t: { name: string }) => t.name === 'Shared');
    expect(shared).toMatchObject({ scope: 'project', placeholders: ['version', 'highlights'] });
    const none = await call(c, 'list_templates', { projectFullName: 'nobody/nothing' });
    expect(none.isError).toBe(true);
  });

  it('submit_task renders a template; explicit fields win; errors create nothing', async () => {
    const { owner, project: p } = await project();
    const c = await mcpAs(owner);
    const ok = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: [
        {
          ref: 'a',
          template: 'Upgrade a dependency',
          variables: { package: 'zod', version: '4.6.7', notes: 'Check the error format.' },
        },
        {
          ref: 'b',
          template: 'builtin:add-tests',
          variables: { target: 'src/parser.ts', behaviors: 'Parses empty input.' },
          title: 'Parser tests',
          size: 'L',
          dependsOn: ['a'],
        },
      ],
    });
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    const rows = await prisma.task.findMany({
      where: { projectId: p.id },
      orderBy: { githubIssueNumber: 'asc' },
    });
    expect(rows[0]).toMatchObject({
      title: 'Upgrade zod to 4.6.7',
      size: 'S',
      model: 'SONNET',
      origin: 'MCP',
    });
    expect(rows[0]!.bodySnapshot).toContain('Upgrade `zod` to `4.6.7`.');
    expect(rows[0]!.acceptanceCriteria).toContain(
      '`zod` is at `4.6.7` in the manifest and the lockfile',
    );
    expect(rows[1]).toMatchObject({ title: 'Parser tests', size: 'L' });
    const issues = gh.createdIssues.filter((i) => i.fullName === p.fullName);
    expect(issues[0]!.labels).toEqual(['pool', 'dependencies']);
    expect(issues[1]!.labels).toEqual(['pool', 'tests']);

    const before = await prisma.task.count({ where: { projectId: p.id } });
    const missing = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: [{ ref: 'a', template: 'Add tests', variables: { target: 'x' } }],
    });
    expect(missing.isError).toBe(true);
    expect(missing.data.error.code).toBe('missing_variables');
    const unknownTpl = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: [{ ref: 'a', template: 'Nope', variables: {} }],
    });
    expect(unknownTpl.data.error.code).toBe('template_not_found');
    const noTemplate = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: [{ ref: 'a', title: 'only a title' }],
    });
    expect(noTemplate.isError).toBe(true);
    expect(await prisma.task.count({ where: { projectId: p.id } })).toBe(before);
  });

  it('cannot use another user personal template', async () => {
    const { owner, project: p } = await project();
    const other = await loginAs(app, gh);
    const t = parse(await create(other, { scope: 'personal', ...fields({ name: 'Private one' }) }));
    const c = await mcpAs(owner);
    for (const ref of [t.id, 'Private one']) {
      const r = await call(c, 'submit_task', {
        projectFullName: p.fullName,
        tasks: [{ ref: 'a', template: ref, variables: { version: '1', highlights: 'x' } }],
      });
      expect(r.isError).toBe(true);
    }
  });
});
