import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisView } from '../api';
import { allHands, donePlayed, meFixture } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Analyze from './Analyze';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

/**
 * The Analyze screen — drawn verdicts only (the server computed them; these
 * fixtures hand-shape an AnalysisView over the replayViews test board).
 *
 * jsdom gotchas inherited from board.test.tsx: no WAAPI means motionOK() is
 * false, so the REPLAY path silently never runs — the replay tests stub
 * Element.prototype.animate to turn it on (TrickArea's glides bail on
 * zero-width rects, so nothing actually animates); and staged setViews fire
 * from bare setTimeouts outside act(), so a trailing zero-advance is needed
 * before asserting in either direction.
 */

const flat = donePlayed.playHistory!.flat();
const chargedPly = flat.findIndex((t) => t.seat === 2);
const excusedPly = flat.findIndex((t, i) => t.seat === 2 && i > chargedPly + 4);
const chargedTrick = Math.floor(chargedPly / 4) + 1;
// the engine's pick must still be IN South's hand at the charged ply for the
// pending-decision highlight to have anywhere to land
const playedBefore = new Set(flat.slice(0, chargedPly).map((t) => t.card));
const engineCard = allHands[2].filter((c) => !playedBefore.has(c) && c !== flat[chargedPly].card)[0];

function makeAnalysis(over: Partial<AnalysisView> = {}): AnalysisView {
  const ddTricks = Array.from({ length: 49 }, (_, i) => (i <= chargedPly ? 10 : 9));
  return {
    version: 1,
    boardNo: 2,
    contract: donePlayed.contract!,
    claimedAtPly: 44,
    singleField: false,
    fieldScores: [650, 620, 170, -100, -200],
    myIndex: 1,
    actualPct: 58,
    ddTricks,
    plies: [
      {
        ply: chargedPly,
        trick: chargedTrick,
        seat: 2,
        card: flat[chargedPly].card,
        ddLoss: 1,
        cfTricksDeclarer: 11,
        cfScoreNS: 650,
        cfPct: 83,
        mpCost: 25,
        sampled: { bestCard: engineCard, deficit: 1, excused: false, grade: 1 },
      },
      {
        ply: excusedPly,
        trick: Math.floor(excusedPly / 4) + 1,
        seat: 2,
        card: flat[excusedPly].card,
        ddLoss: 1,
        cfTricksDeclarer: 11,
        cfScoreNS: 650,
        cfPct: 71,
        mpCost: 13,
        sampled: { bestCard: flat[excusedPly].card, deficit: 0, excused: true, grade: 3 },
      },
    ],
    moments: [
      { kind: 'play', ply: chargedPly, trick: chargedTrick, card: flat[chargedPly].card, excused: false, grade: 1, mpCost: 25 },
      { kind: 'play', ply: excusedPly, trick: Math.floor(excusedPly / 4) + 1, card: flat[excusedPly].card, excused: true, grade: 3, mpCost: 13 },
    ],
    setAside: 1,
    par: null,
    ...over,
  };
}

const parPayload = {
  parScore: 620,
  parContracts: ['NS 4♠'],
  calls: [
    {
      callIndex: donePlayed.auction.findIndex((a) => a.isHuman),
      call: donePlayed.auction.find((a) => a.isHuman)!.call,
      bestCall: 3,
      cf: {
        calls: [0, 0, 3],
        contractLabel: '5♣ by S',
        ddTricks: 11,
        scoreNS: 600,
        cfPct: 83,
        mpGain: 25,
      },
    },
  ],
};

const renderAnalyze = (route = '/t/12/b/2/analyze') =>
  renderWithMe(
    <Routes>
      <Route path="/t/:tid/b/:no/analyze" element={<Analyze />} />
    </Routes>,
    { me: meFixture, route },
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('the moments ledger (THE CROSSING)', () => {
  it('requests par for the crossing lens and renders charged + excused rows with the overflow counted', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');
    expect(apiMock.analysis).toHaveBeenCalledWith(12, 2, true);

    const charged = screen.getByRole('button', { name: new RegExp(`Trick ${chargedTrick}, 1 of 3 stars, 25 more matchpoints were there`) });
    expect(charged.querySelector('.stargrade')).not.toBeNull(); // aria-hidden visual — the button's name carries the reading
    // opportunity framing: +N in the positive ink, never a −penalty
    expect(within(charged).getByText('+25 MP')).toBeInTheDocument();

    const excused = screen.getByRole('button', { name: /excused — 13 matchpoints set aside/ });
    expect(within(excused).getByText('EXCUSED')).toBeInTheDocument();
    expect(within(excused).getByText(/invisible from your seat/)).toBeInTheDocument();

    expect(screen.getByText(/One more moment set aside — the 2 above were worth the most\./)).toBeInTheDocument();
  });

  it('an empty ledger is a finding, not an empty state', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ moments: [], setAside: 0, plies: [], par: parPayload }));
    renderAnalyze();
    expect(await screen.findByText(/Nothing turned on a single card\. The field played it much as you did\./)).toBeInTheDocument();
  });

  it('a one-player field refuses costs rather than inventing them', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(
      makeAnalysis({ singleField: true, actualPct: null, moments: [], setAside: 0, par: parPayload }),
    );
    renderAnalyze();
    expect(await screen.findByText(/Only you have played this board\./)).toBeInTheDocument();
    expect(screen.queryByText(/[−+]\d+ MP/)).not.toBeInTheDocument();
  });
});

