import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardView, Me, TrickCard } from '../api';
import {
  AUTO_PLAY_DELAY_MS,
  BID_GAP_MS,
  CLAIM_ANNOUNCE_HOLD_MS,
  CLAIM_LEAD_SETTLE_MS,
  GLIDE_MS,
  ROBOT_GAP_MS,
  motionOK,
} from '../components/game/playAnim';
import {
  bid2H,
  boardBidding,
  boardBiddingBurst,
  boardBiddingOpening,
  boardBiddingRobots,
  boardDone,
  boardDoneLow,
  boardPlaying,
  boardPlayingDummyTurn,
  boardPlayingEastDummy,
  boardPlayingFlipped,
  boardPlayingWestDummy,
  meFixture,
} from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Board, { RESYNC_ATTEMPT_LIMIT, RESYNC_MESSAGE, RESYNC_MIN_NOTICE_MS, RESYNC_STUCK_MESSAGE } from './Board';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

const renderBoard = (me: Me = meFixture) =>
  renderWithMe(
    <Routes>
      <Route path="/t/:tid/b/:no" element={<Board />} />
    </Routes>,
    { me, route: '/t/12/b/2' },
  );

const inAuction = () => within(document.querySelector('.auction') as HTMLElement);

// Safety net: if a fake-timer test below throws or times out mid-await, its
// own try/finally may not unwind before the next test starts — never leave
// fake timers active for a test that didn't ask for them.
afterEach(() => {
  vi.useRealTimers();
});

