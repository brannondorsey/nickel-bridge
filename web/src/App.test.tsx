import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { LAST_VISIT_KEY, stampVisit } from './splash';
import { meFixture, meLoggedOut, meNoHandle } from './test/fixtures';
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

beforeEach(() => {
  localStorage.clear();
});

describe('App — logged out', () => {
  it('lands on the splash with the Google CTA and dev sign-in', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    renderApp();
    const cta = await screen.findByRole('link', { name: /play the toll/i });
    expect(cta).toHaveAttribute('href', '/auth/google');
    expect(screen.getByPlaceholderText(/dev/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dev sign-in/i })).toBeInTheDocument();
  });

  it('does not offer Google sign-in when the server disables it', async () => {
    apiMock.me.mockResolvedValue({ ...meLoggedOut, googleAuth: false });
    renderApp();
    await screen.findByPlaceholderText(/dev/i);
    expect(screen.queryByRole('link', { name: /play the toll/i })).not.toBeInTheDocument();
  });

  it('never auto-dismisses: no skip affordance on the login splash', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    renderApp();
    await screen.findByRole('link', { name: /play the toll/i });
    expect(screen.queryByRole('button', { name: /skip intro/i })).not.toBeInTheDocument();
  });
});

describe('App — authenticated', () => {
  beforeEach(() => {
    apiMock.me.mockResolvedValue(meFixture);
    apiMock.tournaments.mockResolvedValue({ tournaments: [] });
  });

  it('sends a user without a handle to CreateHandle', async () => {
    apiMock.me.mockResolvedValue(meNoHandle);
    renderApp();
    expect(await screen.findByPlaceholderText('Handle')).toBeInTheDocument();
  });

  it('shows Home with bottom tabs for a recent visitor, no splash', async () => {
    stampVisit();
    renderApp();
    expect(await screen.findByText(/Margaret/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CROSSINGS' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByTestId('splash')).not.toBeInTheDocument();
  });

  it('plays the splash for a first-time or long-absent visitor and stamps the visit', async () => {
    renderApp();
    expect(await screen.findByTestId('splash')).toBeInTheDocument();
    expect(localStorage.getItem(LAST_VISIT_KEY)).not.toBeNull();
  });

  it('tap skips the splash immediately', async () => {
    renderApp();
    const splash = await screen.findByTestId('splash');
    await userEvent.click(splash);
    expect(screen.queryByTestId('splash')).not.toBeInTheDocument();
  });

  it('keeps the tab bar off tournament and board flows', async () => {
    stampVisit();
    apiMock.tournament.mockReturnValue(new Promise(() => {}));
    renderApp('/t/12');
    // the page hangs on load — the shell decision is what's under test
    await vi.waitFor(() => expect(apiMock.tournament).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'CROSSINGS' })).not.toBeInTheDocument();
  });

  it('serves NotFound for any unmatched URL instead of a blank shell', async () => {
    stampVisit();
    renderApp('/this/route/does/not/exist');
    expect(await screen.findByText('This page does not exist.')).toBeInTheDocument();
  });
});

describe('App — demo mode', () => {
  it('suppresses the returning-visitor splash entirely', async () => {
    // no nb:lastVisit stamp → an ordinary deployment WOULD splash here
    apiMock.me.mockResolvedValue({ ...meFixture, demo: true });
    apiMock.tournaments.mockResolvedValue({ tournaments: [] });
    renderApp();
    expect(await screen.findByText(/Margaret/)).toBeInTheDocument();
    expect(screen.queryByTestId('splash')).not.toBeInTheDocument();
  });

  it('serves the Exhibit Hall on /scenarios with no tab bar', async () => {
    apiMock.me.mockResolvedValue({ ...meFixture, demo: true });
    apiMock.demoScenarios.mockResolvedValue({ scenarios: [] });
    renderApp('/scenarios');
    expect(await screen.findByText('The Exhibit Hall')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'CROSSINGS' })).not.toBeInTheDocument();
  });
});
