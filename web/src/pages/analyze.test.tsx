import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisView } from '../api';
import { donePlayed, meFixture } from '../test/fixtures';
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
        sampled: { bestCard: flat[chargedPly + 4].card, deficit: 1, excused: false, grade: 1 },
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

    const charged = screen.getByRole('button', { name: new RegExp(`Trick ${chargedTrick}, 1 of 3 stars, cost 25 matchpoints`) });
    expect(charged.querySelector('.stargrade')).not.toBeNull(); // aria-hidden visual — the button's name carries the reading
    expect(within(charged).getByText('−25 MP')).toBeInTheDocument();

    const excused = screen.getByRole('button', { name: /excused, cost 13 matchpoints/ });
    expect(within(excused).getByText('EXCUSED')).toBeInTheDocument();
    expect(within(excused).getByText(/invisible from your seat/)).toBeInTheDocument();

    expect(screen.getByText(/One more moment set aside — the 2 above cost the most\./)).toBeInTheDocument();
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
    expect(screen.queryByText(/−\d+ MP/)).not.toBeInTheDocument();
  });
});

describe('the auction lens', () => {
  it('deepens YOUR BIDDING with the counterfactual line and keeps par with the field line', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    renderAnalyze('/t/12/b/2/analyze?lens=auction');
    await screen.findByText('YOUR BIDDING');
    const cf = document.querySelector('.analyze-cf')!;
    expect(cf.textContent).toMatch(/would have reached 5♣ by S — \+600, and 83% instead of 58%/);
    expect(cf.textContent).toMatch(/re-run, not remembered/);
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
    expect(screen.getByText('−25 MP')).toBeInTheDocument();
    expect(screen.getByText(/Settled from here — the rest was already yours\./)).toBeInTheDocument();
  });

  it('tapping a ledger row opens the play lens at that trick', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');
    await userEvent.click(screen.getByRole('button', { name: /cost 25 matchpoints/ }));
    expect(await screen.findByText(/TRICK BY TRICK/)).toBeInTheDocument();
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
