import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { meFixture, meLoggedOut } from './test/fixtures';
import { apiMock } from './test/utils';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  get api() {
    return apiMock;
  },
}));

function renderApp(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  );
}

describe('App', () => {
  it('shows the login surface with dev sign-in when logged out', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    renderApp();
    expect(await screen.findByPlaceholderText(/dev/i)).toBeInTheDocument();
  });

  it('shows the app for an authenticated user with a handle', async () => {
    apiMock.me.mockResolvedValue(meFixture);
    apiMock.tournaments.mockResolvedValue({ tournaments: [] });
    renderApp();
    expect(await screen.findByText(/Margaret/)).toBeInTheDocument();
  });
});
