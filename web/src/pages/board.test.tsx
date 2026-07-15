import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  bid2H,
  boardBidding,
  boardBiddingRobots,
  boardDone,
  boardDoneLow,
  boardPlaying,
  boardPlayingDummyTurn,
  boardPlayingFlipped,
  meFixture,
} from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Board from './Board';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

const renderBoard = () =>
  renderWithMe(
    <Routes>
      <Route path="/t/:tid/b/:no" element={<Board />} />
    </Routes>,
    { me: meFixture, route: '/t/12/b/2' },
  );

const inAuction = () => within(document.querySelector('.auction') as HTMLElement);

describe('Board — bidding', () => {
  it('shows the ticket header with deal conditions and the vul chip', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    renderBoard();
    expect(await screen.findByText('Tournament #12')).toBeInTheDocument();
    expect(screen.getByText(/Dealer N/)).toBeInTheDocument();
    expect(screen.getByText('NS VUL')).toBeInTheDocument();
  });

  it('walks the two-step commit: select shows the meaning, confirm submits', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    apiMock.call.mockResolvedValue({
      evaluation: { call: bid2H, bestCall: bid2H, userProb: 0.7, bestProb: 0.7, grade: 'excellent', score: 1 },
      board: boardBiddingRobots,
    });
    renderBoard();
    // placeholder first
    expect(await screen.findByText(/Tap a bid to see what it means/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '2♥' }));
    expect(screen.getByText(/Rebid, invitational/)).toBeInTheDocument();
    expect(screen.getByText('10–12 HCP')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Bid 2♥' }));
    expect(apiMock.call).toHaveBeenCalledWith(12, 2, bid2H);
    // grade toast lands on the refreshed board
    expect(await screen.findByText('Excellent')).toBeInTheDocument();
    expect(screen.getByText('Robots are thinking…')).toBeInTheDocument();
  });

  it('credits a textbook bid and names the robot convention in the toast', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    apiMock.call.mockResolvedValue({
      evaluation: {
        call: bid2H,
        bestCall: 18, // 4♣
        userProb: 0,
        bestProb: 0.85,
        grade: 'good',
        score: 0.75,
        saycConsistent: true,
        bestMeaning: { title: 'Splinter raise', description: 'Double jump in a new suit.', exact: true },
      },
      board: boardBiddingRobots,
    });
    renderBoard();
    await screen.findByText(/Tap a bid to see what it means/);
    await userEvent.click(screen.getByRole('button', { name: '2♥' }));
    await userEvent.click(screen.getByRole('button', { name: 'Bid 2♥' }));
    await screen.findByText('Good');
    const toast = document.querySelector('.grade-toast')!;
    expect(toast).toHaveTextContent(/Good — you bid 2♥, a textbook SAYC bid; the robot chose 4♣ \(Splinter raise\)/);
    expect(toast).not.toHaveTextContent(/%/);
  });

  it('opens the call inspector dialog from a past auction call', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    renderBoard();
    await screen.findByText('SOUTH — YOU');
    await userEvent.click(inAuction().getByRole('button', { name: '1♥' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Opening, one of a major/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows my hand with the HCP badge and seat label', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    renderBoard();
    expect(await screen.findByText('SOUTH — YOU')).toBeInTheDocument();
    expect(screen.getByText('12 HCP')).toBeInTheDocument();
  });
});

