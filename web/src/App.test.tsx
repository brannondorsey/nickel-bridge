import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { TOUR_DONE_KEY, stampTourDone } from './onboarding/tourDone';
import { LAST_VISIT_KEY, stampVisit } from './splash';
import {
  leaderboardResponse,
  leaderboardRows,
  meFixture,
  meFreshCrosser,
  meLoggedOut,
  meNoHandle,
  playerStatsFull,
} from './test/fixtures';
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

  // The glossary is the app's search-engine front door: a crawler (or a person
  // following a search result) must reach the terms themselves, not a login
  // splash. See isGlossaryPath in App.tsx.
  it('reads the glossary without an account, with a sign-in bar for chrome', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    renderApp('/glossary');
    expect(await screen.findByText('The Glossary')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /play the toll/i })).toHaveAttribute('href', '/');
    // the TabBar's other gates all need an account, so it isn't rendered
    expect(screen.queryByRole('link', { name: 'RANKINGS' })).not.toBeInTheDocument();
  });

  it('opens a /glossary/:slug deep link straight onto its term sheet', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    renderApp('/glossary/finesse');
    expect(await screen.findByRole('dialog')).toHaveTextContent(/finesse/i);
  });

  // Play is still the toll. A gated deep link lands on the landing page rather
  // than a 404 — someone following a friend's board link should be told how to
  // get in, not that the page is missing.
  it('still gates the game itself, landing a shared board link on the invitation', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    renderApp('/t/12/b/1');
    await screen.findByRole('link', { name: /play the toll/i });
    expect(screen.queryByText('The Glossary')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/dev/i)).toBeInTheDocument();
  });

  // The whole point of the change: a visitor can see what this is, and try it,
  // before being asked for an account.
  it('pitches the app under the splash instead of stopping at it', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    renderApp();
    expect(await screen.findByText('Everyone plays the same deals.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /walk a practice deal/i })).toHaveAttribute('href', '/tour');
    expect(screen.getByRole('link', { name: /the glossary/i })).toHaveAttribute('href', '/glossary');
    expect(screen.getByRole('link', { name: /the field/i })).toHaveAttribute('href', '/leaderboard');
    // exactly one dev form on the page, or every by-placeholder lookup (here,
    // in auth.test.tsx and in the Playwright smoke) becomes ambiguous
    expect(screen.getAllByPlaceholderText(/dev/i)).toHaveLength(1);
  });

  it('reads the rankings without an account, with a sign-in bar for chrome', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    apiMock.leaderboard.mockResolvedValue({ ...leaderboardResponse, yourRatedTournaments: null });
    renderApp('/leaderboard');
    expect(await screen.findByText(leaderboardRows[0].handle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /play the toll/i })).toHaveAttribute('href', '/');
    // no "you", and no provisional note — there is no you to be provisional about
    expect(screen.queryByText(/you'll join the field/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/— you/)).not.toBeInTheDocument();
    // human rows don't link: every one of them would land on the same sign-in
    // wall, so a whole page of them would be a page of dead ends
    expect(screen.queryByRole('link', { name: new RegExp(leaderboardRows[0].handle) })).not.toBeInTheDocument();
    // the house is the exception, and the only profile a visitor can open
    expect(screen.getByRole('link', { name: /The Shark/ })).toHaveAttribute('href', '/players/903');
  });

  // The house personas are synthetic — nobody's record — so their profiles are
  // the one populated one a visitor can read before signing up.
  it('reads a house profile without an account, minus the owner-only controls', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderApp(`/players/${playerStatsFull.user.id}`);
    expect(await screen.findByText(playerStatsFull.user.handle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /appearance/i })).not.toBeInTheDocument();
  });

  // A real person's is gated. The server's 401 is uniform — an unknown id
  // answers identically — so the client cannot and must not claim "not found".
  it('invites rather than errors on a profile it is not allowed to read', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    apiMock.playerStats.mockRejectedValue(new Error('not signed in'));
    renderApp('/players/47');
    expect(await screen.findByText(/record is for members of the club/i)).toBeInTheDocument();
    expect(screen.queryByText(/player not found/i)).not.toBeInTheDocument();
    // the SignInBar at the foot is the ask; a second one in the panel would be
    // the same request twice on one screen
    expect(screen.getAllByRole('link', { name: /play the toll/i })).toHaveLength(1);
  });

  it('walks the practice deal without an account', async () => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    renderApp('/tour');
    expect(await screen.findByRole('button', { name: '1NT' })).toBeInTheDocument();
    // the tour ends at the gate, so it carries its own ask — no SignInBar too
    expect(screen.queryByText(/sign in to play for free/i)).not.toBeInTheDocument();
  });
});