describe('the overview: bid moments and par', () => {
  it('carries the counterfactual on the bid moment (a finding, not a link) and keeps par with the field line', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    const bidMoment = {
      kind: 'bid' as const,
      callIndex: parPayload.calls[0].callIndex,
      call: parPayload.calls[0].call,
      mpCost: 25,
    };
    apiMock.analysis.mockResolvedValue(
      makeAnalysis({ par: parPayload, moments: [...makeAnalysis().moments, bidMoment], setAside: 0 }),
    );
    // legacy ?lens=auction (the first preview's three-lens shape) maps to the overview
    renderAnalyze('/t/12/b/2/analyze?lens=auction');
    await screen.findByText('WHERE IT TURNED');
    expect(screen.getAllByRole('button', { name: /THE (OVERVIEW|PLAY)/ })).toHaveLength(2);

    // the YOUR BIDDING recap lives on the Result, not here
    expect(screen.queryByText('YOUR BIDDING')).not.toBeInTheDocument();

    // the bid moment is a static finding: no button role, no chevron, and its
    // aside carries the counterfactual with the re-run caveat
    const bidRow = document.querySelector('.moment-row-static')!;
    expect(bidRow).not.toBeNull();
    expect(bidRow.tagName).toBe('DIV');
    expect(bidRow.querySelector('.moment-chev')).toBeNull();
    expect(bidRow.textContent).toMatch(/reaches 5♣ by S — \+600, and 83% instead of 58%/);
    expect(bidRow.textContent).toMatch(/re-run, not remembered/);

    expect(screen.getByText('THE CARDS WERE WORTH')).toBeInTheDocument();
    expect(screen.getByText(/Par is played with all four hands face up\. Nobody bids that way\./)).toBeInTheDocument();
    expect(screen.getByText(/The field here:/)).toBeInTheDocument();
  });
});

describe('the play lens', () => {
  it('renders the static trick list under reduced motion (jsdom default), with the claim tail quiet', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis());
    renderAnalyze('/t/12/b/2/analyze?lens=play');
    await screen.findByText(/TRICK BY TRICK/);
    // the play lens never requests par
    expect(apiMock.analysis).toHaveBeenCalledWith(12, 2, false);
    // the charged trick expands in place with its verdict
    expect(screen.getByText('EXCUSED')).toBeInTheDocument();
    expect(screen.getByText('+25 MP')).toBeInTheDocument();
    expect(screen.getByText(/Settled from here — the rest was already yours\./)).toBeInTheDocument();
  });

  it('tapping a ledger row opens the play lens at that trick', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');
    await userEvent.click(screen.getByRole('button', { name: /25 more matchpoints were there/ }));
    expect(await screen.findByText(/TRICK BY TRICK/)).toBeInTheDocument();
  });

  it('a moment jump lands ON the decision, highlights the engine card, and NEXT MOMENT hops onward', async () => {
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      apiMock.board.mockResolvedValue(donePlayed);
      apiMock.analysis.mockResolvedValue(makeAnalysis());
      renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${chargedPly}`);
      await screen.findByText(/THE AUDIT — TRICK/);

      // the decision is pending: the ribbon reads the turn, the gain wears
      // the + sign, and the engine's card carries the live pre-confirmation
      // .selected treatment in the fan
      const ribbon = document.querySelector('.audit-ribbon')!;
      expect(ribbon.textContent).toMatch(/The turn is here/);
      expect(ribbon.textContent).toMatch(/\+25 MP/);
      expect(document.querySelector(`.cardbtn.selected[data-card="${engineCard}"]`)).not.toBeNull();

      // at the first moment there is nothing earlier to hop back to
      expect(screen.getByRole('button', { name: /PREV MOMENT/ })).toBeDisabled();

      // NEXT MOMENT cuts to the following graded decision (the excused one)
      await userEvent.click(screen.getByRole('button', { name: /NEXT MOMENT/ }));
      expect(document.querySelector('.audit-ribbon')!.textContent).toMatch(/nothing to find/);
      expect(screen.getByRole('button', { name: /NEXT MOMENT/ })).toBeDisabled();

      // and PREV MOMENT hops back to the charged decision
      await userEvent.click(screen.getByRole('button', { name: /PREV MOMENT/ }));
      expect(document.querySelector('.audit-ribbon')!.textContent).toMatch(/The turn is here/);
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('with motion on, NEXT CARD stages one card and BACK A CARD cuts', async () => {
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      apiMock.board.mockResolvedValue(donePlayed);
      apiMock.analysis.mockResolvedValue(makeAnalysis());
      renderAnalyze('/t/12/b/2/analyze?lens=play&trick=2');
      await screen.findByText(/THE AUDIT — TRICK/);

      // deep-linked to trick 2: four cards already down, pip 2 current
      expect(screen.getByRole('button', { name: 'Trick 2' })).toHaveAttribute('aria-current', 'step');

      vi.useFakeTimers();
      const next = screen.getByRole('button', { name: /NEXT CARD/ });
      await act(async () => {
        next.click();
      });
      // the staged step lands on a timer, outside act — advance, then a
      // trailing zero-advance so React commits the setView
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const ribbon = document.querySelector('.audit-ribbon')!;
      expect(ribbon.textContent).toMatch(/played/);

      const back = screen.getByRole('button', { name: /BACK A CARD/ });
      await act(async () => {
        back.click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // a cut lands immediately — the ribbon reads the trick-2 position again
      expect(document.querySelector('.replay-dock')).toBeInTheDocument();
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });
});
