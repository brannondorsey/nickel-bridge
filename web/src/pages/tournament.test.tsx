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

    // the final field rides along on the same page — no second route for it
    expect(screen.getByText('THE FIELD — FINAL')).toBeInTheDocument();
    const you = screen.getByText('You').closest('.tourney-field-row')! as HTMLElement;
    expect(you.className).toContain('tourney-field-you');
    expect(within(you).getByText('61%')).toBeInTheDocument();
    expect(screen.getByText('Alice').closest('a')).toHaveAttribute('href', '/players/7');

    expect(screen.getByRole('link', { name: /back to the bridge/i })).toHaveAttribute('href', '/');
  });

  it('makes every board-by-board line a link back into that board', async () => {
    apiMock.tournament.mockResolvedValue(tournamentComplete);
    renderWithMe(<Tournament />, { me: meFixture });

    // the ledger IS the review sheet: each scored line opens its own board
    const line = (await screen.findByText((_, el) => el?.textContent === '4♠ by S')).closest('a')!;
    expect(line).toHaveClass('tourney-board-line');
    expect(line).toHaveAttribute('href', '/t/11/b/1');
    expect(within(line).getByText('+620')).toBeInTheDocument();

    const lines = document.querySelectorAll('a.tourney-board-line');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toHaveAttribute('href', '/t/11/b/4');

    // and the old toggle to a separate review page is gone
    expect(screen.queryByRole('button', { name: /review the boards/i })).not.toBeInTheDocument();
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

  it('lands back on the one result page when navigating back out of a reviewed board', async () => {
    // Regression test: the finished tournament used to live on two routes
    // (/t/:tid and a /t/:tid/review sheet) showing the same four boards
    // twice, so which face you came back to was a real question. There is
    // one face now — drill into a board from the ledger, come back, same
    // postmarked page.
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
            <Route path="/t/:tid/b/:no" element={<BoardStub />} />
          </Routes>
        </MemoryRouter>
      </MeContext.Provider>,
    );

    const line = (await screen.findByText((_, el) => el?.textContent === '4♠ by S')).closest('a')!;
    await userEvent.click(line);
    await userEvent.click(await screen.findByRole('button', { name: /go back/i }));

    expect(await screen.findByText('TOLL PAID')).toBeInTheDocument();
    expect(screen.getByText('BOARD BY BOARD')).toBeInTheDocument();
  });
});