// The offset a router navigation leaves behind. This only became visible when
// the landing page grew taller than one screen: PLAY THE TOLL from a scrolled
// glossary put the sign-in two viewports above where the visitor landed.
describe('App — scroll position across navigations', () => {
  let scrollTo: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    apiMock.me.mockResolvedValue(meLoggedOut);
    scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => scrollTo.mockRestore());

  it("takes the glossary's PLAY THE TOLL to the top of the landing page", async () => {
    renderApp('/glossary');
    await screen.findByText('The Glossary');
    await userEvent.click(screen.getByRole('link', { name: /play the toll/i }));
    // the hero — and the sign-in in it — is at the top of the page it just went to
    expect(await screen.findByText('A small club, completely free.')).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  // The term sheet is a ?term= push on whatever route you're reading, so this
  // is the case that a naive scroll-on-every-navigation would break: tapping a
  // term two thirds down the ledger would throw the list back to 'A'.
  it('leaves the ledger where it is when a term sheet opens over it', async () => {
    renderApp('/glossary');
    await screen.findByText('The Glossary');
    await userEvent.click(screen.getByRole('button', { name: /Finesse/ }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/finesse/i);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('leaves back/forward alone — the browser restores that offset itself', async () => {
    render(
      <MemoryRouter initialEntries={['/glossary']}>
        <App />
        <TestBack />
      </MemoryRouter>,
    );
    await screen.findByText('The Glossary');
    await userEvent.click(screen.getByRole('link', { name: /play the toll/i }));
    await screen.findByText('A small club, completely free.');
    scrollTo.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'test-back' }));
    expect(await screen.findByText('The Glossary')).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

/** A back button the app itself doesn't have, to exercise POP navigations. */
function TestBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      test-back
    </button>
  );
}

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

  it('meets a not-yet-onboarded user arriving at home with the practice board (no splash, no routes)', async () => {
    apiMock.me.mockResolvedValue(meFreshCrosser);
    renderApp('/');
    expect(await screen.findByText(/THE TOLLKEEPER/)).toBeInTheDocument();
    expect(screen.queryByTestId('splash')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'TOURNEYS' })).not.toBeInTheDocument();
    // the visit still stamps, so no splash replays the moment the tour ends
    expect(localStorage.getItem(LAST_VISIT_KEY)).not.toBeNull();
  });

  it('the gate-rendered tour gets its own glossary provider — term sheets open mid-tour', async () => {
    // The tour renders in place of the routes (and so outside the provider
    // that wraps them), but its narration links terms like any other prose.
    apiMock.me.mockResolvedValue(meFreshCrosser);
    renderApp('/');
    await screen.findByText(/THE TOLLKEEPER/);
    await userEvent.click(await screen.findByRole('button', { name: 'high card points' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/high card point/i);
  });

  it('never springs the tour on a deep-link arrival — the destination renders instead', async () => {
    apiMock.me.mockResolvedValue(meFreshCrosser);
    renderApp('/glossary'); // a shared link goes where it points; the tour waits for a home arrival
    expect(await screen.findByText('The Glossary')).toBeInTheDocument();
    expect(screen.queryByText(/THE TOLLKEEPER/)).not.toBeInTheDocument();
  });

  // The public tour's claim (onboarding/tourDone.ts). Someone who walked the
  // whole practice board signed out, then signed in, must not be handed the
  // same deal again — that was the reward for finishing it.
  describe('carrying a public tour across sign-in', () => {
    it('trades the claim for the server stamp instead of replaying the tour', async () => {
      stampTourDone();
      apiMock.me.mockResolvedValue(meFreshCrosser);
      apiMock.tournaments.mockResolvedValue({ tournaments: [] });
      apiMock.setOnboarded.mockResolvedValue({ ok: true });
      renderApp('/');
      // straight to Home — and never a flash of the tour on the way, which is
      // why the claim is read at mount rather than in an effect
      expect(await screen.findByText(/Margaret/)).toBeInTheDocument();
      expect(screen.queryByText(/THE TOLLKEEPER/)).not.toBeInTheDocument();
      await vi.waitFor(() => expect(apiMock.setOnboarded).toHaveBeenCalled());
      // spent, so it can't skip onboarding for whoever signs in next here
      expect(localStorage.getItem(TOUR_DONE_KEY)).toBeNull();
    });

    it('drops a stale claim rather than skipping a returning player past nothing', async () => {
      // an abandoned OAuth leaves the flag behind; it expires on its own
      stampTourDone(new Date(Date.now() - 6 * 60 * 60 * 1000));
      apiMock.me.mockResolvedValue(meFreshCrosser);
      renderApp('/');
      expect(await screen.findByText(/THE TOLLKEEPER/)).toBeInTheDocument();
      expect(apiMock.setOnboarded).not.toHaveBeenCalled();
    });

    it('leaves the claim alone while nobody is signed in', async () => {
      stampTourDone();
      apiMock.me.mockResolvedValue(meLoggedOut);
      renderApp('/');
      await screen.findByRole('link', { name: /play the toll/i });
      // still there for the sign-in that hasn't happened yet
      expect(localStorage.getItem(TOUR_DONE_KEY)).not.toBeNull();
      expect(apiMock.setOnboarded).not.toHaveBeenCalled();
    });
  });

  it('demo mode suppresses the automatic tour like the splash (the /tour route stays reachable)', async () => {
    apiMock.me.mockResolvedValue({ ...meFreshCrosser, demo: true });
    apiMock.tournaments.mockResolvedValue({ tournaments: [] });
    renderApp();
    expect(await screen.findByText(/Margaret/)).toBeInTheDocument();
    expect(screen.queryByText(/THE TOLLKEEPER/)).not.toBeInTheDocument();
  });

  it('shows Home with bottom tabs for a recent visitor, no splash', async () => {
    stampVisit();
    renderApp();
    expect(await screen.findByText(/Margaret/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'TOURNEYS' })).toHaveAttribute('aria-current', 'page');
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
    expect(screen.queryByRole('link', { name: 'TOURNEYS' })).not.toBeInTheDocument();
  });

  it('shows the tab bar on someone else\'s profile, but does not claim STATS is active there', async () => {
    stampVisit();
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      user: { ...playerStatsFull.user, id: 90, handle: 'The Shark', kind: 'ai' },
    });
    renderApp('/players/90');
    await screen.findByText('The Shark');
    // the bar itself still renders here (useful chrome to jump back out)...
    const stats = screen.getByRole('link', { name: 'STATS' });
    expect(stats).toBeInTheDocument();
    // ...but STATS always links to *my* profile (id 1), and tapping it from
    // someone else's page is a real navigation, not a no-op — it must not
    // be marked as the current page
    expect(stats).toHaveAttribute('href', '/players/1');
    expect(stats).not.toHaveAttribute('aria-current');
  });

  it('serves the Glossary on /glossary with its tab active — deep links included', async () => {
    stampVisit();
    renderApp('/glossary');
    expect(await screen.findByText('The Glossary')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'GLOSSARY' })).toHaveAttribute('aria-current', 'page');

    renderApp('/glossary/stayman');
    const tabs = await screen.findAllByRole('link', { name: 'GLOSSARY' });
    expect(tabs.at(-1)).toHaveAttribute('aria-current', 'page');
    // patient: this arrives via the /glossary/:slug → ?term= replace-redirect,
    // an extra render round-trip that can lag under full-suite load
    const dialogs = await screen.findAllByRole('dialog', {}, { timeout: 5000 });
    expect(dialogs.at(-1)).toHaveTextContent(/2♣ response to 1NT/);
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
    expect(screen.queryByRole('link', { name: 'TOURNEYS' })).not.toBeInTheDocument();
  });
});
