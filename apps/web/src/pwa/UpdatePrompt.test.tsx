import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui/Toast';
import { UpdatePrompt } from './UpdatePrompt';

const sw = vi.hoisted(() => ({
  onNeedRefresh: undefined as undefined | (() => void),
  update: vi.fn(() => Promise.resolve()),
}));
vi.mock('virtual:pwa-register', () => ({
  registerSW: (opts: { onNeedRefresh: () => void }) => {
    sw.onNeedRefresh = opts.onNeedRefresh;
    return sw.update;
  },
}));

function mount() {
  render(
    <ToastProvider>
      <UpdatePrompt />
    </ToastProvider>,
  );
}

describe('update prompt', () => {
  beforeEach(() => {
    sw.onNeedRefresh = undefined;
    sw.update.mockClear();
  });

  it('stays silent until a new version is waiting', () => {
    mount();
    expect(sw.onNeedRefresh).toBeTypeOf('function');
    expect(screen.queryByText('New version available')).toBeNull();
  });

  it('offers a reload that activates the new worker', async () => {
    mount();
    sw.onNeedRefresh?.();
    expect(await screen.findByText('New version available')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(sw.update).toHaveBeenCalledWith(true);
  });
});
