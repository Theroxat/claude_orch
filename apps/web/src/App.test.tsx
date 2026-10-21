import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('redirects to My projects inside the layout', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'My projects' })).toBeTruthy();
  });

  it('renders the Pool placeholder', () => {
    render(
      <MemoryRouter initialEntries={['/pool']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Pool' })).toBeTruthy();
  });
});
