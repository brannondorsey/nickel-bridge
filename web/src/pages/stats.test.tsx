import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { meFixture, playerStatsEmpty, playerStatsFull } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Player from './Player';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

const renderStats = (me = meFixture) => renderWithMe(<Player />, { me, route: '/players/1' });

describe('Stats', () => {
  it('shows the rating hero with flip digits and the monthly delta', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    expect(await screen.findByText('NICKEL RATING')).toBeInTheDocument();
    // 1487 rendered one flip digit per numeral
    const hero = document.querySelector('.player-hero')!;
    expect(within(hero as HTMLElement).getByText('4')).toBeInTheDocument();
    expect(screen.getByText('+34 THIS MONTH')).toHaveClass('positive');
  });

  it('hides the monthly delta when unrated and shows a negative month in red', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      totals: { ...playerStatsFull.totals, monthlyEloDelta: -12 },
    });
    renderStats();
    expect(await screen.findByText('−12 THIS MONTH')).toHaveClass('negative');
  });

  it('renders three sparkline panels with their reference captions', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    expect(await screen.findByText('MATCHPOINTS — LAST 10 TOURNAMENTS')).toBeInTheDocument();
    expect(screen.getByText('Ø 57%')).toBeInTheDocument();
    expect(screen.getByText('- - field average 50%')).toBeInTheDocument();
    expect(screen.getByText('RATING BY TOURNAMENT')).toBeInTheDocument();
    expect(screen.getByText('PEAK 1502')).toBeInTheDocument();
    expect(screen.getByText('- - start 1200')).toBeInTheDocument();
    expect(screen.getByText('BID ACCURACY')).toBeInTheDocument();
  });

  it('shows four graded-call rows including the ✗ row', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    expect(await screen.findByText('BIDDING — 214 CALLS GRADED')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /of 3 stars/ })).toHaveLength(4);
    expect(screen.getByText('✗')).toBeInTheDocument();
    // 137/214 → 64%
    expect(screen.getByText('64%')).toBeInTheDocument();
  });

  it('unfolds the bid-type ledger on tap, ranked best to worst, and folds it back', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const toggle = await screen.findByRole('button', { name: /ledger by bid type/i });
    expect(screen.queryByText('★★ OR BETTER — BY BID TYPE')).not.toBeInTheDocument();

    await userEvent.click(toggle);
    const ledger = screen.getByText('★★ OR BETTER — BY BID TYPE').closest('.stats-bidtypes')!;
    // rows keep the server's best-to-worst order
    const labels = [...ledger.querySelectorAll('.stats-bidtype-label')].map((el) => el.textContent);
    expect(labels).toEqual(['OPENINGS', 'PASSES', 'RESPONSES', 'REBIDS', 'DOUBLES', 'OVERCALLS']);
    // 40/41 → 98%, with its sample size alongside
    expect(within(ledger as HTMLElement).getByText('98%')).toBeInTheDocument();
    expect(within(ledger as HTMLElement).getByText('41 calls')).toBeInTheDocument();
    // the weakest line is called out for practice
    expect(within(ledger as HTMLElement).getByText(/overcalls are the line to sharpen next/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /fold the ledger away/i }));
    expect(screen.queryByText('★★ OR BETTER — BY BID TYPE')).not.toBeInTheDocument();
  });

  it('keeps the bidding panel inert when there is no bid-type data', async () => {
    apiMock.playerStats.mockResolvedValue({ ...playerStatsFull, bidTypes: [] });
    renderStats();
    await screen.findByText('BIDDING — 214 CALLS GRADED');
    expect(screen.queryByText(/ledger by bid type/i)).not.toBeInTheDocument();
  });

  it('computes declaring/defending tiles from the play record', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const declaring = (await screen.findByText('DECLARING')).closest('.stat-tile')!;
    expect(within(declaring as HTMLElement).getByText('61%')).toBeInTheDocument();
    expect(within(declaring as HTMLElement).getByText('88 boards')).toBeInTheDocument();
    const defending = screen.getByText('DEFENDING').closest('.stat-tile')!;
    expect(within(defending as HTMLElement).getByText('52%')).toBeInTheDocument();
    expect(screen.getByText('TOURNAMENTS')).toBeInTheDocument();
    expect(screen.getByText(/better than 72% of 54 rated players/)).toBeInTheDocument();
  });

  it('offers sign-out to the owner only', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    apiMock.logout.mockResolvedValue({ ok: true });
    const { refresh } = renderStats();
    await userEvent.click(await screen.findByRole('button', { name: /sign out/i }));
    expect(apiMock.logout).toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('hides sign-out on another player’s page and shows their identity', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      user: { ...playerStatsFull.user, id: 7, handle: 'Alice' },
    });
    renderStats();
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(/Learning since/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('hides every Elo surface on a house (benchmark AI) profile', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      user: { ...playerStatsFull.user, id: 90, handle: 'The Shark', kind: 'ai' },
      percentiles: { ...playerStatsFull.percentiles, elo: null },
    });
    renderStats();
    expect(await screen.findByText('The Shark')).toBeInTheDocument();
    expect(screen.getByText('HOUSE')).toBeInTheDocument();
    expect(screen.getByText(/House player/)).toBeInTheDocument();
    // personas never rate: no rating hero, no rating chart, no RATED tile
    expect(screen.queryByText('NICKEL RATING')).not.toBeInTheDocument();
    expect(screen.queryByText('RATING BY TOURNAMENT')).not.toBeInTheDocument();
    expect(screen.queryByText('RATED')).not.toBeInTheDocument();
    // matchpoint surfaces stay — the house competes on the scoresheet
    expect(screen.getByText('MATCHPOINTS — LAST 10 TOURNAMENTS')).toBeInTheDocument();
  });

  it('invites the owner to play their first board when empty', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsEmpty);
    renderStats();
    const cta = await screen.findByRole('link', { name: /play your first board/i });
    expect(cta).toHaveAttribute('href', '/');
  });

  it('shows a not-found error for a missing player', async () => {
    apiMock.playerStats.mockRejectedValue(new Error('404'));
    renderStats();
    expect(await screen.findByText('Player not found.')).toBeInTheDocument();
  });
});