describe('Board — play', () => {
  it('lays out dummy, trick area and my fan; tap-select then tap-again plays', async () => {
    apiMock.board.mockResolvedValue(boardPlaying);
    apiMock.playCard.mockResolvedValue({ board: boardPlaying });
    renderBoard();
    expect(await screen.findByText('NORTH — DUMMY · YOURS')).toBeInTheDocument();
    expect(screen.getByText('SOUTH — YOU · YOUR TURN')).toBeInTheDocument();
    // follow-suit helper: spades led, only spades legal
    expect(screen.getByText(/spades are live — you must follow suit/)).toBeInTheDocument();

    const queen = screen.getByRole('button', { name: 'Q of ♠' });
    await userEvent.click(queen);
    expect(screen.getByText(/Q♠ selected — tap again to play/)).toBeInTheDocument();
    expect(apiMock.playCard).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Q of ♠' }));
    expect(apiMock.playCard).toHaveBeenCalledWith(12, 2, boardPlaying.legalCards![1]);
  });

  it('switches the interactive fan to dummy on dummy’s turn', async () => {
    apiMock.board.mockResolvedValue(boardPlayingDummyTurn);
    renderBoard();
    expect(await screen.findByText('NORTH — DUMMY · YOURS — YOUR TURN')).toBeInTheDocument();
    expect(screen.getByText(/playing from dummy/)).toBeInTheDocument();
    // a dummy card is playable
    const dummyCard = boardPlayingDummyTurn.dummyHand![0];
    const fans = document.querySelectorAll('.handfan');
    expect(fans[0].className).toContain('interactive');
    expect(fans[1].className).not.toContain('interactive');
  });

  it('flips the board when partner declares: banner, labels and rotated compass', async () => {
    apiMock.board.mockResolvedValue(boardPlayingFlipped);
    renderBoard();
    expect(await screen.findByText(/Partner won the auction — board flipped/)).toBeInTheDocument();
    // my North hand at the bottom, South hand shown as dummy
    expect(screen.getByText('NORTH — YOU, FOR PARTNER · YOUR TURN')).toBeInTheDocument();
    expect(screen.getByText('SOUTH — YOUR HAND, DUMMY')).toBeInTheDocument();
    // compass rotated: North (declarer, mine) rendered in the bottom slot
    const bottom = document.querySelector('.trick .seatpos.s')!;
    expect(bottom.textContent).toContain('N · DECL · YOU');
    const top = document.querySelector('.trick .seatpos.n')!;
    expect(top.textContent).toContain('S · DUMMY');
  });

  it('keeps both orientations straight on unflipped boards', async () => {
    apiMock.board.mockResolvedValue(boardPlaying);
    renderBoard();
    await screen.findByText('SOUTH — YOU · YOUR TURN');
    const bottom = document.querySelector('.trick .seatpos.s')!;
    expect(bottom.textContent).toContain('S · DECL · YOU');
    const top = document.querySelector('.trick .seatpos.n')!;
    expect(top.textContent).toContain('N · DUMMY');
  });
});

describe('Board — result', () => {
  it('shows the scored hero, field table, deal diagram and bidding recap', async () => {
    apiMock.board.mockResolvedValue(boardDone);
    renderBoard();
    expect(await screen.findByText('SCORED')).toBeInTheDocument();
    expect(screen.getByText('4♠ by S')).toBeInTheDocument();
    expect(screen.getByText('+620 for N–S · NS vul')).toBeInTheDocument();
    // pct-big keeps its class; 58% in flip digits
    const pct = document.querySelector('.pct-big')!;
    expect(pct.textContent).toContain('5');
    expect(pct.textContent).toContain('%');
    expect(pct.className).not.toContain('low');
    expect(screen.getByText(/MATCHPOINTS · VS 3 OTHER PLAYERS · BIDDING 89%/)).toBeInTheDocument();

    // field table with self highlighted
    expect(screen.getByText('THE FIELD — BOARD 2')).toBeInTheDocument();
    const table = document.querySelector('.fieldtable')!;
    expect(within(table as HTMLElement).getByText('You').closest('tr')!.className).toContain('me');
    expect(within(table as HTMLElement).getByText(/4♠\+1 by S · \+650/)).toBeInTheDocument();

    // deal diagram from allHands, my seat emphasized
    expect(screen.getByText('SOUTH · YOU')).toBeInTheDocument();
    expect(screen.getByText('NORTH · DUMMY')).toBeInTheDocument();

    // bidding recap with stars and the robot comparison (convention named when known)
    expect(screen.getByText('YOUR BIDDING')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /of 3 stars/ })).toHaveLength(4);
    expect(screen.getAllByText(/robot bid/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\(Limit raise\)/).length).toBeGreaterThan(0);

    expect(screen.getByRole('button', { name: /NEXT BOARD — 3 OF 4/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to lobby/i })).toHaveAttribute('href', '/');
  });

  it('marks a poor board in the low treatment', async () => {
    apiMock.board.mockResolvedValue(boardDoneLow);
    renderBoard();
    await screen.findByText('SCORED');
    expect(document.querySelector('.pct-big')!.className).toContain('low');
  });

  it('offers the tournament summary from the last board', async () => {
    apiMock.board.mockResolvedValue({ ...boardDone, boardNo: 4 });
    renderBoard();
    expect(await screen.findByRole('button', { name: /tournament summary/i })).toBeInTheDocument();
  });

  it('surfaces load failures with a way home', async () => {
    apiMock.board.mockRejectedValue(new Error('board not found'));
    renderBoard();
    expect(await screen.findByText('board not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to lobby/i })).toHaveAttribute('href', '/');
  });
});