describe('Board — bidding', () => {
  it('shows the ticket header with deal conditions and the vul chip', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    renderBoard();
    expect(await screen.findByText('Tournament #12')).toBeInTheDocument();
    expect(screen.getByText(/Dealer N/)).toBeInTheDocument();
    expect(screen.getByText('NS VUL')).toBeInTheDocument();
  });

  it('plays the ink-wash pulse on a vulnerable board entering bidding, but not on a non-vulnerable one', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    renderBoard();
    // The pulse-triggering effect fires in the render after the one that
    // first paints the vul chip's text, so wait for the class rather than
    // asserting on it the instant the text itself appears.
    const nsVulChip = await screen.findByText('NS VUL');
    await waitFor(() => expect(nsVulChip).toHaveClass('board-vul-pulse'));

    apiMock.board.mockResolvedValue({ ...boardBidding, vul: { ns: false, ew: false } });
    renderWithMe(
      <Routes>
        <Route path="/t/:tid/b/:no" element={<Board />} />
      </Routes>,
      { me: meFixture, route: '/t/12/b/3' },
    );
    expect(await screen.findByText('NONE VUL')).not.toHaveClass('board-vul-pulse');
  });

  it('pulses in the chip\'s own resting color, not hardcoded red, on an EW-only-vulnerable board', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    renderBoard();
    const nsVulChip = await screen.findByText('NS VUL');
    // NS-vulnerable: Chip sets --chip-color so the pulse (which reads that
    // var) renders red, matching the resting chip's own red border.
    expect(nsVulChip.style.getPropertyValue('--chip-color')).toBe('var(--suit-h)');

    apiMock.board.mockResolvedValue({ ...boardBidding, vul: { ns: false, ew: true } });
    renderWithMe(
      <Routes>
        <Route path="/t/:tid/b/:no" element={<Board />} />
      </Routes>,
      { me: meFixture, route: '/t/12/b/4' },
    );
    const ewVulChip = await screen.findByText('EW VUL');
    await waitFor(() => expect(ewVulChip).toHaveClass('board-vul-pulse'));
    // EW-only vulnerable: the resting chip is plain ink, not red (unchanged,
    // pre-existing behavior) — --chip-color must stay unset so the pulse's
    // CSS fallback (var(--ink)) kicks in instead of a red flourish over a
    // chip that was never red.
    expect(ewVulChip.style.getPropertyValue('--chip-color')).toBe('');
  });

  it('lands the whole opening tray at once under reduced motion', async () => {
    // jsdom has no WAAPI, so motionOK() is false here (the reveal's own tests
    // live in 'Board — staged bidding', which stubs it): load() applies the
    // server view in one go and the turn is the player's from the first frame.
    apiMock.board.mockResolvedValue(boardBiddingOpening);
    renderBoard();
    expect(await screen.findByText('SOUTH · YOU')).toBeInTheDocument();
    expect(inAuction().getAllByRole('button')).toHaveLength(boardBiddingOpening.auction.length);
    expect(document.querySelector('.bidbox-waiting')).not.toBeInTheDocument();
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
    // toHaveTextContent, not getByText: glossary links split the prose across elements
    expect(document.querySelector('.mtitle')).toHaveTextContent('Rebid, invitational');
    expect(screen.getByText('10–12 HCP')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Bid 2♥' }));
    expect(apiMock.call).toHaveBeenCalledWith(12, 2, bid2H);
    // grade toast lands on the refreshed board
    expect(await screen.findByText('Excellent')).toBeInTheDocument();
    expect(screen.getByText('Robots are thinking…')).toBeInTheDocument();
  });

  it('tap-to-bid: the placeholder teaches it, and a second tap on the selected call submits — no confirm needed', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    apiMock.call.mockResolvedValue({
      evaluation: { call: bid2H, bestCall: bid2H, userProb: 0.7, bestProb: 0.7, grade: 'excellent', score: 1 },
      board: boardBiddingRobots,
    });
    renderBoard();
    // the placeholder signposts the gesture up front
    expect(await screen.findByText(/tap again to make the call/i)).toBeInTheDocument();
    // first tap selects and previews it — no submit yet
    await userEvent.click(screen.getByRole('button', { name: '2♥' }));
    expect(document.querySelector('.mtitle')).toHaveTextContent('Rebid, invitational');
    expect(apiMock.call).not.toHaveBeenCalled();
    // second tap on the same call commits, just like tap-again in card play
    await userEvent.click(screen.getByRole('button', { name: '2♥' }));
    expect(apiMock.call).toHaveBeenCalledWith(12, 2, bid2H);
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

  it('keeps the grade toast visible when the bid ends the auction', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    apiMock.call.mockResolvedValue({
      evaluation: { call: bid2H, bestCall: bid2H, userProb: 0.7, bestProb: 0.7, grade: 'excellent', score: 1 },
      board: boardPlaying, // robots passed it out — straight to the play phase
    });
    renderBoard();
    await screen.findByText(/Tap a bid to see what it means/);
    await userEvent.click(screen.getByRole('button', { name: '2♥' }));
    await userEvent.click(screen.getByRole('button', { name: 'Bid 2♥' }));
    await screen.findByText('Excellent');
    expect(document.querySelector('.grade-toast')).toBeInTheDocument();
    expect(document.querySelector('.trick')).toBeInTheDocument();
  });

  // "Bid feedback" (settings gate) only hides the toast — grading is still
  // requested and applied to the auction on the refreshed board either way.
  it('suppresses the grade toast when "Bid feedback" is off, but still grades the call', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    apiMock.call.mockResolvedValue({
      evaluation: { call: bid2H, bestCall: bid2H, userProb: 0.7, bestProb: 0.7, grade: 'excellent', score: 1 },
      board: boardBiddingRobots,
    });
    renderWithMe(
      <Routes>
        <Route path="/t/:tid/b/:no" element={<Board />} />
      </Routes>,
      { me: { ...meFixture, user: { ...meFixture.user!, bidFeedback: false } }, route: '/t/12/b/2' },
    );
    await screen.findByText(/Tap a bid to see what it means/);
    await userEvent.click(screen.getByRole('button', { name: '2♥' }));
    await userEvent.click(screen.getByRole('button', { name: 'Bid 2♥' }));
    // grading was still requested from the server …
    expect(apiMock.call).toHaveBeenCalledWith(12, 2, bid2H);
    await screen.findByText('Robots are thinking…');
    // … but nothing renders the grade
    expect(screen.queryByText('Excellent')).not.toBeInTheDocument();
    expect(document.querySelector('.grade-toast')).not.toBeInTheDocument();
  });

  it('lands the whole robot burst at once under reduced motion', async () => {
    // The no-WAAPI contract: motionOK() is false throughout this file, so
    // stageBidSteps never runs and applyBoard falls back to one setBoard.
    // The fixture has to be one whose auction GROWS (boardBiddingBurst, not
    // boardBiddingRobots — that one's auction is a truncated slice, shorter
    // than the board we started from, so stageBidSteps would bail on
    // `next.auction.length <= from` and this would pass with motion on too).
    apiMock.board.mockResolvedValue(boardBidding);
    apiMock.call.mockResolvedValue({
      evaluation: { call: bid2H, bestCall: bid2H, userProb: 0.7, bestProb: 0.7, grade: 'excellent', score: 1 },
      board: boardBiddingBurst,
    });
    renderBoard();
    await screen.findByText(/Tap a bid to see what it means/);
    await userEvent.click(screen.getByRole('button', { name: '2♥' }));
    await userEvent.click(screen.getByRole('button', { name: 'Bid 2♥' }));
    expect(await screen.findByText('Excellent')).toBeInTheDocument();
    // every reply is already on the tray, and the turn is back — no reveal
    expect(inAuction().getByRole('button', { name: '2♥' })).toBeInTheDocument();
    expect(inAuction().getByRole('button', { name: '2♠' })).toBeInTheDocument();
    expect(inAuction().getAllByRole('button', { name: 'Pass' })).toHaveLength(6);
    expect(document.querySelector('.bidbox-waiting')).not.toBeInTheDocument();
  });

  it('falls back to the bare notice when a response has no calls to show', async () => {
    // The other arm of the dock condition (`myTurn || legalCalls?.length`):
    // a server view that is genuinely not our turn AND carries no legal
    // calls has no box to render, so the plain notice takes the dock.
    apiMock.board.mockResolvedValue(boardBidding);
    apiMock.call.mockResolvedValue({
      evaluation: { call: bid2H, bestCall: bid2H, userProb: 0.7, bestProb: 0.7, grade: 'excellent', score: 1 },
      board: boardBiddingRobots,
    });
    renderBoard();
    await screen.findByText(/Tap a bid to see what it means/);
    await userEvent.click(screen.getByRole('button', { name: '2♥' }));
    await userEvent.click(screen.getByRole('button', { name: 'Bid 2♥' }));
    expect(await screen.findByText('Excellent')).toBeInTheDocument();
    expect(screen.getByText('Robots are thinking…')).toBeInTheDocument();
    expect(document.querySelector('.bid-dock .bidbox')).not.toBeInTheDocument();
  });

  it('docks the bid box at the foot, with the auction + feedback scrolling above it', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    renderBoard();
    await screen.findByText('SOUTH · YOU');
    // the page runs at a fixed height so the dock can pin; the bid box lives in
    // that dock while the meaning/feedback + hand sit in the scroll region above
    expect(document.querySelector('.board-page.bidding-dock')).toBeInTheDocument();
    expect(document.querySelector('.bid-dock .bidbox')).toBeInTheDocument();
    expect(document.querySelector('.bid-scroll .bid-decision .meaning-panel')).toBeInTheDocument();
  });

  it('opens the call inspector dialog from a past auction call', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    renderBoard();
    await screen.findByText('SOUTH · YOU');
    await userEvent.click(inAuction().getByRole('button', { name: '1♥' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Opening, one of a major');
    await userEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows my hand with the HCP badge and seat label', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    renderBoard();
    expect(await screen.findByText('SOUTH · YOU')).toBeInTheDocument();
    expect(screen.getByText('12 HCP')).toBeInTheDocument();
  });
});

