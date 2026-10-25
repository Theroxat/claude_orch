import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { builtinViews } from '@orch/shared';
import { describe, expect, it } from 'vitest';
import { mockApi, me, project, renderApp, switchToFrench, type Routes } from '../test/helpers';

const personal = {
  id: 'tpl1',
  scope: 'personal',
  projectId: null,
  projectFullName: null,
  name: 'Release notes',
  description: 'Draft the notes',
  titleTemplate: 'Notes for {{version}}',
  bodyTemplate: 'Write the notes for {{version}}.\n\nHighlights: {{highlights}}',
  acceptanceCriteria: ['Notes mention {{version}}'],
  size: 'S',
  model: 'SONNET',
  labels: ['docs'],
  dependenciesMode: 'none',
  placeholders: ['version', 'highlights'],
  createdBy: 'octo',
  canEdit: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const board = {
  PROPOSED: [],
  TODO: [],
  BLOCKED: [],
  IN_PROGRESS: [],
  IN_REVIEW: [],
  DONE: [],
  access: {
    p1: { myRole: 'owner', canSubmit: true, canPropose: true, canApprove: true },
  },
};

function base(extra: Routes = {}): Routes {
  return {
    'GET /me': () => ({ json: me }),
    'GET /projects/mine': () => ({ json: [project] }),
    'GET /projects/discover': () => ({ json: [] }),
    'GET /tasks': () => ({ json: board }),
    'GET /templates?projectId=p1': () => ({ json: [...builtinViews(), personal] }),
    ...extra,
  };
}

async function openDialog() {
  const btn = await screen.findByRole('button', { name: 'New task' });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(btn);
  const dialog = await screen.findByRole('dialog', { name: 'New task' });
  fireEvent.change(within(dialog).getByLabelText('Project'), { target: { value: 'p1' } });
  return dialog;
}

describe('Start from a template', () => {
  it('searches, fills the dialog, previews live and submits the rendered task', async () => {
    const calls = mockApi(
      base({
        'POST /projects/p1/tasks': () => ({
          status: 201,
          json: { id: 'n', issueNumber: 7 },
        }),
      }),
    );
    renderApp('/backlog');
    const dialog = await openDialog();
    const toggle = within(dialog).getByRole('button', { name: 'Start from a template' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await within(dialog).findByRole('button', { name: /Fix a bug/ });
    // search narrows the list
    fireEvent.change(within(dialog).getByLabelText('Search templates'), {
      target: { value: 'depend' },
    });
    expect(within(dialog).queryByRole('button', { name: /Fix a bug/ })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Search templates'), {
      target: { value: 'zzz' },
    });
    expect(within(dialog).getByText(/No template matches/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Search templates'), {
      target: { value: 'release' },
    });
    fireEvent.click(await within(dialog).findByRole('button', { name: /Release notes/ }));

    // picking replaces title/description with the placeholder fields and sets size and model
    expect(within(dialog).getByText(/Using/)).toBeTruthy();
    expect(within(dialog).queryByLabelText('Description')).toBeNull();
    expect((within(dialog).getByLabelText('Size') as HTMLSelectElement).value).toBe('S');
    const version = within(dialog).getByLabelText('Version');
    const highlights = within(dialog).getByLabelText('Highlights');
    // empty placeholders stay visible in the preview
    const preview = within(dialog).getByRole('region', { name: 'Preview' });
    expect(within(preview).getAllByText('{{version}}').length).toBeGreaterThan(0);

    // submitting with empty fields explains what is missing and sends nothing
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/version, highlights/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(version, { target: { value: '2.0' } });
    fireEvent.change(highlights, { target: { value: 'Faster <!-- x -->' } });
    expect(within(preview).getByRole('heading', { name: 'Notes for 2.0' })).toBeTruthy();
    expect(within(preview).queryByText('{{version}}')).toBeNull();
    expect(preview.textContent).toContain('Highlights: Faster &lt;!-- x --&gt;');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/projects/p1/tasks',
        body: {
          title: 'Notes for 2.0',
          body: 'Write the notes for 2.0.\n\nHighlights: Faster &lt;!-- x --&gt;',
          acceptanceCriteria: ['Notes mention 2.0'],
          labels: ['docs'],
          size: 'S',
          model: 'SONNET',
          dependsOn: [],
          integrationBranch: null,
        },
      }),
    );
  });

  it('can detach the template to edit the text freely', async () => {
    mockApi(base());
    renderApp('/backlog');
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start from a template' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /Release notes/ }));
    fireEvent.change(within(dialog).getByLabelText('Version'), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit as plain text' }));
    expect((within(dialog).getByLabelText('Title') as HTMLInputElement).value).toBe('Notes for 3');
    expect((within(dialog).getByLabelText('Description') as HTMLTextAreaElement).value).toContain(
      'Highlights: {{highlights}}',
    );
    expect(within(dialog).queryByRole('region', { name: 'Preview' })).toBeNull();
  });

  it('removing the template brings the plain fields back', async () => {
    mockApi(base());
    renderApp('/backlog');
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start from a template' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /Fix a bug/ }));
    expect((within(dialog).getByLabelText('Size') as HTMLSelectElement).value).toBe('M');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove template' }));
    expect(within(dialog).getByLabelText('Title')).toBeTruthy();
  });
});

