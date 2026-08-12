import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { leaderboardResponse, leaderboardRows, meFixture } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Leaderboard from './Leaderboard';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

describe('Rankings', () => {
  // The window preference persists in localStorage, so it would otherwise leak
  // between tests in file order and make the default-window assertions depend
  // on which test ran first.
  beforeEach(() => localStorage.removeItem('nb:rankwindow'));

  it('shows the loading treatment while the ladder loads', () => {
    apiMock.leaderboard.mockReturnValue(new Promise(() => {}));
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the field with rank, handle, Elo and movement glyphs', async () => {
    apiMock.leaderboard.mockResolvedValue(leaderboardResponse);
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(await screen.findByText('The field')).toBeInTheDocument();
    expect(screen.getByText('ALL-TIME · 4 PLAYERS')).toBeInTheDocument();

    // 7 DAYS is the default window, so these are the movement7d values
    const alice = screen.getByText('Alice').closest('a')!;
    expect(alice).toHaveAttribute('href', '/players/7');
    expect(within(alice).getByText('1')).toBeInTheDocument();
    expect(within(alice).getByText('1642')).toBeInTheDocument();
    expect(within(alice).getByText('▲2')).toHaveClass('positive');

    const henry = screen.getByText('Henry').closest('a')!;
    expect(within(henry).getByText('▼1')).toHaveClass('negative');

    // on the ladder for less than a week → no position to have moved from
    const bob = screen.getByText('Bob').closest('a')!;
    expect(within(bob).getByText('—')).toHaveClass('quiet');
  });

  it('reads the other window when the switch is flipped, without refetching', async () => {
    apiMock.leaderboard.mockResolvedValue(leaderboardResponse);
    renderWithMe(<Leaderboard />, { me: meFixture });
    await screen.findByText('The field');

    const alice = () => screen.getByText('Alice').closest('a')!;
    expect(within(alice()).getByText('▲2')).toBeInTheDocument(); // 7d
    expect(screen.getByText(/over the last 7 days/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '1 DAY' }));

    // both windows ship on the one response, so the switch is a reading
    // position rather than a query — flipping it must not cost a round trip
    expect(apiMock.leaderboard).toHaveBeenCalledTimes(1);
    expect(within(alice()).getByText('▲1')).toBeInTheDocument(); // 1d
    // Bob has a 1-day reading even though he has no 7-day one
    expect(within(screen.getByText('Bob').closest('a')!).getByText('▲2')).toBeInTheDocument();
    // and the footer says which period is on screen — the question the old
    // arrow could never answer
    expect(screen.getByText(/over the last 24 hours/)).toBeInTheDocument();
  });

  it('remembers the chosen window across mounts', async () => {
    apiMock.leaderboard.mockResolvedValue(leaderboardResponse);
    const first = renderWithMe(<Leaderboard />, { me: meFixture });
    await screen.findByText('The field');
    await userEvent.click(screen.getByRole('button', { name: '1 DAY' }));
    first.unmount();

    renderWithMe(<Leaderboard />, { me: meFixture });
    await screen.findByText('The field');
    expect(screen.getByRole('button', { name: '1 DAY' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/over the last 24 hours/)).toBeInTheDocument();
  });

  it('highlights the signed-in player as "— you"', async () => {
    apiMock.leaderboard.mockResolvedValue(leaderboardResponse);
    renderWithMe(<Leaderboard />, { me: meFixture });
    const you = await screen.findByText('Margaret — you');
    expect(you.closest('a')).toHaveClass('rank-row-you');
  });

  it('treats zero movement like no movement', async () => {
    // Held station and never-on-the-ladder stay distinct in the data and
    // collapse to one em dash on screen — two kinds of "nothing happened" are
    // not worth asking a reader to tell apart at a glance.
    apiMock.leaderboard.mockResolvedValue({
      ...leaderboardResponse,
      leaderboard: [{ ...leaderboardRows[0], movement1d: 0, movement7d: 0 }],
    });
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(await screen.findByText('—')).toHaveClass('quiet');
  });

  // The personas never rate, so they can't be ranked — but their profiles are
  // the only ones a signed-out visitor can open, and this panel is where they
  // get found. Signed in it's simply useful: "how do I stack up against the
  // house" is the question the ladder makes people ask.
  it('lists the house beside the ladder, never on it', async () => {
    apiMock.leaderboard.mockResolvedValue(leaderboardResponse);
    renderWithMe(<Leaderboard />, { me: meFixture });
    await screen.findByText('The field');
    const shark = screen.getByText('The Shark').closest('a')!;
    expect(shark).toHaveAttribute('href', '/players/903');
    // beside, not on: no rank number, and it isn't one of the ranked rows
    expect(within(shark).queryByText('1')).not.toBeInTheDocument();
    expect(shark).not.toHaveClass('rank-row-you');
  });

  it('explains the rating system in the footer', async () => {
    apiMock.leaderboard.mockResolvedValue(leaderboardResponse);
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(await screen.findByText(/Everyone starts at 1200/)).toBeInTheDocument();
  });

  it('omits the provisional note once the signed-in player has met the quota', async () => {
    apiMock.leaderboard.mockResolvedValue(leaderboardResponse);
    renderWithMe(<Leaderboard />, { me: meFixture });
    await screen.findByText('The field');
    expect(screen.queryByText(/join the field/)).not.toBeInTheDocument();
  });

  it("shows the provisional note when the signed-in player hasn't met the quota", async () => {
    apiMock.leaderboard.mockResolvedValue({ ...leaderboardResponse, yourRatedTournaments: 2 });
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(await screen.findByText(/join the field once you've completed 4 crossings — 2 of 4 so far/)).toBeInTheDocument();
  });

  it('singularizes "crossing" for a 1-tournament quota (the DEMO=1 override)', async () => {
    apiMock.leaderboard.mockResolvedValue({ ...leaderboardResponse, provisionalMin: 1, yourRatedTournaments: 0 });
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(await screen.findByText(/join the field once you've completed 1 crossing — 0 of 1 so far/)).toBeInTheDocument();
  });

  it('surfaces load failures in the error treatment', async () => {
    apiMock.leaderboard.mockRejectedValue(new Error('offline'));
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });
});