describe('Board — play', () => {
  it('lays out dummy, trick area and my fan; tap-select then tap-again plays', async () => {
    apiMock.board.mockResolvedValue(boardPlaying);
    apiMock.playCard.mockResolvedValue({ board: boardPlaying });
    renderBoard();
    expect(await screen.findByText('NORTH · DUMMY')).toBeInTheDocument();
    expect(screen.getByText('SOUTH · YOU')).toBeInTheDocument();

    const queen = screen.getByRole('button', { name: 'Q of ♠' });
    await userEvent.click(queen);
    expect(screen.getByText((_, el) => el?.textContent === 'Q♠ selected — tap again to play')).toBeInTheDocument();
    expect(apiMock.playCard).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Q of ♠' }));
    expect(apiMock.playCard).toHaveBeenCalledWith(12, 2, boardPlaying.legalCards![1]);
  });

  it('keeps the auction visible and inspectable during play', async () => {
    apiMock.board.mockResolvedValue(boardPlaying);
    renderBoard();
    await screen.findByText('SOUTH · YOU');
    expect(document.querySelector('.auction')).toBeInTheDocument();
    // the completed auction, no pending "?" for a phase that's already over
    expect(screen.queryByText('?')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '1♥' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Opening, one of a major');
  });

  it('switches the interactive fan to dummy on dummy’s turn', async () => {
    apiMock.board.mockResolvedValue(boardPlayingDummyTurn);
    renderBoard();
    expect(await screen.findByText('NORTH · DUMMY')).toBeInTheDocument();
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
    expect(screen.getByText('NORTH · YOU')).toBeInTheDocument();
    expect(screen.getByText('SOUTH · DUMMY')).toBeInTheDocument();
    // compass rotated: North (declarer, mine) rendered in the bottom slot
    const bottom = document.querySelector('.trick .seatpos.s')!;
    expect(bottom.textContent).toContain('N · DECL · YOU');
    const top = document.querySelector('.trick .seatpos.n')!;
    expect(top.textContent).toContain('S · DUMMY');
  });

  it('keeps both orientations straight on unflipped boards', async () => {
    apiMock.board.mockResolvedValue(boardPlaying);
    renderBoard();
    await screen.findByText('SOUTH · YOU');
    const bottom = document.querySelector('.trick .seatpos.s')!;
    expect(bottom.textContent).toContain('S · DECL · YOU');
    const top = document.querySelector('.trick .seatpos.n')!;
    expect(top.textContent).toContain('N · DUMMY');
    // North/South dummy keeps the full-width top fan, not the rail
    expect(document.querySelector('.play-row')).not.toBeInTheDocument();
    expect(document.querySelector('.dummy-rail')).not.toBeInTheDocument();
  });

  it('shows an East dummy as a rail on the right, not the top fan', async () => {
    apiMock.board.mockResolvedValue(boardPlayingEastDummy);
    renderBoard();
    await screen.findByText('SOUTH · YOU');
    // no top-fan seat line for dummy — East never plays into the human's hands
    expect(screen.queryByText(/EAST · DUMMY/)).not.toBeInTheDocument();
    const rail = document.querySelector('.dummy-rail-right')!;
    expect(rail).toBeInTheDocument();
    expect(rail.textContent).toContain('EAST');
    expect(rail.textContent).toContain('10 HCP');
    // trick box still gets the correct compass tags either side of the rail
    const east = document.querySelector('.trick .seatpos.e')!;
    expect(east.textContent).toContain('E · DUMMY');
    const west = document.querySelector('.trick .seatpos.w')!;
    expect(west.textContent).toContain('W · DECL');
    // only one hand fan on screen — the human's own, at the bottom
    expect(document.querySelectorAll('.handfan')).toHaveLength(1);
    // the auction stays visible above the rail layout too
    expect(document.querySelector('.auction')).toBeInTheDocument();
  });

  it('shows a West dummy as a rail on the left', async () => {
    apiMock.board.mockResolvedValue(boardPlayingWestDummy);
    renderBoard();
    await screen.findByText('SOUTH · YOU');
    const rail = document.querySelector('.dummy-rail-left')!;
    expect(rail).toBeInTheDocument();
    expect(rail.textContent).toContain('WEST');
    expect(rail.textContent).toContain('8 HCP');
    const west = document.querySelector('.trick .seatpos.w')!;
    expect(west.textContent).toContain('W · DUMMY');
    const east = document.querySelector('.trick .seatpos.e')!;
    expect(east.textContent).toContain('E · DECL');
  });
});

describe('Board — the tapped card does not wait for the server', () => {
  const myCard = boardPlaying.legalCards![1]; // Q♠
  const afterPlay: BoardView = {
    ...boardPlaying,
    hand: boardPlaying.hand.filter((c) => c !== myCard),
    currentTrick: [],
    completedTricks: 5,
    declarerTricks: 4,
    lastTrick: [...boardPlaying.currentTrick!, { seat: 2, card: myCard }],
    myTurn: true,
    handToPlay: 2,
    legalCards: [boardPlaying.legalCards![0]],
  };

  /** Tap-select then tap-confirm, with POST /play left deliberately hanging. */
  async function tapWithRequestInFlight() {
    let settle!: (value: { board: BoardView }) => void;
    let fail!: (err: Error) => void;
    apiMock.board.mockResolvedValue(boardPlaying);
    apiMock.playCard.mockReturnValue(
      new Promise<{ board: BoardView }>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
    );
    renderBoard();
    await screen.findByText('SOUTH · YOU');
    await userEvent.click(screen.getByRole('button', { name: 'Q of ♠' }));
    await userEvent.click(screen.getByRole('button', { name: 'Q of ♠' }));
    expect(apiMock.playCard).toHaveBeenCalledWith(12, 2, myCard);
    return { settle, fail };
  }

  const southSlot = () => document.querySelector('.trick .seatpos.s');

  it('lands my card in the trick slot while the request is still out', async () => {
    const { settle } = await tapWithRequestInFlight();

    // the whole point: the card is on the table with no response yet
    expect(southSlot()?.querySelector('.pcard')).toHaveTextContent('Q');
    // and it has left my fan, so the "tap again" prompt is gone
    expect(screen.queryByRole('button', { name: 'Q of ♠' })).not.toBeInTheDocument();
    expect(screen.queryByText(/selected — tap again to play/)).not.toBeInTheDocument();
    expect(screen.getByText('Robots are thinking…')).toBeInTheDocument();

    settle({ board: afterPlay });
    await waitFor(() => expect(screen.getByRole('button', { name: 'A of ♠' })).toBeEnabled());
  });

  it('locks the fan while the request is out, so a second tap cannot land', async () => {
    const { settle } = await tapWithRequestInFlight();

    // every remaining card is non-interactive until the server answers —
    // the same lock a staged robot burst applies (myTurn false, no legalCards)
    for (const button of screen.getAllByRole('button', { name: /of [♠♥♦♣]$/ })) {
      expect(button).toBeDisabled();
    }
    expect(apiMock.playCard).toHaveBeenCalledTimes(1);

    settle({ board: afterPlay });
    await waitFor(() => expect(screen.getByRole('button', { name: 'A of ♠' })).toBeEnabled());
  });

  it('leaves the board you moved on to alone when the old board’s play settles late', async () => {
    // Board.tsx stays mounted across a board change (params change, load()
    // refetches), so a response for the board you left still lands in this
    // component — with preTap/shown closed over from the old one.
    let fail!: (err: Error) => void;
    apiMock.board.mockImplementation((_tid: number, no: number) =>
      Promise.resolve(no === 2 ? boardPlaying : { ...boardBidding, boardNo: 3 }),
    );
    apiMock.playCard.mockReturnValue(new Promise<{ board: BoardView }>((_resolve, reject) => (fail = reject)));

    function GoToBoard3() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate('/t/12/b/3')}>
          go to board 3
        </button>
      );
    }
    renderWithMe(
      <>
        <GoToBoard3 />
        <Routes>
          <Route path="/t/:tid/b/:no" element={<Board />} />
        </Routes>
      </>,
      { me: meFixture, route: '/t/12/b/2' },
    );

    await screen.findByText('SOUTH · YOU');
    await userEvent.click(screen.getByRole('button', { name: 'Q of ♠' }));
    await userEvent.click(screen.getByRole('button', { name: 'Q of ♠' }));

    // leave for another board while the play is still out
    await userEvent.click(screen.getByRole('button', { name: 'go to board 3' }));
    expect(await screen.findByText(/Tap a bid to see what it means/)).toBeInTheDocument();

    // ...and only now does the old board's play fail
    fail(new Error('not your turn'));
    await waitFor(() => expect(apiMock.playCard).toHaveBeenCalledTimes(1));

    // board 3 is untouched: no rollback painted over it, and no error screen
    // for a board the player is no longer looking at
    expect(screen.getByText(/Tap a bid to see what it means/)).toBeInTheDocument();
    expect(screen.queryByText('not your turn')).not.toBeInTheDocument();
    expect(document.querySelector('.trick')).not.toBeInTheDocument();
  });

  it('resyncs to the server’s real position when the play is rejected', async () => {
    const { fail } = await tapWithRequestInFlight();
    expect(southSlot()?.querySelector('.pcard')).toHaveTextContent('Q');

    // Hold the resync's GET open so the in-flight state is observable, then
    // answer it with what really happened: another device played the ♠A into
    // this same trick, so the position the tap was made against is gone.
    let settleBoard!: (view: BoardView) => void;
    apiMock.board.mockReturnValue(new Promise<BoardView>((resolve) => (settleBoard = resolve)));

    // a genuine race: another tab's play landed first, so submitPlay refuses
    fail(new Error('not your turn'));
    expect(await screen.findByText(RESYNC_MESSAGE)).toBeInTheDocument();

    // While the refetch is out the board is LOCKED, not handed back: the
    // optimistic card is gone, but nothing is tappable either, because the
    // trick on screen is one the server has already moved past.
    expect(southSlot()?.querySelector('.pcard')).toBeNull();
    for (const button of screen.getAllByRole('button', { name: /of [♠♥♦♣]$/ })) {
      expect(button).toBeDisabled();
    }

    // Fake timers from here so the HOLD is observable rather than raced: the
    // refetch answers in microseconds under a mock, which is exactly the
    // problem RESYNC_MIN_NOTICE_MS exists to solve on a real server too.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      settleBoard({
        ...boardPlaying,
        hand: boardPlaying.hand.filter((c) => c !== boardPlaying.legalCards![0]),
        currentTrick: [...boardPlaying.currentTrick!, { seat: 2, card: boardPlaying.legalCards![0] }],
        myTurn: false,
        handToPlay: undefined,
        legalCards: undefined,
      });

      // The true position has arrived, but the notice owns the screen for its
      // full read first — the board must NOT jump out from under the player.
      await vi.advanceTimersByTimeAsync(RESYNC_MIN_NOTICE_MS - 500);
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByText(RESYNC_MESSAGE)).toBeInTheDocument();
      expect(southSlot()?.querySelector('.pcard')).toBeNull();

      // ...and only then do the notice and the real board swap together
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(0); // the apply fires outside act()
      expect(screen.queryByText(RESYNC_MESSAGE)).not.toBeInTheDocument();
      expect(apiMock.board).toHaveBeenCalledTimes(2);
      expect(southSlot()?.querySelector('.pcard')).toHaveTextContent('A');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up resyncing rather than ping-pong with a device that keeps refusing', async () => {
    // The resync only settles anything if the server eventually agrees with
    // its own GET. A second device playing continuously would otherwise loop
    // refuse → refetch → auto-play → refuse forever, two round trips a lap.
    const soleCard = boardPlaying.legalCards![1]; // Q♠
    const forced: BoardView = { ...boardPlaying, legalCards: [soleCard] };
    apiMock.board.mockImplementation(() => Promise.resolve({ ...forced }));
    apiMock.playCard.mockRejectedValue(new Error('not your turn'));

    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText(/playing automatically/)).toBeInTheDocument());
      // let it try, resync, try again... one delay at a time, since each lap
      // needs React to commit the resynced board before the timer re-arms
      for (let i = 0; i < 12 && !screen.queryByText(RESYNC_STUCK_MESSAGE); i++) {
        await vi.advanceTimersByTimeAsync(AUTO_PLAY_DELAY_MS + RESYNC_MIN_NOTICE_MS);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(screen.getByText(RESYNC_STUCK_MESSAGE)).toBeInTheDocument();
      expect(apiMock.playCard).toHaveBeenCalledTimes(RESYNC_ATTEMPT_LIMIT);

      // ...and then stops, rather than going around again
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(AUTO_PLAY_DELAY_MS + RESYNC_MIN_NOTICE_MS);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(apiMock.playCard).toHaveBeenCalledTimes(RESYNC_ATTEMPT_LIMIT);

      // the way out is the player's, and it resets the count
      fireEvent.click(screen.getByRole('button', { name: 'Reload the board' }));
      for (let i = 0; i < 4 && apiMock.playCard.mock.calls.length === RESYNC_ATTEMPT_LIMIT; i++) {
        await vi.advanceTimersByTimeAsync(AUTO_PLAY_DELAY_MS + RESYNC_MIN_NOTICE_MS);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(apiMock.playCard.mock.calls.length).toBeGreaterThan(RESYNC_ATTEMPT_LIMIT);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Board — the robot reply is paced from the tap, not from the response', () => {
  // Every other Board test runs with motionOK() false (jsdom ships no WAAPI),
  // which means stagePlaySteps is never called and applyBoard's whole trim
  // path is dead. That is not a gap worth leaving: without the trim the
  // staged list still leads with the human's card — already on screen — so
  // the robot's reply lands a full GLIDE_MS + ROBOT_GAP_MS beat AFTER the
  // response instead of after the tap, which is the exact lag this feature
  // exists to remove, and nothing else in the suite would notice.
  //
  // Stubbing animate() is enough to turn the staged path on: TrickArea's
  // glideIn/collectSweep both bail on a zero-width getBoundingClientRect, so
  // no animation actually runs in jsdom.
  const withWaapi = () => {
    const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'animate');
    const before = Element.prototype.animate;
    Element.prototype.animate = (() => ({ onfinish: null, oncancel: null, cancel() {} })) as never;
    return () => {
      if (had) Element.prototype.animate = before;
      else delete (Element.prototype as { animate?: unknown }).animate;
    };
  };

  const myCard = boardPlaying.legalCards![1]; // Q♠
  // South LEADS trick 5 (not the trick-in-progress boardPlaying ships with),
  // so the burst is two cards in one trick and no boundary: my card, then
  // West's reply, then it is dummy's turn. stagePlaySteps therefore emits
  // [my card @0, West @GLIDE_MS+ROBOT_GAP_MS, server view @GLIDE_MS+160].
  const onLead: BoardView = { ...boardPlaying, currentTrick: [], handToPlay: 2 };
  const westCard = boardPlaying.dummyHand!.find((c) => !boardPlaying.hand.includes(c))! + 0;
  const afterBurst: BoardView = {
    ...onLead,
    hand: onLead.hand.filter((c) => c !== myCard),
    currentTrick: [
      { seat: 2, card: myCard },
      { seat: 3, card: westCard },
    ],
    myTurn: true,
    handToPlay: 0,
    legalCards: boardPlaying.dummyHand!,
  };

  // Deliberately generous margins rather than knife-edge boundaries: the
  // claim under test is which EVENT the beat is measured from, and the two
  // answers are 710ms and 1010ms apart from the tap. Asserting to the
  // millisecond only buys flakiness from how the mocked promise's
  // continuation interleaves with the fake clock.
  const ROUND_TRIP_MS = 300;
  const BEAT_MS = GLIDE_MS + ROBOT_GAP_MS; // 710 — the gap the animation always spent
  const westOnTable = () => Boolean(document.querySelector('.trick .seatpos.w .pcard'));

  // A staged step's setBoard fires from a bare setTimeout, outside act(), so
  // React has committed nothing by the time advanceTimersByTimeAsync returns.
  // The trailing zero-advance lets it, which matters in BOTH directions here:
  // without it an uncommitted render reads exactly like a card that has not
  // landed yet, and the "not yet" assertions would pass for the wrong reason.
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  };

  it('subtracts the round trip from the beat before the robot answers', async () => {
    const restore = withWaapi();
    apiMock.board.mockResolvedValue(onLead);
    let settle!: (value: { board: BoardView }) => void;
    apiMock.playCard.mockReturnValue(new Promise<{ board: BoardView }>((resolve) => (settle = resolve)));

    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText('SOUTH · YOU')).toBeInTheDocument());
      expect(motionOK()).toBe(true); // the staged path really is live here
      const queen = screen.getByRole('button', { name: 'Q of ♠' });
      fireEvent.click(queen);
      fireEvent.click(queen);

      // my card is on the table at once; the robot's is not
      expect(document.querySelector('.trick .seatpos.s .pcard')).toHaveTextContent('Q');
      expect(westOnTable()).toBe(false);

      // the server takes ROUND_TRIP_MS to answer
      await advance(ROUND_TRIP_MS);
      settle({ board: afterBurst });
      await advance(0);
      expect(westOnTable()).toBe(false);

      // Still inside the beat measured FROM THE TAP, so nothing has moved...
      await advance(BEAT_MS - ROUND_TRIP_MS - 60);
      expect(westOnTable()).toBe(false);
      // ...and just past it, the robot answers. Without the subtraction this
      // is still 240ms away: the beat would restart at the RESPONSE, putting
      // the robot's card at tap + ROUND_TRIP_MS + BEAT_MS instead.
      await advance(120);
      expect(westOnTable()).toBe(true);

      // and the real server view still lands after it, unlocking the fans
      await advance(GLIDE_MS + 160);
      await vi.waitFor(() => expect(screen.getByText(/playing from dummy/)).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it('never rushes the robot when the response beats the beat', async () => {
    // The subtraction only ever spends time that has actually passed — a
    // response faster than the beat must not shorten it.
    const restore = withWaapi();
    apiMock.board.mockResolvedValue(onLead);
    apiMock.playCard.mockResolvedValue({ board: afterBurst });

    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText('SOUTH · YOU')).toBeInTheDocument());
      const queen = screen.getByRole('button', { name: 'Q of ♠' });
      fireEvent.click(queen);
      fireEvent.click(queen);
      await advance(0);

      await advance(BEAT_MS - 60);
      expect(westOnTable()).toBe(false);
      await advance(120);
      expect(westOnTable()).toBe(true);
    } finally {
      vi.useRealTimers();
      restore();
    }
  });
});