describe('My templates', () => {
  it('lists, creates, edits and deletes personal templates; built-ins are copy-only', async () => {
    let list = [personal];
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /agents/mine': () => ({ json: [] }),
      'GET /templates': () => ({ json: [...builtinViews(), ...list] }),
      'POST /templates': (body) => {
        const b = body as Record<string, unknown>;
        const t = { ...personal, id: 'tpl2', name: String(b.name) };
        list = [...list, t];
        return { status: 201, json: t };
      },
      'PATCH /templates/tpl1': (body) => {
        list = [{ ...personal, ...(body as object) }];
        return { json: list[0] };
      },
      'DELETE /templates/tpl1': () => {
        list = [];
        return { status: 204 };
      },
    });
    renderApp('/my-server');
    const section = await screen.findByRole('region', { name: 'My templates' });
    expect(await within(section).findByText('Release notes')).toBeTruthy();

    // built-ins: only "Copy"
    fireEvent.click(within(section).getByText(/Built-in templates/));
    expect(within(section).getAllByRole('button', { name: 'Copy to my templates' })).toHaveLength(
      4,
    );

    // create
    fireEvent.click(within(section).getByRole('button', { name: 'New template' }));
    let dialog = await screen.findByRole('dialog', { name: 'New template' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save template' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/Name is required/);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Hotfix' } });
    fireEvent.change(within(dialog).getByLabelText(/Task description/), {
      target: { value: 'Fix {{bug}} in {{ place }}' },
    });
    // detected placeholders are listed live
    expect(within(dialog).getByText('{{bug}}')).toBeTruthy();
    expect(within(dialog).getByText('{{place}}')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/GitHub labels/), {
      target: { value: 'bug, urgent' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save template' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/templates')).toBe(true),
    );
    const post = calls.find((c) => c.method === 'POST' && c.path === '/templates')!;
    expect(post.body).toMatchObject({
      scope: 'personal',
      name: 'Hotfix',
      bodyTemplate: 'Fix {{bug}} in {{ place }}',
      labels: ['bug', 'urgent'],
      dependenciesMode: 'none',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New template' })).toBeNull());

    // edit
    fireEvent.click((await within(section).findAllByRole('button', { name: 'Edit' }))[0]!);
    dialog = await screen.findByRole('dialog', { name: 'Edit template' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Notes v2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save template' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ name: 'Notes v2' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // delete asks for confirmation
    fireEvent.click((await within(section).findAllByRole('button', { name: 'Delete' }))[0]!);
    dialog = await screen.findByRole('dialog', { name: 'Delete template' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete template' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/templates/tpl1')).toBe(true),
    );
  });
});

describe('Templates in French', () => {
  it('translates the manager, its editor and the delete dialog', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /agents/mine': () => ({ json: [] }),
      'GET /templates': () => ({ json: [...builtinViews(), personal] }),
    });
    await switchToFrench();
    renderApp('/my-server');
    const section = await screen.findByRole('region', { name: 'Mes modèles' });
    expect(await within(section).findByText('Release notes')).toBeTruthy();
    expect(within(section).getByText(/^Modèles intégrés \(4\)$/)).toBeTruthy();
    expect(within(section).getByText('Personnel')).toBeTruthy();
    expect(within(section).getAllByText('taille S / sonnet').length).toBeGreaterThan(0);

    fireEvent.click(within(section).getByRole('button', { name: 'Nouveau modèle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouveau modèle' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer le modèle' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Le nom est obligatoire.');
    expect(within(dialog).getByText('Aucun champ à remplir pour l’instant.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(section).getByRole('button', { name: 'Supprimer' }));
    const del = await screen.findByRole('dialog', { name: 'Supprimer le modèle' });
    expect(within(del).getByText(/ne sont pas affectées/)).toBeTruthy();
  });
});
