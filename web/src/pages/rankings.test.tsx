import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { leaderboardRows, meFixture } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Leaderboard from './Leaderboard';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

describe('Rankings', () => {
  it('shows the loading treatment while the ladder loads', () => {
    apiMock.leaderboard.mockReturnValue(new Promise(() => {}));
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the field with rank, handle, Elo and movement glyphs', async () => {
    apiMock.leaderboard.mockResolvedValue({ leaderboard: leaderboardRows });
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(await screen.findByText('The field')).toBeInTheDocument();
    expect(screen.getByText('ALL-TIME · 4 PLAYERS')).toBeInTheDocument();

    const alice = screen.getByText('Alice').closest('a')!;
    expect(alice).toHaveAttribute('href', '/players/7');
    expect(within(alice).getByText('1')).toBeInTheDocument();
    expect(within(alice).getByText('1642')).toBeInTheDocument();
    expect(within(alice).getByText('▲2')).toHaveClass('positive');

    const henry = screen.getByText('Henry').closest('a')!;
    expect(within(henry).getByText('▼1')).toHaveClass('negative');

    // no prior snapshot → em dash, muted
    const bob = screen.getByText('Bob').closest('a')!;
    expect(within(bob).getByText('—')).toHaveClass('quiet');
  });

  it('highlights the signed-in player as "— you"', async () => {
    apiMock.leaderboard.mockResolvedValue({ leaderboard: leaderboardRows });
    renderWithMe(<Leaderboard />, { me: meFixture });
    const you = await screen.findByText('Margaret — you');
    expect(you.closest('a')).toHaveClass('rank-row-you');
  });

  it('treats zero movement like no movement', async () => {
    apiMock.leaderboard.mockResolvedValue({
      leaderboard: [{ ...leaderboardRows[0], movement: 0 }],
    });
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(await screen.findByText('—')).toHaveClass('quiet');
  });

  it('explains the rating system in the footer', async () => {
    apiMock.leaderboard.mockResolvedValue({ leaderboard: leaderboardRows });
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(await screen.findByText(/Everyone starts at 1200/)).toBeInTheDocument();
  });

  it('surfaces load failures in the error treatment', async () => {
    apiMock.leaderboard.mockRejectedValue(new Error('offline'));
    renderWithMe(<Leaderboard />, { me: meFixture });
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });
});
