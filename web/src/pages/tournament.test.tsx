import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MeContext } from '../App';
import { meFixture, tournamentComplete, tournamentInProgress } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Tournament from './Tournament';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

describe('Tournament sheet', () => {
  it('shows the loading treatment', () => {
    apiMock.tournament.mockReturnValue(new Promise(() => {}));
    renderWithMe(<Tournament />, { me: meFixture });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('lays out all four boards as scored / live / sealed tickets', async () => {
    apiMock.tournament.mockResolvedValue(tournamentInProgress);
    renderWithMe(<Tournament />, { me: meFixture });

    // board 1 — scored, links to review (contract label splits the strain glyph into its own colored span)
    const scored = (await screen.findByText((_, el) => el?.textContent === '4♠ by S · +620')).closest('a')!;
    expect(scored).toHaveAttribute('href', '/t/12/b/1');
    expect(within(scored).getByText('58% matchpoints')).toBeInTheDocument();
    expect(within(scored).getByText('SCORED')).toBeInTheDocument();

    // board 2 — live with real deal conditions (dealer E, NS vul for board 2)
    const live = screen.getByText('Bidding — your call').closest('a')!;
    expect(live).toHaveAttribute('href', '/t/12/b/2');
    expect(within(live).getByText('Dealer E · NS vul')).toBeInTheDocument();
    expect(within(live).getByText('LIVE')).toBeInTheDocument();

    // boards 3 and 4 — sealed, inert
    expect(screen.getByText('Sealed — deals when board 2 is scored').closest('a')).toBeNull();
    expect(screen.getByText('Sealed')).toBeInTheDocument();

    // field standings after board 1, self highlighted
    expect(screen.getByText('THE FIELD — AFTER BOARD 1')).toBeInTheDocument();
    const you = screen.getByText('You').closest('.tourney-field-row')!;
    expect(you.className).toContain('tourney-field-you');
    expect(within(you as HTMLElement).getByText('· 1/4')).toBeInTheDocument();
    expect(screen.getByText('83%')).toBeInTheDocument();

    // continue into the live board
    expect(screen.getByRole('link', { name: /continue board 2/i })).toHaveAttribute('href', '/t/12/b/2');
  });

  it('renders house (benchmark AI) rows as ranked, tagged field members', async () => {
    apiMock.tournament.mockResolvedValue(tournamentInProgress);
    renderWithMe(<Tournament />, { me: meFixture });

    const house = (await screen.findByText('The Shark')).closest('.tourney-field-row')! as HTMLElement;
    expect(house.className).toContain('tourney-field-house');
    expect(within(house).getByText('HOUSE')).toBeInTheDocument();
    // house rows are full field members: real rank, tagged and muted only visually
    expect(within(house).getByText('2')).toBeInTheDocument();
    expect(within(house).getByText('The Shark').closest('a')).toHaveAttribute('href', '/players/90');
    // full player count: 3 humans + 1 house row → "4 players"
    expect(screen.getByText('4 players · matchpoints')).toBeInTheDocument();
    // incomplete rows fall back to their position in the pct-sorted field,
    // house included — Bob sits 4th behind Alice, The Shark, and Margaret
    const bob = screen.getByText('Bob').closest('.tourney-field-row')! as HTMLElement;
    expect(within(bob).getByText('4')).toBeInTheDocument();
  });

  it('marks an unstarted tournament as PLAY BOARD 1', async () => {
    apiMock.tournament.mockResolvedValue({ ...tournamentInProgress, myDone: 0, myBoards: [] });
    renderWithMe(<Tournament />, { me: meFixture });
    expect(await screen.findByRole('link', { name: /play board 1/i })).toHaveAttribute('href', '/t/12/b/1');
  });

  it('surfaces load failures', async () => {
    apiMock.tournament.mockRejectedValue(new Error('not found'));
    renderWithMe(<Tournament />, { me: meFixture });
    expect(await screen.findByText('not found')).toBeInTheDocument();
  });
});

describe('Tournament result', () => {
  it('postmarks a completed tournament with pct, rank and rating movement', async () => {
    apiMock.tournament.mockResolvedValue(tournamentComplete);
    renderWithMe(<Tournament />, { me: meFixture });

    expect(await screen.findByText('TOLL PAID')).toBeInTheDocument();
    expect(screen.getByText('TOURNAMENT Nº11')).toBeInTheDocument();
    expect(screen.getByText('MATCHPOINTS · 2ND OF 3 PLAYERS')).toBeInTheDocument();
    expect(screen.getByText('NICKEL RATING')).toBeInTheDocument();
    expect(screen.getByText('1487')).toBeInTheDocument();
    expect(screen.getByText('+12')).toHaveClass('positive');

    // board-by-board recap
    expect(screen.getByText('BOARD BY BOARD')).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === '3NT+1 by N')).toBeInTheDocument();
    expect(screen.getByText('−100')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /back to the bridge/i })).toHaveAttribute('href', '/');
  });

  it('falls back gracefully without a rank or rating change', async () => {
    apiMock.tournament.mockResolvedValue({
      ...tournamentComplete,
      myEloDelta: null,
      standings: tournamentComplete.standings.map((s) => (s.userId === 1 ? { ...s, rank: undefined } : s)),
    });
    renderWithMe(<Tournament />, { me: meFixture });
    expect(await screen.findByText('MATCHPOINTS · 3 PLAYERS')).toBeInTheDocument();
    expect(screen.queryByText('NICKEL RATING')).not.toBeInTheDocument();
  });

  it('toggles between the result and the reviewable sheet via /review, replacing history', async () => {
    apiMock.tournament.mockResolvedValue(tournamentComplete);
    renderWithMe(<Tournament />, { me: meFixture });
    await userEvent.click(await screen.findByRole('button', { name: /review the boards/i }));
    // now the sheet: all four boards scored and linked
    expect(screen.getByText((_, el) => el?.textContent === '4♠ by S · +620').closest('a')).toHaveAttribute(
      'href',
      '/t/11/b/1',
    );
    expect(screen.getAllByText('SCORED')).toHaveLength(4);
    // and back
    await userEvent.click(screen.getByRole('button', { name: /back to the summary/i }));
    expect(await screen.findByText('TOLL PAID')).toBeInTheDocument();
  });

  it('returns to the review sheet, not the summary, when navigating back out of a board', async () => {
    // Regression test: the sheet/summary toggle used to be untracked local
    // state, so drilling into a board from the review sheet (a real pushed
    // route) and then navigating back would remount Tournament fresh and
    // fall back to the postmarked summary instead of the sheet you came
    // from. Reviewing is now derived from the URL (/t/:tid vs
    // /t/:tid/review) so it survives the round trip.
    apiMock.tournament.mockResolvedValue(tournamentComplete);
    function BoardStub() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate(-1)}>
          go back
        </button>
      );
    }
    render(
      <MeContext.Provider value={{ me: meFixture, refresh: vi.fn() }}>
        <MemoryRouter initialEntries={['/t/11']}>
          <Routes>
            <Route path="/t/:tid" element={<Tournament />} />
            <Route path="/t/:tid/review" element={<Tournament />} />
            <Route path="/t/:tid/b/:no" element={<BoardStub />} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: /review the boards/i }));
    const scored = (await screen.findByText((_, el) => el?.textContent === '4♠ by S · +620')).closest('a')!;
    await userEvent.click(scored);
    await userEvent.click(await screen.findByRole('button', { name: /go back/i }));

    expect(await screen.findAllByText('SCORED')).toHaveLength(4);
    expect(screen.queryByText('TOLL PAID')).not.toBeInTheDocument();
  });
});
