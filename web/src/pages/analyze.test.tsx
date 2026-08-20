import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RANK_CHARS, SUIT_SYMBOLS, cardRank, cardSuit, type AnalysisView, type Me } from '../api';
import { firstPlyOfTrick } from '../replay/replayViews';
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
const chargedTrick = Math.floor(chargedPly / 4) + 1;
// the engine's pick must still be IN South's hand at the charged ply for the
// pending-decision highlight to have anywhere to land
const playedBefore = new Set(flat.slice(0, chargedPly).map((t) => t.card));
const engineCard = allHands[2].filter((c) => !playedBefore.has(c) && c !== flat[chargedPly].card)[0];

/**
 * Fixtures here only ever shape a CHARGED verdict — the server never emits
 * an excused one (server/src/analyze.ts's stage-3 loop drops those before
 * the response is built), so a fixture that manufactured one would be
 * testing a shape the client can no longer receive.
 */
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
        sampled: { bestCard: engineCard, deficit: 1, grade: 1 },
      },
    ],
    moments: [{ kind: 'play', ply: chargedPly, trick: chargedTrick, card: flat[chargedPly].card, grade: 1, mpCost: 25 }],
    setAside: 0,
    par: null,
    momentFloor: 10,
    ...over,
  };
}

const parPayload = {
  parScore: 620,
  // DealerPar contract strings exactly as DDS emits them: a SIDE form and a
  // single-SEAT form (both occur — "3D*-EW-1", "3N-W+2", "6N-N")
  parContracts: ['4S-NS', '3N-W+2'],
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

const renderAnalyze = (route = '/t/12/b/2/analyze', me: Me = meFixture) =>
  renderWithMe(
    <Routes>
      <Route path="/t/:tid/b/:no/analyze" element={<Analyze />} />
    </Routes>,
    { me, route },
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('the moments ledger (THE CROSSING)', () => {
  it('requests par for the crossing lens and renders the charged row, with the overflow counted', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload, setAside: 1 }));
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');
    expect(apiMock.analysis).toHaveBeenCalledWith(12, 2, true);

    const charged = screen.getByRole('button', { name: new RegExp(`Trick ${chargedTrick}, 1 of 3 stars, 25 more matchpoints were there`) });
    expect(charged.querySelector('.stargrade')).not.toBeNull(); // aria-hidden visual — the button's name carries the reading
    // opportunity framing: +N in the positive ink, never a −penalty
    expect(within(charged).getByText('+25 MP')).toBeInTheDocument();
    // an excused verdict never reaches the client at all — the server drops
    // it before the response is built, so there is nothing "EXCUSED" to render
    expect(screen.queryByText('EXCUSED')).not.toBeInTheDocument();

    expect(screen.getByText(/One more moment set aside — the 1 above were worth the most\./)).toBeInTheDocument();
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
    // the receipts refuse the percentage the same way
    expect(screen.getByText(/the only table so far/)).toBeInTheDocument();
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
    // the receipt and the rail: the panel LEADS the overview, par arrives as
    // a sealed receipt in the app's own contract vocabulary (parsed from the
    // DDS "4S-NS" string), your table beside it, and the field on the rail
    const worth = document.querySelector('.analyze-par')!;
    const ledger = document.querySelector('.analyze-moments')!;
    expect(worth.compareDocumentPosition(ledger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const parStub = document.querySelector('.worth-stub.sealed')!;
    expect(parStub.textContent).toContain('OMNISCIENCE FOUND');
    expect(parStub.textContent).toContain('4♠ by N–S =');
    expect(parStub.textContent).toContain('3NT by W +2');
    expect(parStub.textContent).toContain('+620');
    const youStub = document.querySelectorAll('.worth-stub')[1]!;
    expect(youStub.textContent).toContain('YOUR TABLE');
    expect(youStub.textContent).toContain('58%');
    // the rail: one dot per distinct score (fixture field has five), the
    // dashed gate labelled PAR, and the viewer's dot flagged YOU
    expect(document.querySelectorAll('.worth-dot')).toHaveLength(5);
    expect(document.querySelector('.worth-gatelab')!.textContent).toBe('PAR');
    const youLab = [...document.querySelectorAll('.worth-dotlab')].find((el) => el.textContent!.includes('YOU'))!;
    expect(youLab.textContent).toContain('+620');
    // donePlayed's table (+620) ties parPayload's par (620) — not a beat, so
    // the finding stays the "nobody bids face up" framing, not the beat-par one
    expect(screen.getByText(/par is the yardstick for this board/)).toBeInTheDocument();
  });

  it('a table that outscores par gets the beat-par finding, not the missed-it one', async () => {
    apiMock.board.mockResolvedValue(donePlayed); // your table: +620
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: { ...parPayload, parScore: 100 } }));
    renderAnalyze();
    await screen.findByText('THE CARDS WERE WORTH');
    // "bidding" is a linked glossary term, splitting the sentence across
    // elements — read the finding paragraph's full textContent, same as the
    // bid-moment aside above does for the same reason
    const finding = document.querySelector('.analyze-finding')!;
    expect(finding.textContent).toMatch(/did better than perfect bidding allows for either side/);
    expect(finding.textContent).not.toMatch(/not a target anyone missed/);
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
    // the charged trick expands in place with its verdict; no excused row —
    // the server never sends one
    expect(screen.getByText('+25 MP')).toBeInTheDocument();
    expect(screen.queryByText('EXCUSED')).not.toBeInTheDocument();
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

  it('a moment jump collapses to one step — the played card lands in the trick with the engine card highlighted — and the pager hops between moments', async () => {
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    const playedCard = flat[chargedPly].card;
    // a .pcard's textContent is its rank glyph followed by its suit symbol
    const cardText = (c: number) => `${RANK_CHARS[cardRank(c)]}${SUIT_SYMBOLS[cardSuit(c)]}`;
    // a second, later charged moment so the pager has somewhere to hop to —
    // the server never emits an excused one for it to land on instead
    const secondPly = flat.findIndex((t, i) => t.seat === 2 && i > chargedPly + 4);
    const secondTrick = Math.floor(secondPly / 4) + 1;
    const secondEngineCard = allHands[2].filter(
      (c) => !flat.slice(0, secondPly).some((t) => t.card === c) && c !== flat[secondPly].card,
    )[0];
    try {
      apiMock.board.mockResolvedValue(donePlayed);
      const analysis = makeAnalysis();
      analysis.plies.push({
        ply: secondPly,
        trick: secondTrick,
        seat: 2,
        card: flat[secondPly].card,
        ddLoss: 1,
        cfTricksDeclarer: 11,
        cfScoreNS: 650,
        cfPct: 71,
        mpCost: 13,
        sampled: { bestCard: secondEngineCard, deficit: 1, grade: 0 },
      });
      analysis.moments.push({ kind: 'play', ply: secondPly, trick: secondTrick, card: flat[secondPly].card, grade: 0, mpCost: 13 });
      apiMock.analysis.mockResolvedValue(analysis);
      renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${chargedPly}`);
      await screen.findByText(/THE AUDIT — TRICK/);

      // the landing is ONE step: the played card glides into the trick while
      // the engine's pick keeps the live pre-confirmation .selected treatment
      // in the fan — both on screen at once, no NEXT press between them
      await waitFor(
        () => expect(document.querySelector('.audit-ribbon')!.textContent).toMatch(/the moment turned here/),
        { timeout: 4000 },
      );
      const trickCards = () => [...document.querySelectorAll('.trick .pcard')].map((el) => el.textContent);
      expect(trickCards()).toContain(cardText(playedCard));
      expect(document.querySelector(`.cardbtn.selected[data-card="${engineCard}"]`)).not.toBeNull();
      expect(document.querySelector('.audit-ribbon')!.textContent).toMatch(/\+25 MP/);
      // the pct pair the retired pending caption used to carry rides on this
      // beat now — it is the only one the moment gets
      expect(document.querySelector('.audit-ribbon')!.textContent).toMatch(/worth 83% instead of 58%/);
      // and "double dummy" links nowhere: the ribbon's skip policy keeps the
      // matcher off `dummy`, which here would open the wrong sense entirely
      // (declarer's exposed partner, not the perfect-information yardstick)
      expect(document.querySelector('.audit-ribbon')!.textContent).toMatch(/double dummy/);
      expect([...document.querySelectorAll('.audit-ribbon .gloss-link')].map((el) => el.textContent)).not.toContain('dummy');

      // at the first moment there is nothing earlier to hop back to — even
      // though the replay position sits one card PAST the decision
      expect(screen.getByRole('button', { name: /PREV MOMENT/ })).toBeDisabled();

      // BACK A CARD steps to the position before the decision, and that
      // position says NOTHING about it: no second telling of the finding, and
      // no engine card lit a beat before the card it is being compared with
      await userEvent.click(screen.getByRole('button', { name: /BACK A CARD/ }));
      expect(document.querySelector('.audit-ribbon')!.textContent).not.toMatch(/the moment turned here/);
      expect(document.querySelector('.audit-ribbon')!.textContent).not.toMatch(/the engine, from your seat/i);
      expect(document.querySelector(`.cardbtn.selected[data-card="${engineCard}"]`)).toBeNull();
      expect(trickCards()).not.toContain(cardText(playedCard));

      // NEXT MOMENT lands the second graded decision, collapsed the same way
      await userEvent.click(screen.getByRole('button', { name: /NEXT MOMENT/ }));
      await waitFor(
        () => expect(document.querySelector('.audit-ribbon')!.textContent).toMatch(/the moment turned here/),
        { timeout: 4000 },
      );
      expect(trickCards()).toContain(cardText(flat[secondPly].card));
      expect(screen.getByRole('button', { name: /NEXT MOMENT/ })).toBeDisabled();

      // and PREV MOMENT hops back to the first charged moment, collapsed again
      await userEvent.click(screen.getByRole('button', { name: /PREV MOMENT/ }));
      await waitFor(
        () => expect(document.querySelector('.audit-ribbon')!.textContent).toMatch(/the moment turned here/),
        { timeout: 4000 },
      );
      expect(trickCards()).toContain(cardText(playedCard));
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('a double-dummy slip under the floor is not a moment: unjudged ribbon, no charge, and the pager skips it', async () => {
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      // a stage-1 candidate the floor filtered out: ddLoss recorded, mpCost
      // ~0, and NO sampled verdict — exactly what the server emits for a
      // trick that moved no matchpoints (stage 3 never ran)
      const subPly = chargedPly + 2;
      const analysis = makeAnalysis();
      analysis.plies.splice(1, 0, {
        ply: subPly,
        trick: Math.floor(subPly / 4) + 1,
        seat: flat[subPly].seat,
        card: flat[subPly].card,
        ddLoss: 1,
        cfTricksDeclarer: 10,
        cfScoreNS: 620,
        cfPct: 58,
        mpCost: 0,
        sampled: null,
      });
      apiMock.board.mockResolvedValue(donePlayed);
      apiMock.analysis.mockResolvedValue(analysis);
      renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${subPly + 1}`);
      await screen.findByText(/THE AUDIT — TRICK/);

      // the ribbon reads the slip honestly — no "moment", no gain stamp, no
      // engine card (nothing was judged, so there is nothing to point at)
      const ribbon = document.querySelector('.audit-ribbon')!;
      expect(ribbon.textContent).toMatch(/a double-dummy trick slipped here/);
      expect(ribbon.textContent).toMatch(/the field scores this board the same either way/);
      expect(ribbon.textContent).not.toMatch(/moment turned/);
      expect(document.querySelector('.audit-ribbon-gain')).toBeNull();
      expect(document.querySelector('.cardbtn.selected')).toBeNull();

      // the pager skips the unjudged slip entirely: the earlier charged
      // moment is reachable, but there is no later one to hop to
      expect(screen.getByRole('button', { name: /PREV MOMENT/ })).toBeEnabled();
      expect(screen.getByRole('button', { name: /NEXT MOMENT/ })).toBeDisabled();
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('a pass-out par prints Passed out on the sealed receipt, never the raw DDS token', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(
      makeAnalysis({ par: { ...parPayload, parScore: 0, parContracts: ['pass'] } }),
    );
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');
    const parStub = document.querySelector('.worth-stub.sealed')!;
    expect(parStub.textContent).toContain('Passed out');
    expect(parStub.textContent).toContain('+0');
    expect(parStub.textContent).not.toMatch(/^pass$/m);
  });

  // "Trump placement" reaches the review as well as the live board: a reader
  // should see the board laid out the way they played it. Statically — this
  // lens is scrubbed, so there is no ♠♥♦♣ frame for a Draw to move from.
  // donePlayed is 4♠, the no-op case, so the contract is re-strained to
  // hearts here; nothing in this test reads a trick winner, which is the only
  // other thing strain decides.
  describe('trump placement', () => {
    const heartsBoard = { ...donePlayed, contract: { ...donePlayed.contract!, strain: 2 } };
    // meFixture is already trump-left — the account default — so the override
    // is the OTHER end: a reader who has opted back into ♠♥♦♣.
    const meSuit: Me = { ...meFixture, user: { ...meFixture.user!, trumpPlacement: 'suit' } };
    /** the suits of a fan, left to right */
    const fanSuits = (fan: Element) =>
      [...fan.querySelectorAll<HTMLElement>('.cardbtn')].map((el) => Math.floor(Number(el.dataset.card) / 13));
    /** the suit glyph each rail line leads with, top to bottom */
    const railSuits = (rail: Element) =>
      [...rail.querySelectorAll('.analyze-suitgroup')].map((g) => g.firstElementChild?.textContent);

    const openPlayLens = async (me: Me) => {
      const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
      (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
      apiMock.board.mockResolvedValue(heartsBoard);
      apiMock.analysis.mockResolvedValue(makeAnalysis({ contract: heartsBoard.contract }));
      renderAnalyze('/t/12/b/2/analyze?lens=play', me);
      await screen.findByText(/THE AUDIT — TRICK/);
    };

    afterEach(() => {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    });

    it('lays the fans and the suit-line rails out trump-first by default', async () => {
      await openPlayLens(meFixture);
      // every fan on the lens — the player's own and the hand across — leads
      // with hearts, and every card is still there
      const fans = [...document.querySelectorAll('.board-fan')];
      expect(fans.length).toBeGreaterThan(0);
      for (const fan of fans) {
        const suits = fanSuits(fan);
        expect(suits.length).toBeGreaterThan(0);
        // trumps in ONE block at the front, the others ascending behind it
        const trumps = suits.filter((x) => x === 1).length;
        expect(trumps).toBeGreaterThan(0);
        expect(suits.slice(0, trumps)).toEqual(Array(trumps).fill(1));
        const rest = suits.slice(trumps);
        expect(rest).toEqual([...rest].sort((a, b) => a - b));
        expect(rest).not.toContain(1);
      }
      // and the W/E rails agree with them — a hand that reads trump-left in
      // the fan and ♠♥♦♣ in the rail beside it is worse than either alone
      for (const rail of document.querySelectorAll('.analyze-rail.side')) {
        const suits = railSuits(rail);
        if (suits.length > 1) expect(suits[0]).toBe('♥');
      }
    });

    it('leaves them in ♠♥♦♣ for a reader who asked for suit order', async () => {
      await openPlayLens(meSuit);
      for (const fan of document.querySelectorAll('.board-fan')) {
        const suits = fanSuits(fan);
        expect(suits).toEqual([...suits].sort((a, b) => a - b));
      }
      for (const rail of document.querySelectorAll('.analyze-rail.side')) {
        const suits = railSuits(rail);
        if (suits.length > 1) expect(suits[0]).not.toBe('♥');
      }
    });
  });

  it('a board claimed before the first card opens on the settled reading, not an invitation to hunt moments', async () => {
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      apiMock.board.mockResolvedValue(donePlayed);
      apiMock.analysis.mockResolvedValue(makeAnalysis({ claimedAtPly: 0, plies: [], moments: [], setAside: 0 }));
      renderAnalyze('/t/12/b/2/analyze?lens=play');
      await screen.findByText(/THE AUDIT — TRICK/);
      const ribbon = document.querySelector('.audit-ribbon')!;
      expect(ribbon.textContent).toMatch(/Settled before the first card/);
      expect(ribbon.textContent).not.toMatch(/Step through the play/);
      expect(screen.getByRole('button', { name: /NEXT MOMENT/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /PREV MOMENT/ })).toBeDisabled();
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it("a drifted unjudged ply — refreshed cost over the floor — is captioned as the field shifting, not as sub-floor", async () => {
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      // stage 3 skipped this ply at first open (field then made it worth ~0);
      // the serve-time refresh now measures it at 15 MP — over the floor,
      // but there is no verdict to show and nothing gets charged
      const subPly = chargedPly + 2;
      const analysis = makeAnalysis();
      analysis.plies.splice(1, 0, {
        ply: subPly,
        trick: Math.floor(subPly / 4) + 1,
        seat: flat[subPly].seat,
        card: flat[subPly].card,
        ddLoss: 1,
        cfTricksDeclarer: 10,
        cfScoreNS: 620,
        cfPct: 73,
        mpCost: 15,
        sampled: null,
      });
      apiMock.board.mockResolvedValue(donePlayed);
      apiMock.analysis.mockResolvedValue(analysis);
      renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${subPly + 1}`);
      await screen.findByText(/THE AUDIT — TRICK/);
      const ribbon = document.querySelector('.audit-ribbon')!;
      expect(ribbon.textContent).toMatch(/15 matchpoints now ride on it — the field has shifted/);
      expect(ribbon.textContent).not.toMatch(/under the audit's floor/);
      expect(document.querySelector('.audit-ribbon-gain')).toBeNull();
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('the centre rail is the seat across the fan: dummy North on a South-declared board', async () => {
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      // donePlayed is 4♠ by S — dummy NORTH — the case that used to drop the
      // dummy's thirteen cards from the replay entirely
      apiMock.board.mockResolvedValue(donePlayed);
      apiMock.analysis.mockResolvedValue(makeAnalysis());
      renderAnalyze('/t/12/b/2/analyze?lens=play');
      await screen.findByText(/THE AUDIT — TRICK/);
      expect(document.querySelector('.analyze-rail.north')!.getAttribute('aria-label')).toBe('NORTH · DUMMY');
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('a flipped board fans North and rails dummy South — no hand twice, no hand missing', async () => {
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      apiMock.board.mockResolvedValue({
        ...donePlayed,
        flipped: true,
        playingSeat: 0,
        dummy: 2,
        contract: { ...donePlayed.contract!, declarer: 0 },
      });
      apiMock.analysis.mockResolvedValue(makeAnalysis());
      renderAnalyze('/t/12/b/2/analyze?lens=play');
      await screen.findByText(/THE AUDIT — TRICK/);
      expect(document.querySelector('.analyze-rail.north')!.getAttribute('aria-label')).toBe('SOUTH · DUMMY');
      // the fan holds the hand the human PLAYED — North's
      expect(document.querySelector(`.board-fan [data-card="${allHands[0][0]}"]`)).not.toBeNull();
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it("a moment on a trick's last card lands with the trick HELD on the table, not swept away", async () => {
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      // ply 3 completes trick 1 — inject a judged verdict exactly there
      const seat3 = flat[3].seat;
      const engine3 = allHands[seat3].filter((c) => !flat.slice(0, 3).some((t) => t.card === c) && c !== flat[3].card)[0];
      const analysis = makeAnalysis();
      analysis.plies = [
        {
          ply: 3,
          trick: 1,
          seat: seat3,
          card: flat[3].card,
          ddLoss: 1,
          cfTricksDeclarer: 11,
          cfScoreNS: 650,
          cfPct: 83,
          mpCost: 25,
          sampled: { bestCard: engine3, deficit: 1, grade: 1 },
        },
      ];
      analysis.moments = [{ kind: 'play', ply: 3, trick: 1, card: flat[3].card, grade: 1, mpCost: 25 }];
      apiMock.board.mockResolvedValue(donePlayed);
      apiMock.analysis.mockResolvedValue(analysis);
      renderAnalyze('/t/12/b/2/analyze?lens=play&ply=3');
      await screen.findByText(/THE AUDIT — TRICK/);
      await waitFor(
        () => expect(document.querySelector('.audit-ribbon')!.textContent).toMatch(/the moment turned here/),
        { timeout: 4000 },
      );
      // all four cards stay on the table — the collect is skipped, so the
      // moment can actually be looked at — and the ribbon names THIS trick
      expect(document.querySelectorAll('.trick .pcard')).toHaveLength(4);
      expect(document.querySelector('.audit-ribbon-who')!.textContent).toMatch(/TRICK 1 OF/);
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

describe('the play lens: trick pips (the compass fill)', () => {
  const WEDGE_KEYS = ['--pip-n', '--pip-e', '--pip-s', '--pip-w'] as const;

  // jsdom ships no WAAPI, so motionOK() is false and this lens would
  // otherwise silently render StaticPlayList instead of the replay dock the
  // pips live in — same gotcha this file's own header comment flags.
  beforeEach(() => {
    (Element.prototype as unknown as { animate: unknown }).animate = vi.fn(() => ({
      onfinish: null,
      cancel: vi.fn(),
      finish: vi.fn(),
    }));
  });
  afterEach(() => {
    delete (Element.prototype as unknown as { animate?: unknown }).animate;
  });

  function wedgeColors(pipName: string) {
    const pip = screen.getByRole('button', { name: pipName });
    return WEDGE_KEYS.map((k) => pip.style.getPropertyValue(k));
  }

  it('a plain done trick fills all four wedges ink', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis());
    // trick 2 carries no moment (the fixture's only one is on trick 1) —
    // land on trick 3's lead so trick 2 is fully revealed
    renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${firstPlyOfTrick(3)}`);
    await screen.findByText(/THE AUDIT — TRICK/);
    expect(wedgeColors('Trick 2')).toEqual(['var(--ink)', 'var(--ink)', 'var(--ink)', 'var(--ink)']);
  });

  it('a trick with one moment lights only that seat’s wedge, not the whole pip', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis());
    // land on the charged trick's own follow-up lead so it's fully revealed
    renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${firstPlyOfTrick(chargedTrick + 1)}`);
    await screen.findByText(/THE AUDIT — TRICK/);
    const colors = wedgeColors(`Trick ${chargedTrick}`);
    expect(colors[2]).toBe('var(--positive)'); // the charge is South's card
    expect([colors[0], colors[1], colors[3]]).toEqual(['var(--ink)', 'var(--ink)', 'var(--ink)']);
  });

  it('a moment wedge is lit from the very first render, before its trick is reached', async () => {
    // the board is already finished — moments are known up front, the same
    // way the Overview lens's ledger lists all of them without scrubbing —
    // so a moment shouldn't wait on reveal state the way an ordinary card
    // does. chargedTrick is trick 1 for this fixture (South plays fourth),
    // so landing at the default position (nothing revealed yet) still
    // shows the charge, while the trick's other three wedges — not yet
    // revealed — stay empty.
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis());
    renderAnalyze('/t/12/b/2/analyze?lens=play');
    await screen.findByText(/THE AUDIT — TRICK/);
    const colors = wedgeColors(`Trick ${chargedTrick}`);
    expect(colors[2]).toBe('var(--positive)'); // South's charge, lit already
    expect([colors[0], colors[1], colors[3]]).toEqual(['var(--panel)', 'var(--panel)', 'var(--panel)']);
  });

  it('a trick graded on both hands (N-S declaring) lights two wedges, not one', async () => {
    // when N-S declares, the human is graded on declarer's AND dummy's
    // plays, so a single trick can carry two independently-charged moments
    // — the wedge treatment is per seat, not per pip, exactly for this case.
    // South declares donePlayed's contract, so the dummy (North, seat 0) is
    // the only OTHER seat humanControls ever grades — a defender's card
    // (e.g. West's) is never charged, so the fixture must target the dummy
    // specifically rather than "any other seat in the trick".
    apiMock.board.mockResolvedValue(donePlayed);
    const dummySeat = donePlayed.dummy!;
    const dummyPly = flat.findIndex((c, i) => Math.floor(i / 4) + 1 === chargedTrick && c.seat === dummySeat);
    const dummyBestCard = allHands[dummySeat].filter((c) => c !== flat[dummyPly].card)[0];
    const base = makeAnalysis();
    const secondPly = {
      ply: dummyPly,
      trick: chargedTrick,
      seat: dummySeat,
      card: flat[dummyPly].card,
      ddLoss: 1,
      cfTricksDeclarer: 11,
      cfScoreNS: 650,
      cfPct: 83,
      mpCost: 25,
      sampled: { bestCard: dummyBestCard, deficit: 1, grade: 1 as const },
    };
    const secondMoment = {
      kind: 'play' as const,
      ply: dummyPly,
      trick: chargedTrick,
      card: flat[dummyPly].card,
      grade: 1 as const,
      mpCost: 25,
    };
    apiMock.analysis.mockResolvedValue(
      makeAnalysis({ plies: [...base.plies, secondPly], moments: [...base.moments, secondMoment] }),
    );
    renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${firstPlyOfTrick(chargedTrick + 1)}`);
    await screen.findByText(/THE AUDIT — TRICK/);
    const colors = wedgeColors(`Trick ${chargedTrick}`);
    expect(colors[2]).toBe('var(--positive)'); // South, the original charge
    expect(colors[dummySeat]).toBe('var(--positive)'); // the second graded seat (dummy)
  });

  it('a not-yet-reached trick stays fully empty', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis());
    renderAnalyze('/t/12/b/2/analyze?lens=play');
    await screen.findByText(/THE AUDIT — TRICK/);
    const lastTrick = Math.ceil(flat.length / 4);
    expect(wedgeColors(`Trick ${lastTrick}`)).toEqual([
      'var(--panel)',
      'var(--panel)',
      'var(--panel)',
      'var(--panel)',
    ]);
  });

  it('the trick being viewed mid-play shows a genuine partial read, not a forced-solid one', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis());
    // trick 2 (plies 4-7) is moment-free — land two cards into it
    const midPly = firstPlyOfTrick(2) + 2;
    renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${midPly}`);
    await screen.findByText(/THE AUDIT — TRICK/);
    const trick2 = flat.slice(firstPlyOfTrick(2), firstPlyOfTrick(2) + 4);
    const expected = ['var(--panel)', 'var(--panel)', 'var(--panel)', 'var(--panel)'];
    trick2.forEach((c, i) => {
      expected[c.seat] = i < 2 ? 'var(--ink)' : 'var(--panel)';
    });
    expect(wedgeColors('Trick 2')).toEqual(expected);
    // the outline still marks it as the trick on screen, independent of fill
    expect(screen.getByRole('button', { name: 'Trick 2' })).toHaveAttribute('aria-current', 'step');
  });
});

describe('Play From Here', () => {
  it('a play moment carries a PLAY FROM HERE action beside WATCH IT; a bid moment carries neither', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    const bidMoment = { kind: 'bid' as const, callIndex: parPayload.calls[0].callIndex, call: parPayload.calls[0].call, mpCost: 25 };
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload, moments: [...makeAnalysis().moments, bidMoment] }));
    apiMock.rehearsals.mockResolvedValue({ rehearsals: [] });
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');

    expect(screen.getByRole('button', { name: /PLAY FROM HERE/ })).toBeInTheDocument();
    // the bid moment's static row carries no rehearse action — the auction never branches
    const bidRow = document.querySelector('.moment-row-static')!;
    expect(within(bidRow as HTMLElement).queryByText(/PLAY FROM HERE/)).not.toBeInTheDocument();
  });

  it('clicking PLAY FROM HERE on a moment row launches a rehearsal at that exact ply and navigates into it', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    apiMock.rehearsals.mockResolvedValue({ rehearsals: [] });
    apiMock.rehearse.mockResolvedValue({ tournamentId: 99, boardNo: 2 });
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');

    await userEvent.click(screen.getByRole('button', { name: /PLAY FROM HERE/ }));
    expect(apiMock.rehearse).toHaveBeenCalledWith(12, 2, chargedPly);
  });

  it('the play lens carries a standing PLAY FROM HERE action, usable at whatever ply is on screen', async () => {
    // jsdom has no WAAPI, so motionOK() is false by default and this lens
    // silently renders the reduced-motion static list instead — stub
    // Element.prototype.animate to reach the real replay dock (same pattern
    // "the play lens" describe block above uses).
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      apiMock.board.mockResolvedValue(donePlayed);
      apiMock.analysis.mockResolvedValue(makeAnalysis());
      apiMock.rehearsals.mockResolvedValue({ rehearsals: [] });
      apiMock.rehearse.mockResolvedValue({ tournamentId: 99, boardNo: 2 });
      const midPly = firstPlyOfTrick(2) + 1;
      renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${midPly}`);
      await screen.findByText(/THE AUDIT — TRICK/);

      await userEvent.click(screen.getByRole('button', { name: /PLAY FROM HERE/ }));
      expect(apiMock.rehearse).toHaveBeenCalledWith(12, 2, midPly);
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('disables the standing action once scrubbed to the very end (nothing left to redecide)', async () => {
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      apiMock.board.mockResolvedValue(donePlayed);
      apiMock.analysis.mockResolvedValue(makeAnalysis());
      apiMock.rehearsals.mockResolvedValue({ rehearsals: [] });
      renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${flat.length}`);
      await screen.findByText(/THE AUDIT — TRICK/);
      expect(screen.getByRole('button', { name: /PLAY FROM HERE/ })).toBeDisabled();
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('landing on a moment (via a moment jump) branches from the flagged decision itself, not one card later', async () => {
    // landAt's collapsed landing deliberately leaves `ply` one card PAST a
    // moment's decision (the played card is already animated into the
    // trick) — the true decision lives in `curMoment`. The standing dock
    // button has to branch from that anchor, not raw `ply`, or it would
    // silently lock in exactly the card the moment flagged.
    const animateStub = vi.fn(() => ({ onfinish: null, cancel: vi.fn(), finish: vi.fn() }));
    (Element.prototype as unknown as { animate: unknown }).animate = animateStub;
    try {
      apiMock.board.mockResolvedValue(donePlayed);
      apiMock.analysis.mockResolvedValue(makeAnalysis());
      apiMock.rehearsals.mockResolvedValue({ rehearsals: [] });
      apiMock.rehearse.mockResolvedValue({ tournamentId: 99, boardNo: 2 });
      // ?ply=<a moment's ply> triggers the same collapsed landAt path a
      // moment-row WATCH IT / NEXT MOMENT click does (see "a moment jump
      // collapses to one step" above).
      renderAnalyze(`/t/12/b/2/analyze?lens=play&ply=${chargedPly}`);
      await screen.findByText(/THE AUDIT — TRICK/);
      await waitFor(() => expect(document.querySelector('.audit-ribbon')!.textContent).toMatch(/the moment turned here/));

      await userEvent.click(screen.getByRole('button', { name: /PLAY FROM HERE/ }));
      // the moment's own ply, not chargedPly + 1 — must agree with the
      // moment row's own PLAY FROM HERE for the identical decision
      expect(apiMock.rehearse).toHaveBeenCalledWith(12, 2, chargedPly);
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('shows past attempts under the moment they branched from, and on the board-wide ledger', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    apiMock.rehearsals.mockResolvedValue({
      rehearsals: [
        { tournamentId: 55, boardNo: 2, branchPly: chargedPly, state: 'done', createdAt: 100, contractLabel: '4♠+1 by S', scoreNS: 650 },
        { tournamentId: 56, boardNo: 2, branchPly: chargedPly, state: 'playing', createdAt: 101, contractLabel: null, scoreNS: null },
      ],
    });
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');

    // the per-moment rail: one stub per attempt at THIS ply
    const rail = await waitFor(() => document.querySelector('.rehearsal-rail')!);
    expect(rail).not.toBeNull();
    expect(within(rail as HTMLElement).getByText('+650')).toBeInTheDocument();
    expect(within(rail as HTMLElement).getByText('IN PROGRESS')).toBeInTheDocument();

    // the board-wide ledger, further down the overview — both attempts, same
    // trick. Sentence case: the ledger's ROWS are entries, not labels.
    expect(screen.getByText('YOUR REHEARSALS')).toBeInTheDocument();
    expect(screen.getAllByText(`From trick ${chargedTrick}`)).toHaveLength(2);
    expect(screen.getByText('In progress')).toBeInTheDocument();

    // THE CARDS WERE WORTH grows a third stub for the best (highest-score) done attempt
    expect(screen.getByText('YOUR BEST REHEARSAL')).toBeInTheDocument();
    const bestStub = document.querySelector('.worth-stub-rehearsal')!;
    expect(bestStub.textContent).toContain('4♠+1 by S');
    expect(bestStub.textContent).toContain('+650');
  });

  it("inks each moment stub's score against your real table — green better, red worse, plain on a tie", async () => {
    apiMock.board.mockResolvedValue(donePlayed); // your table scored 620
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    apiMock.rehearsals.mockResolvedValue({
      rehearsals: [
        { tournamentId: 55, boardNo: 2, branchPly: chargedPly, state: 'done', createdAt: 100, contractLabel: '4♠+1 by S', scoreNS: 650 },
        { tournamentId: 56, boardNo: 2, branchPly: chargedPly, state: 'done', createdAt: 101, contractLabel: '4♠−1 by S', scoreNS: -100 },
        { tournamentId: 57, boardNo: 2, branchPly: chargedPly, state: 'done', createdAt: 102, contractLabel: '4♠ by S', scoreNS: 620 },
        { tournamentId: 58, boardNo: 2, branchPly: chargedPly, state: 'playing', createdAt: 103, contractLabel: null, scoreNS: null },
      ],
    });
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');
    const rail = await waitFor(() => document.querySelector('.rehearsal-rail')!);

    const scoreClass = (text: string) => within(rail as HTMLElement).getByText(text).className;
    expect(scoreClass('+650')).toContain('positive');
    expect(scoreClass('−100')).toContain('negative');
    expect(scoreClass('+620')).not.toMatch(/positive|negative/); // an exact tie is not a verdict
    expect(scoreClass('···')).not.toMatch(/positive|negative/); // nothing to compare yet

    // colour is never the only carrier — the stub says which way it went
    expect(within(rail as HTMLElement).getByRole('link', { name: /\+650 — beat your table/ })).toBeInTheDocument();
    expect(within(rail as HTMLElement).getByRole('link', { name: /−100 — fell short of your table/ })).toBeInTheDocument();
  });

  it('plots finished rehearsals on THE FIELD rail, coloured against your real table, and names only the colours present', async () => {
    apiMock.board.mockResolvedValue(donePlayed); // your table's own field row (isMe) scores 620
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    apiMock.rehearsals.mockResolvedValue({
      rehearsals: [
        { tournamentId: 55, boardNo: 2, branchPly: chargedPly, state: 'done', createdAt: 100, contractLabel: '4♠+1 by S', scoreNS: 700 },
        { tournamentId: 56, boardNo: 2, branchPly: chargedPly, state: 'done', createdAt: 101, contractLabel: '4♠-2X by S', scoreNS: 400 },
        { tournamentId: 57, boardNo: 2, branchPly: chargedPly, state: 'done', createdAt: 102, contractLabel: '4♠ by S', scoreNS: 620 },
        { tournamentId: 58, boardNo: 2, branchPly: chargedPly, state: 'playing', createdAt: 103, contractLabel: null, scoreNS: null },
      ],
    });
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');

    // one dot per distinct FINISHED score — the still-'playing' attempt has
    // no score yet and contributes none
    const dots = document.querySelectorAll('.worth-rehearsal-dot');
    expect(dots).toHaveLength(3);
    const bySign = [...dots].reduce((m, d) => {
      m[d.className.includes('positive') ? 'positive' : d.className.includes('negative') ? 'negative' : 'tie'] =
        (m[d.className.includes('positive') ? 'positive' : d.className.includes('negative') ? 'negative' : 'tie'] ?? 0) + 1;
      return m;
    }, {} as Record<string, number>);
    expect(bySign).toEqual({ positive: 1, negative: 1, tie: 1 }); // 700 beats 620, 400 falls short, 620 ties

    // both colours are on screen, so the legend names both
    expect(screen.getByText(/marked on the rail/)).toBeInTheDocument();
    const note = document.querySelector('.worth-rehearsal-note')!;
    expect(note.textContent).toContain('green beat your table');
    expect(note.textContent).toContain('red fell short');
  });

  it('omits the rail legend entirely when every rehearsal tied the real table', async () => {
    apiMock.board.mockResolvedValue(donePlayed); // your table's own field row scores 620
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    apiMock.rehearsals.mockResolvedValue({
      rehearsals: [
        { tournamentId: 55, boardNo: 2, branchPly: chargedPly, state: 'done', createdAt: 100, contractLabel: '4♠ by S', scoreNS: 620 },
      ],
    });
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');

    const dots = document.querySelectorAll('.worth-rehearsal-dot');
    expect(dots).toHaveLength(1);
    expect(dots[0].className).not.toMatch(/positive|negative/);
    expect(document.querySelector('.worth-rehearsal-note')).toBeNull();
    expect(screen.queryByText(/marked on the rail/)).not.toBeInTheDocument();
  });

  it('renders neither history surface when no rehearsal exists yet', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    apiMock.rehearsals.mockResolvedValue({ rehearsals: [] });
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');
    expect(screen.queryByText('YOUR REHEARSALS')).not.toBeInTheDocument();
    expect(screen.queryByText('YOUR BEST REHEARSAL')).not.toBeInTheDocument();
  });

  it('discarding a stub calls the API and drops it, optimistically, from both history surfaces', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    apiMock.rehearsals.mockResolvedValue({
      rehearsals: [
        { tournamentId: 55, boardNo: 2, branchPly: chargedPly, state: 'done', createdAt: 100, contractLabel: '4♠+1 by S', scoreNS: 650 },
      ],
    });
    apiMock.discardRehearsal.mockResolvedValue({ ok: true });
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');
    await waitFor(() => expect(document.querySelector('.rehearsal-rail')).not.toBeNull());
    expect(screen.getByText('YOUR REHEARSALS')).toBeInTheDocument();

    const discardButtons = screen.getAllByRole('button', { name: 'Discard this rehearsal attempt' });
    expect(discardButtons.length).toBeGreaterThan(0); // one per surface, same attempt
    await userEvent.click(discardButtons[0]);

    expect(apiMock.discardRehearsal).toHaveBeenCalledWith(12, 2, 55);
    await waitFor(() => expect(document.querySelector('.rehearsal-rail')).toBeNull());
    expect(screen.queryByText('YOUR REHEARSALS')).not.toBeInTheDocument();
  });

  it('reconciles from the server instead of leaving a stale gap if the discard actually fails', async () => {
    apiMock.board.mockResolvedValue(donePlayed);
    apiMock.analysis.mockResolvedValue(makeAnalysis({ par: parPayload }));
    apiMock.rehearsals.mockResolvedValue({
      rehearsals: [
        { tournamentId: 55, boardNo: 2, branchPly: chargedPly, state: 'done', createdAt: 100, contractLabel: '4♠+1 by S', scoreNS: 650 },
      ],
    });
    apiMock.discardRehearsal.mockRejectedValue(new Error('nope'));
    renderAnalyze();
    await screen.findByText('WHERE IT TURNED');
    await waitFor(() => expect(document.querySelector('.rehearsal-rail')).not.toBeNull());

    const discardButtons = screen.getAllByRole('button', { name: 'Discard this rehearsal attempt' });
    await userEvent.click(discardButtons[0]);

    // The failed delete's catch re-fetches rehearsals, and the mock still
    // reports the attempt as present, so the stub reappears rather than
    // leaving the screen out of sync with the server.
    await waitFor(() => expect(apiMock.rehearsals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector('.rehearsal-rail')).not.toBeNull());
  });
});
