import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { meFixture, tournamentComplete, tournamentInProgress } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Lobby from './Lobby';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

describe('Home', () => {
  it('shows the loading treatment while tournaments load', () => {
    apiMock.tournaments.mockReturnValue(new Promise(() => {}));
    renderWithMe(<Lobby />, { me: meFixture });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('greets by time of day and opens the current crossing', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentInProgress, tournamentComplete] });
    renderWithMe(<Lobby />, { me: meFixture });
    expect(await screen.findByText(/Good (morning|afternoon|evening), Margaret/)).toBeInTheDocument();
    expect(screen.getByText('The bridge is open.')).toBeInTheDocument();
    // in-progress tournament → KEEP GOING with the stable e2e hook
    const cta = screen.getByRole('link', { name: /keep going/i });
    expect(cta).toHaveAttribute('href', '/t/12');
    expect(cta.className).toContain('home-cta');
    expect(screen.getByText(/Board 2 of 4 in progress/)).toBeInTheDocument();
    // the next tourney stays sealed while one is open
    expect(screen.getByText(/Opens when you finish #12 — one crossing at a time/)).toBeInTheDocument();
  });

  it('lists finished crossings under TOLLS PAID with date, field, pct and rank', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentInProgress, tournamentComplete] });
    renderWithMe(<Lobby />, { me: meFixture });
    const row = (await screen.findByText('61%')).closest('a')!;
    expect(row).toHaveAttribute('href', '/t/11');
    expect(within(row).getByText(/· 3 pairs/)).toBeInTheDocument();
    expect(within(row).getByText('2ND')).toHaveClass('quiet');
  });

  it('marks a win in the positive color', async () => {
    const won = {
      ...tournamentComplete,
      standings: tournamentComplete.standings.map((s) =>
        s.userId === 1 ? { ...s, rank: 1, totalPct: 71 } : { ...s, rank: 2 },
      ),
    };
    apiMock.tournaments.mockResolvedValue({ tournaments: [won] });
    renderWithMe(<Lobby />, { me: meFixture });
    expect(await screen.findByText('1ST')).toHaveClass('positive');
  });

  it('offers PLAY THE TOLL with a busy state when nothing is in progress', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentComplete] });
    let seat!: (v: { tournamentId: number; boardNo: number }) => void;
    apiMock.play.mockReturnValue(new Promise((resolve) => (seat = resolve)));
    renderWithMe(<Lobby />, { me: meFixture });
    const cta = await screen.findByRole('button', { name: /play the toll/i });
    expect(cta.className).toContain('home-cta');
    // no sealed gate row without a crossing in progress
    expect(screen.queryByText(/Opens when you finish/)).not.toBeInTheDocument();
    await userEvent.click(cta);
    expect(screen.getByRole('button', { name: /finding a table…/i })).toBeDisabled();
    seat({ tournamentId: 13, boardNo: 1 });
    await vi.waitFor(() => expect(apiMock.play).toHaveBeenCalled());
  });

  it('shows the empty state before any toll is paid', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentInProgress] });
    renderWithMe(<Lobby />, { me: meFixture });
    expect(await screen.findByText(/No tolls paid yet/)).toBeInTheDocument();
  });

  it('surfaces a load failure in the error treatment', async () => {
    apiMock.tournaments.mockRejectedValue(new Error('offline'));
    renderWithMe(<Lobby />, { me: meFixture });
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });
});