describe('Board — staged bidding', () => {
  // The motion path. jsdom has no WAAPI, so motionOK() is false everywhere
  // else in this file and stageBidSteps never runs; stub `animate` to take
  // the other branch. Safe here specifically because this fixture stays in
  // the BIDDING phase throughout, so TrickArea's card-clone/onfinish flight
  // machinery never mounts against the stub.
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    );
    (Element.prototype as unknown as { animate: unknown }).animate = () => ({ onfinish: null, cancel() {} });
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).animate;
    vi.unstubAllGlobals();
  });

  it('reveals the robots’ calls one at a time, holding the dock until they are done', async () => {
    apiMock.board.mockResolvedValue(boardBidding);
    apiMock.call.mockResolvedValue({
      evaluation: { call: bid2H, bestCall: bid2H, userProb: 0.7, bestProb: 0.7, grade: 'excellent', score: 1 },
      board: boardBiddingBurst,
    });

    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText('SOUTH · YOU')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: '2♥' }));
      fireEvent.click(screen.getByRole('button', { name: 'Bid 2♥' }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // my own call lands the instant I commit — but the robots' don't, and
      // the dock says so for real rather than for zero frames
      expect(inAuction().getByRole('button', { name: '2♥' })).toBeInTheDocument();
      expect(inAuction().queryByRole('button', { name: '2♠' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Robots are thinking' })).toBeInTheDocument();
      // ...with the box still docked and inert, not swapped out: it sizes the
      // dock, and everything above hugs the dock's top edge
      expect(document.querySelector('.bid-dock .bidbox')).toBeInTheDocument();
      expect(document.querySelector('.bidbox-waiting')).toBeInTheDocument();
      expect(document.querySelectorAll('.bidbox button.bid:not(:disabled)')).toHaveLength(0);
      // the grade toast is up throughout, and never remounts under it
      const toast = document.querySelector('.grade-toast')!;
      expect(toast).toBeInTheDocument();

      // one beat, one more call — and exactly one cell wearing the drop-in
      await vi.advanceTimersByTimeAsync(BID_GAP_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(inAuction().getByRole('button', { name: '2♠' })).toBeInTheDocument();
      expect(document.querySelectorAll('.auction-latest')).toHaveLength(1);
      expect(document.querySelector('.grade-toast')).toBe(toast);

      // ...the robots' last two passes (four were already on the tray), with
      // the dock still theirs
      await vi.advanceTimersByTimeAsync(BID_GAP_MS * 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(inAuction().getAllByRole('button', { name: 'Pass' })).toHaveLength(6);
      expect(document.querySelector('.bidbox-waiting')).toBeInTheDocument();

      // ...and only then does the turn come back
      await vi.advanceTimersByTimeAsync(BID_GAP_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.bidbox-waiting')).not.toBeInTheDocument();
      expect(document.querySelectorAll('.bidbox button.bid:not(:disabled)').length).toBeGreaterThan(0);
      expect(document.querySelector('.grade-toast')).toBe(toast);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals the calls already on the tray when a board is first opened', async () => {
    apiMock.board.mockResolvedValue(boardBiddingOpening); // West dealt: three robot calls precede ours

    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText('SOUTH · YOU')).toBeInTheDocument());
      await vi.advanceTimersByTimeAsync(0);

      // the board arrives with an EMPTY tray: West's pass and North's 1♥ are
      // news the player walked in on, not scenery the grid was born with
      expect(inAuction().queryAllByRole('button')).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Robots are thinking' })).toBeInTheDocument();
      expect(document.querySelector('.bid-dock .bidbox')).toBeInTheDocument();

      // one beat, one call — and the drop-in fires on each in turn rather than
      // on the last one alone, which is all a whole-tray arrival ever animated
      await vi.advanceTimersByTimeAsync(BID_GAP_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(inAuction().queryAllByRole('button')).toHaveLength(1);
      expect(document.querySelectorAll('.auction-latest')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(BID_GAP_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(inAuction().getByRole('button', { name: '1♥' })).toBeInTheDocument();
      expect(document.querySelectorAll('.auction-latest')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(BID_GAP_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(inAuction().queryAllByRole('button')).toHaveLength(3);
      expect(document.querySelector('.bidbox-waiting')).toBeInTheDocument();

      // ...and only then is it the player's turn to call
      await vi.advanceTimersByTimeAsync(BID_GAP_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.bidbox-waiting')).not.toBeInTheDocument();
      expect(document.querySelectorAll('.bidbox button.bid:not(:disabled)').length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a board the player has already bid on alone', async () => {
    // boardBidding's auction carries South's own 1♥, so this is a return
    // visit — a reload, a second device, the back button — and replaying an
    // auction the player has read would be a delay bought with nothing.
    apiMock.board.mockResolvedValue(boardBidding);

    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText('SOUTH · YOU')).toBeInTheDocument());
      await vi.advanceTimersByTimeAsync(0);
      expect(inAuction().queryAllByRole('button')).toHaveLength(boardBidding.auction.length);
      expect(document.querySelector('.bidbox-waiting')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Board — auto-play', () => {
  it('plays the only legal card by itself after a short delay, with no tap required', async () => {
    const soleCard = boardPlaying.legalCards![1]; // Q♠
    const forced: BoardView = { ...boardPlaying, legalCards: [soleCard] };
    apiMock.board.mockResolvedValue(forced);
    apiMock.playCard.mockResolvedValue({ board: forced });

    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText(/Only Q♠ to play — playing automatically…/)).toBeInTheDocument());
      // the sole card reads as selected, same treatment a manual tap gets
      expect(screen.getByRole('button', { name: 'Q of ♠' })).toHaveClass('selected');
      expect(apiMock.playCard).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(AUTO_PLAY_DELAY_MS);
      expect(apiMock.playCard).toHaveBeenCalledWith(12, 2, soleCard);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-play once the user has manually selected a card', async () => {
    const soleCard = boardPlaying.legalCards![1];
    const forced: BoardView = { ...boardPlaying, legalCards: [soleCard] };
    apiMock.board.mockResolvedValue(forced);
    apiMock.playCard.mockResolvedValue({ board: forced });

    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText(/playing automatically/)).toBeInTheDocument());
      // advancing past the delay without a manual tap would auto-play — instead
      // simulate the user already having tapped it once (selectedCard set)
      await vi.advanceTimersByTimeAsync(AUTO_PLAY_DELAY_MS / 2);
      expect(apiMock.playCard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Board — claims', () => {
  // Shared fixture builder: North (NS) wins every one of the "claimed" tricks
  // below on the ace of clubs — unlike placeholderTrick (used only for the
  // already-accounted-for history entries these tests slice off), these
  // ones' winners actually back the declarerTricks/defenderTricks tallies.
  //
  // Load-bearing: N/S also win the trick already in progress (South's ♠Q),
  // so claimAnnouncement reports priorTricks: 0 and there is nothing to pay
  // before the announcement. These two tests are therefore the pin for "a
  // claim with nothing in front of it still pops immediately" — the mixed
  // case, where the defense takes the trick first, is the test below them.
  const buildClaimed = (): BoardView => {
    const soleCard = boardPlaying.legalCards![1]; // Q♠ — completes the trick in progress
    const fullTrick: TrickCard[] = [...boardPlaying.currentTrick!, { seat: 2, card: soleCard }];
    const placeholderTrick: TrickCard[] = [
      { seat: 0, card: 26 },
      { seat: 1, card: 27 },
      { seat: 2, card: 31 },
      { seat: 3, card: 32 },
    ];
    const claimTrick: TrickCard[] = [
      { seat: 0, card: 39 + 12 }, // North: A♣
      { seat: 1, card: 39 + 1 },
      { seat: 2, card: 39 + 2 },
      { seat: 3, card: 39 + 3 },
    ];
    return {
      ...boardPlaying,
      contract: { level: 4, strain: 3, declarer: 2 }, // spades trump, South declares
      state: 'done',
      claimed: true,
      myTurn: false,
      legalCards: undefined,
      currentTrick: [],
      completedTricks: 13,
      declarerTricks: 12,
      defenderTricks: 1,
      lastTrick: claimTrick,
      hand: [],
      dummyHand: [],
      // 4 already-accounted-for tricks, then the 9 new ones (the completed
      // trick-in-progress + 8 claimed tricks) — claimAnnouncement slices off
      // the first `prev.completedTricks` (4) entries
      playHistory: [...Array(4).fill(placeholderTrick), fullTrick, ...Array(8).fill(claimTrick)],
      result: boardDone.result,
      allHands: boardDone.allHands,
    };
  };

  it('shows the claim announcement immediately, holds the board for CLAIM_ANNOUNCE_HOLD_MS, then hands off cleanly', async () => {
    apiMock.board.mockResolvedValue(boardPlaying);
    apiMock.playCard.mockResolvedValue({ board: buildClaimed() });

    // jsdom has no WAAPI, so motionOK() is always false here — the same
    // path a reduced-motion user hits, and the announcement hold applies
    // regardless (see CLAIM_ANNOUNCE_HOLD_MS's doc comment). Fake timers
    // make that fixed, deterministic hold precisely steppable. userEvent's
    // own internal pointer-event machinery doesn't interleave with fake
    // timers reliably, so the two taps use the lower-level fireEvent
    // instead.
    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText('SOUTH · YOU')).toBeInTheDocument());
      const queen = screen.getByRole('button', { name: 'Q of ♠' });
      fireEvent.click(queen);
      fireEvent.click(screen.getByRole('button', { name: 'Q of ♠' }));

      // pops up right as the claim is detected — no delay before the
      // announcement itself appears. Two zero-length advances: React 19
      // resolves the playCard mock's promise chain over two
      // microtask-queue drains, not one.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('N/S CLAIM')).toBeInTheDocument();
      expect(screen.getByText('9 REMAINING TRICKS')).toBeInTheDocument();
      expect(screen.getByText(/Laydown confirmed/)).toBeInTheDocument();

      // ...and stays up — still showing, board hasn't jumped to the result
      // yet, partway through the hold
      await vi.advanceTimersByTimeAsync(CLAIM_ANNOUNCE_HOLD_MS / 2);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByText('SCORED')).not.toBeInTheDocument();

      // ...then clears cleanly on hand-off to the normal completion view
      // once the hold elapses, with no separate terminal stamp
      await vi.advanceTimersByTimeAsync(CLAIM_ANNOUNCE_HOLD_MS);
      await vi.waitFor(() => expect(screen.getByText('SCORED')).toBeInTheDocument());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('TOLLS CLAIMED')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the player tap through the claim announcement before the hold elapses', async () => {
    apiMock.board.mockResolvedValue(boardPlaying);
    apiMock.playCard.mockResolvedValue({ board: buildClaimed() });

    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText('SOUTH · YOU')).toBeInTheDocument());
      const queen = screen.getByRole('button', { name: 'Q of ♠' });
      fireEvent.click(queen);
      fireEvent.click(screen.getByRole('button', { name: 'Q of ♠' }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // tap dismisses well before CLAIM_ANNOUNCE_HOLD_MS would elapse on its own
      fireEvent.click(screen.getByRole('dialog'));
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(screen.getByText('SCORED')).toBeInTheDocument());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // The trick already in progress when the request went out goes to the
  // DEFENSE: West leads ♥Q, dummy follows ♥2, East wins with ♥A and South's
  // ♥9 can't touch it. Only the eight tricks after that are N/S's guaranteed
  // run — so announcing "N/S CLAIM" the instant the response lands would put
  // a claim notice over a trick the player is about to see the other side
  // win. The board has to pay that trick first.
  const HQ = 13 + 10;
  const HA = 13 + 12;
  const H2 = 13 + 0;
  const H9 = 13 + 7;
  const defensePrev: BoardView = {
    ...boardPlaying,
    currentTrick: [
      { seat: 3, card: HQ },
      { seat: 0, card: H2 },
      { seat: 1, card: HA },
    ],
    legalCards: [13 + 11, 13 + 9, H9], // ♥K ♥J ♥9 — South must follow suit
  };

  const buildDefenseClaimed = (): BoardView => {
    const heartTrick: TrickCard[] = [...defensePrev.currentTrick!, { seat: 2, card: H9 }];
    const placeholderTrick: TrickCard[] = [
      { seat: 0, card: 26 },
      { seat: 1, card: 27 },
      { seat: 2, card: 31 },
      { seat: 3, card: 32 },
    ];
    const claimTrick: TrickCard[] = [
      { seat: 0, card: 39 + 12 }, // North: A♣
      { seat: 1, card: 39 + 1 },
      { seat: 2, card: 39 + 2 },
      { seat: 3, card: 39 + 3 },
    ];
    return {
      ...boardPlaying,
      contract: { level: 4, strain: 3, declarer: 2 }, // spades trump, South declares
      state: 'done',
      claimed: true,
      myTurn: false,
      legalCards: undefined,
      currentTrick: [],
      completedTricks: 13,
      declarerTricks: 11,
      defenderTricks: 2,
      lastTrick: claimTrick,
      hand: [],
      dummyHand: [],
      playHistory: [...Array(4).fill(placeholderTrick), heartTrick, ...Array(8).fill(claimTrick)],
      result: boardDone.result,
      allHands: boardDone.allHands,
    };
  };

  it('pays the trick the other side just won before announcing the claim over it', async () => {
    apiMock.board.mockResolvedValue(defensePrev);
    apiMock.playCard.mockResolvedValue({ board: buildDefenseClaimed() });

    // jsdom has no WAAPI, so this is the reduced-motion path: the lead isn't
    // animated card by card, but its settled view still has to be on the
    // board — and readable — before the overlay covers it.
    vi.useFakeTimers();
    try {
      renderBoard();
      await vi.waitFor(() => expect(screen.getByText('SOUTH · YOU')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: '9 of ♥' }));
      fireEvent.click(screen.getByRole('button', { name: '9 of ♥' }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // no announcement yet — instead the trick is paid, to the defense
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.querySelector('.trick-meter-num')!.textContent).toBe('3–2');

      // ...and it holds long enough for the tally to be read
      await vi.advanceTimersByTimeAsync(CLAIM_LEAD_SETTLE_MS / 2);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // only then does the claim go up, counting the eight guaranteed tricks
      // and not the one just lost
      await vi.advanceTimersByTimeAsync(CLAIM_LEAD_SETTLE_MS);
      await vi.waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      expect(screen.getByText('N/S CLAIM')).toBeInTheDocument();
      expect(screen.getByText('8 REMAINING TRICKS')).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(CLAIM_ANNOUNCE_HOLD_MS);
      await vi.waitFor(() => expect(screen.getByText('SCORED')).toBeInTheDocument());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Board — result', () => {
  it('shows the scored hero, field table, deal diagram and bidding recap', async () => {
    apiMock.board.mockResolvedValue(boardDone);
    renderBoard();
    expect(await screen.findByText('SCORED')).toBeInTheDocument();
    expect(document.querySelector('.result-contract')!.textContent).toBe('4♠ by S');
    expect(screen.getByText('+620 for N–S · NS vul')).toBeInTheDocument();
    // pct-big keeps its class; 58% in flip digits
    const pct = document.querySelector('.pct-big')!;
    expect(pct.textContent).toContain('5');
    expect(pct.textContent).toContain('%');
    expect(pct.className).not.toContain('low');
    expect(screen.getByText(/MATCHPOINTS · VS 4 OTHER PLAYERS · BIDDING 89%/)).toBeInTheDocument();

    // field table with self highlighted
    expect(screen.getByText('THE FIELD — BOARD 2')).toBeInTheDocument();
    const table = document.querySelector('.fieldtable')!;
    expect(within(table as HTMLElement).getByText('You').closest('tr')!.className).toContain('me');
    expect(
      within(table as HTMLElement).getByText((_, el) => el?.textContent === '4♠+1 by S · +650'),
    ).toBeInTheDocument();
    // house (benchmark AI) row: a full field member — tagged and muted, but
    // counted in the "VS N OTHER PLAYERS" comparison asserted above
    const houseRow = within(table as HTMLElement).getByText('The Shark').closest('tr')!;
    expect(houseRow.className).toContain('house');
    expect(within(houseRow as HTMLElement).getByText('HOUSE')).toBeInTheDocument();

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

  it('offers the ANALYZE PLAY door for a beta account', async () => {
    apiMock.board.mockResolvedValue(boardDone);
    renderBoard();
    expect(await screen.findByRole('link', { name: /analyze play/i })).toHaveAttribute(
      'href',
      '/t/12/b/2/analyze',
    );
  });

  it('hides the ANALYZE PLAY door for an account without beta features — Analyze is still in beta', async () => {
    apiMock.board.mockResolvedValue(boardDone);
    renderBoard({ ...meFixture, user: { ...meFixture.user!, betaFeatures: false } });
    await screen.findByText('SCORED');
    expect(screen.queryByRole('link', { name: /analyze play/i })).not.toBeInTheDocument();
    // the rest of the receipt's actions are unaffected
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

describe('Board — toll receipt', () => {
  it('prints the receipt when the board completes live, then continues to the field', async () => {
    apiMock.board.mockResolvedValue(boardPlaying);
    apiMock.playCard.mockResolvedValue({ board: boardDone });
    renderBoard();
    const queen = await screen.findByRole('button', { name: 'Q of ♠' });
    await userEvent.click(queen);
    await userEvent.click(screen.getByRole('button', { name: 'Q of ♠' }));

    // the interstitial itemizes the score; the field view waits behind it
    expect(await screen.findByText('THE TOLL — BOARD 2')).toBeInTheDocument();
    expect(screen.getByText('Odd tricks')).toBeInTheDocument();
    expect(screen.getByText('4 × 30')).toBeInTheDocument();
    expect(screen.getByText('Game bonus')).toBeInTheDocument();
    expect(screen.getByText('Toll collected')).toBeInTheDocument();
    expect(screen.getByText('+620')).toBeInTheDocument();
    expect(screen.getByText('10 of 13 tricks to declarer · NS vul')).toBeInTheDocument();
    expect(document.querySelector('.fieldtable')).toBeNull();
    // a made board gets the TOLL PAID postmark cancel
    expect(document.querySelector('.receipt-postmark')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /SEE THE FIELD/ }));
    expect(await screen.findByText('THE FIELD — BOARD 2')).toBeInTheDocument();
    expect(document.querySelector('.receipt')).toBeNull();
  });

  it('revisits skip straight to the field; the receipt reopens on demand', async () => {
    apiMock.board.mockResolvedValue(boardDone);
    renderBoard();
    expect(await screen.findByText('THE FIELD — BOARD 2')).toBeInTheDocument();
    expect(document.querySelector('.receipt')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /VIEW THE TOLL RECEIPT/ }));
    expect(screen.getByText('THE TOLL — BOARD 2')).toBeInTheDocument();
    expect(screen.getByText('Toll collected')).toBeInTheDocument();
  });

  it('itemizes a set contract as Toll refused with the penalty in red', async () => {
    apiMock.board.mockResolvedValue(boardDoneLow);
    renderBoard();
    await userEvent.click(await screen.findByRole('button', { name: /VIEW THE TOLL RECEIPT/ }));
    expect(screen.getByText('Down one')).toBeInTheDocument();
    expect(screen.getByText('100, vulnerable')).toBeInTheDocument();
    expect(screen.getByText('Toll refused')).toBeInTheDocument();
    expect(screen.getAllByText('−100').length).toBe(2); // penalty line + total
  });
});
