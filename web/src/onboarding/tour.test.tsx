import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { claimAnnouncement, planClaim, stageClaimSteps } from '../components/game/playAnim';
import Tour, { TourPostmark } from '../pages/Tour';
import { meFreshCrosser, meLoggedOut } from '../test/fixtures';
import { GlossaryProvider } from '../glossary/GlossaryContext';
import { apiMock, renderWithMe } from '../test/utils';
import board0 from './board0.json';
import { type TourBoard, loadTourBoard } from './board0';
import { segmentProse } from '../glossary/linkify';
import { TERM_BY_SLUG } from '../glossary/terms';
import { COPY, STEPS, TOUR_LINKS, guidanceFor } from './script';
import { peekTourDone } from './tourDone';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

const data = board0 as unknown as TourBoard;

/**
 * The drift guard: the narration in script.ts is hand-curated against the
 * capture in board0.json (same contract as demo scenario recipes). If the
 * capture is regenerated onto a different deal/line, these pins fail and the
 * script must be re-curated by hand — the tour must never narrate a deal it
 * isn't showing.
 */
describe('first-crossing script ↔ capture drift guard', () => {
  it('narrates the captured line, action for action', () => {
    expect(STEPS.length).toBeLessThanOrEqual(data.steps.length);
    STEPS.forEach((g, i) => {
      expect(g.expect, `guidance ${i} pins the capture's action`).toBe(data.steps[i].action);
    });
  });

  it('every graded call is honestly the robot’s own choice', () => {
    for (const step of data.steps.filter((s) => s.kind === 'call')) {
      expect(step.evaluation).toBeDefined();
      expect(step.evaluation!.grade).toBe('excellent');
      expect(step.evaluation!.bestCall).toBe(step.action);
    }
  });

  it('teaches with the real thing: exact artificial partner call, house field, made game', () => {
    // the "bids are a code" moment — partner's reply is a named artificial convention
    const partnerReply = data.steps[1].view.auction[2];
    expect(partnerReply.meaning?.exact).toBe(true);
    expect(partnerReply.meaning?.artificial).toBe(true);
    // meanings are attached to every legal call at each bidding decision
    for (const step of data.steps.filter((s) => s.kind === 'call')) {
      expect(Object.keys(step.view.legalCallMeanings ?? {}).length).toBeGreaterThan(0);
    }
    // the ledger lesson: a genuine four-row field, three of them the house
    const field = data.final.result!.field;
    expect(field).toHaveLength(4);
    expect(field.filter((f) => f.kind === 'ai')).toHaveLength(3);
    expect(field.some((f) => f.isMe)).toBe(true);
    // the first crossing comes home
    expect(data.final.result!.scoreNS).toBeGreaterThan(0);
    // the tail past the curated steps self-plays
    expect(guidanceFor(STEPS.length, data).auto).toBe(true);
  });

  it('never names a time of day — a first crossing is walked at any hour', () => {
    // The club's evening register invites "tonight", and the script shipped
    // full of it; to an account made at nine in the morning it reads as a lie.
    // Home's "Good morning/afternoon/evening" is the one surface allowed to
    // name the hour, because it actually checks the clock.
    const strings = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
    const lines = [...strings(COPY), ...STEPS.flatMap((s) => [s.say, s.offScript ?? ''])];
    expect(lines.length).toBeGreaterThan(10); // the walker found the copy
    for (const line of lines) {
      expect(line, line).not.toMatch(/\b(tonight|this evening|evening|morning|afternoon|midnight|today|tomorrow)\b/i);
    }
  });

  it('renumbers every view to board №0 on load', async () => {
    // The capture had to run on a real board (3 — dealer South). The tour's
    // own chrome says №0, and so must the shared components that read
    // view.boardNo: the receipt panel used to announce "THE TOLL — BOARD 3"
    // between two №0 headings (PR #87 review).
    expect(data.final.boardNo).toBe(3); // the raw capture is left alone
    const loaded = await loadTourBoard();
    expect(loaded.final.boardNo).toBe(0);
    // uniform, or TrickArea's (tournamentId, boardNo) identity check would
    // read the final view as a different board and skip the last animation
    expect(loaded.steps.map((s) => s.view.boardNo)).toEqual(loaded.steps.map(() => 0));
  });

  it('the field narration names outcomes the ledger actually shows', () => {
    // COPY.fieldSay is the one line that makes factual claims about the OTHER
    // rows ("The Shark and The Regular both landed your exact line… The Novice
    // …went two down"). Nothing else in this guard would notice a regenerated
    // capture that reshuffled the house, leaving the tollkeeper confidently
    // narrating a table that isn't on screen.
    const field = data.final.result!.field;
    const row = (handle: string) => field.find((f) => f.handle === handle)!;
    const me = field.find((f) => f.isMe)!;
    for (const tied of ['The Shark', 'The Regular']) {
      expect(row(tied), tied).toBeDefined();
      expect(row(tied).scoreNS, `${tied} shares your score`).toBe(me.scoreNS);
      expect(row(tied).pct, `${tied} splits the matchpoints with you`).toBe(me.pct);
    }
    expect(row('The Novice').contract, 'the Novice goes three down').toMatch(/−3$/);
    expect(COPY.fieldSay).toContain('The Shark and The Regular');
    expect(COPY.fieldSay).toContain('went three down');
  });

  it('the captured tail plays out to the ledger, with no claim to animate', () => {
    // This capture USED to end in a claim: under the old optimistic gate the
    // board was 100% determined double dummy with six tricks to go, so the
    // server fast-played them and the tour got a free demonstration of the
    // claim beat (lead → announcement → fast-forward). The pessimistic gate
    // (packages/ai/src/claim.ts) plays that position out instead — a legal
    // deviation could still have spoiled it — so the deal now runs to the
    // last card and the tour's tail is ten more self-playing decisions.
    //
    // The capture is a strict EXTENSION of the old one: steps 0–18 are
    // byte-identical, which is why script.ts's six curated steps needed no
    // re-curation. What is gone is the claim demonstration; a newcomer now
    // meets their first claim in a real game. Restoring it means mining a
    // seed that is both teachable AND still claims under the new gate, and
    // re-curating the narration for a different deal — a deliberate content
    // job, not a side effect of a gate change.
    expect(data.final.claimed).toBeFalsy();
    const last = data.steps[data.steps.length - 1];
    expect(last.view.state).toBe('playing');
    // The last decision resolves exactly the rest of the hand, so Tour.tsx's
    // ordinary stagePlaySteps path (one trick boundary at most) is enough and
    // runClaim is never entered.
    expect(claimAnnouncement(last.view, data.final)).toBeNull();
    expect(planClaim(last.view, data.final, { fast: true, motion: true })).toBeNull();
    expect(data.final.playHistory!.length - (last.view.completedTricks ?? 0)).toBe(1);
  });
});

describe('the first crossing (Tour)', () => {
  it('a failed setOnboarded never wedges "skip the tutorial" — busy always resets (PR #87 review)', async () => {
    // A thrown setOnboarded (session hiccup, transient network failure) is
    // swallowed so the gate never traps anyone — but if a stale build never
    // reset `busy` in a finally, App.tsx would keep rendering this same Tour
    // instance (onboardedAt never flipped) with every disabled={busy}
    // control wedged for the rest of the session. Cover both failure and
    // the subsequent successful retry.
    apiMock.setOnboarded.mockRejectedValueOnce(new Error('network hiccup'));
    const user = userEvent.setup();
    const { refresh } = renderWithMe(<Tour />, { me: meFreshCrosser });
    await screen.findByRole('button', { name: '1NT' });
    const skipBtn = screen.getByRole('button', { name: /skip the tutorial/i });
    await user.click(skipBtn);
    await waitFor(() => expect(apiMock.setOnboarded).toHaveBeenCalledTimes(1));
    // the failed call still calls refresh() (App.tsx re-renders the same
    // un-onboarded Tour) — the skip control must not be stuck disabled
    await waitFor(() => expect(skipBtn).toBeEnabled());

    apiMock.setOnboarded.mockResolvedValueOnce({ ok: true });
    await user.click(skipBtn);
    await waitFor(() => expect(apiMock.setOnboarded).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  // Nothing precedes the deal. Everything that used to — the philosophy panel,
  // the specimen ledger, and then the welcome screen merged from the cover and
  // the offer — restated what the landing page says on the way in, and the
  // automatic gate fires for accounts that signed in FROM that page.
  it('opens on the deal itself, with no screen in front of it', async () => {
    renderWithMe(<Tour />, { me: meFreshCrosser });
    expect(await screen.findByRole('button', { name: '1NT' })).toBeInTheDocument();
    // the tollkeeper's first line is the framing
    expect(screen.getByText(/THE TOLLKEEPER/)).toBeInTheDocument();
    // the practice identity rides on the board head, as it always did
    expect(screen.getByText('№0')).toBeInTheDocument();
    // and none of the landing page's argument is repeated
    expect(screen.queryByText(/Welcome to the bridge/)).not.toBeInTheDocument();
    expect(screen.queryByText(/of even temper/)).not.toBeInTheDocument();
    expect(screen.queryByText(/the luck is dealt out of the/)).not.toBeInTheDocument();
    expect(screen.queryByText('Harold')).not.toBeInTheDocument();
  });

  // The pamphlet's fine print was the only way out, and it only existed before
  // the deal began. The ribbon is sticky, so this one is reachable throughout.
  it('keeps a way out on the board itself, in the sticky ribbon', async () => {
    apiMock.setOnboarded.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { refresh } = renderWithMe(<Tour />, { me: meFreshCrosser });
    await screen.findByRole('button', { name: '1NT' });
    await user.click(screen.getByRole('button', { name: /skip the tutorial/i }));
    await waitFor(() => expect(apiMock.setOnboarded).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it(
    'walks board №0 through the real board UI to the ledger and postmark',
    { timeout: 30000 },
    async () => {
      apiMock.setOnboarded.mockResolvedValue({ ok: true });
      const user = userEvent.setup();
      const { container, refresh } = renderWithMe(<Tour />, { me: meFreshCrosser });

      // decision 0 — the real bid box, meanings before commit
      const nt = await screen.findByRole('button', { name: '1NT' });
      expect(container.querySelector('.bidbox')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'high card points' })).toBeInTheDocument();
      expect(screen.getByText(/\(HCP\), evenly spread/)).toBeInTheDocument();
      // "the most honest bid in the game" — everyday sense, not the scoring
      // term, so step 0's `skip` keeps it plain here (unlike step 2's "a
      // choice of game", which is)
      expect(screen.getByText(/the most honest bid in the game/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'game' })).not.toBeInTheDocument();
      // exploring off-script shows the real meaning; committing it is redirected
      await user.click(screen.getByRole('button', { name: '2♣' }));
      expect(container.querySelector('.meaning-panel')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Bid 2♣' }));
      expect(await screen.findByText(/follow the tollkeeper|the honest one/i)).toBeInTheDocument();
      // the scripted call: select, confirm — graded with the real toast
      await user.click(nt);
      await user.click(screen.getByRole('button', { name: 'Bid 1NT' }));
      expect(await screen.findByText(/Excellent/)).toBeInTheDocument();

      // decision 1 — partner's transfer is tappable in the auction (real inspector)
      await screen.findByText(/code word/);
      const transferBtn = Array.from(container.querySelectorAll('.auction tbody button')).find((b) =>
        b.textContent?.includes('2♥'),
      );
      expect(transferBtn).toBeTruthy();
      await user.click(transferBtn as HTMLElement);
      expect(await screen.findByText(/Jacoby transfer/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /close/i }));
      await user.click(screen.getByRole('button', { name: '2♠' }));
      await user.click(screen.getByRole('button', { name: 'Bid 2♠' }));

      // decision 2 — accept the spade game
      await screen.findByText(/Partner shows five spades and offers a choice of/);
      // the narration ribbon links its terms too — "trumps" is one of the
      // words TOUR_LINKS re-links for a first-timer (linkify:false sitewide)
      expect(screen.getByRole('button', { name: 'trumps' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '4♠' }));
      await user.click(screen.getByRole('button', { name: 'Bid 4♠' }));

      // play: dummy comes down; the forced ♥10 self-plays, but only after a
      // real beat to read the narration (GUIDED_FORCED_DELAY_MS — this line
      // used to vanish in ~250ms, too fast to read). The caption itself
      // only appears once the auction→play transition actually settles
      // (displayIdx lags idx) rather than the instant 4♠ commits, so it
      // never describes dummy coming down before dummy is actually down.
      await screen.findByText(/lays their hand on the table/, {}, { timeout: 5000 });
      // jsdom reports no motion support, so this whole walk takes the
      // REDUCED-MOTION path — which is exactly where the beat used to
      // collapse to 0ms (PR #87 review). The line that teaches dummy must
      // still be on screen a second later; only the tail's pacing is motion.
      await new Promise((r) => setTimeout(r, 1000));
      expect(screen.getByText(/lays their hand on the table/)).toBeInTheDocument();
      // decision 4 — two-step tap on the ♥4 (card 15); "Deliberate, always"
      // was dropped from this line per review. Arrives after the full
      // GUIDED_FORCED_DELAY_MS beat, so this waits longer than the 6s.
      await screen.findByText(/ten is already winning the/, {}, { timeout: 9000 });
      expect(screen.queryByText(/Deliberate, always/)).not.toBeInTheDocument();
      const heart4 = () => container.querySelector('[data-card="15"]') as HTMLElement;
      await waitFor(() => expect(heart4()).toBeTruthy());
      await user.click(heart4());
      await user.click(heart4()); // second tap plays
      // decision 5 — lead trumps from dummy (card 0)
      await screen.findByText(/Time to pull their/, {}, { timeout: 5000 });
      const spade2 = () => container.querySelector('[data-card="0"]') as HTMLElement;
      await waitFor(() => expect(spade2()).toBeTruthy());
      await user.click(spade2());
      await user.click(spade2());

      // The tail self-plays every remaining trick to the end of the hand.
      // It used to stop short and claim — see the capture guard above for why
      // it no longer does, and what that costs the tour.
      expect(screen.queryByRole('dialog', { name: /claim/i })).not.toBeInTheDocument();

      // the tail finishes to the real receipt…
      await screen.findByRole('button', { name: /see the field/i }, { timeout: 15000 });
      // …postmarked with the practice CROSSING's number, №0 like the board.
      // The capture predates boardView's `tournamentNumber`, so without
      // board0.ts stamping it this reads "Nº1" — the capture's row id, on a
      // newcomer's first receipt (see TOUR_CROSSING_NO).
      expect(screen.getByText('TOURNAMENT Nº0')).toBeInTheDocument();
      // …whose "Back to lobby" is the tour's own exit, not the live board's
      // <Link to="/"> (which would change the URL and leave the newcomer on
      // this very screen, since the tour renders in place of the routes)
      expect(screen.getByRole('button', { name: /back to lobby/i })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /see the field/i }));
      // …and the ledger reveal: the genuine house field
      expect(await screen.findByText('The Shark')).toBeInTheDocument();
      expect(screen.getAllByText('HOUSE')).toHaveLength(3);
      expect(screen.getByText('You')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /one last thing/i }));

      // postmark: FIRST CROSSING, then out through the toll
      expect(await screen.findByText('FIRST CROSSING')).toBeInTheDocument();
      apiMock.play.mockResolvedValue({ tournamentId: 7, boardNo: 1 });
      await user.click(screen.getByRole('button', { name: /play the toll/i }));
      await waitFor(() => expect(apiMock.setOnboarded).toHaveBeenCalled());
      await waitFor(() => expect(apiMock.play).toHaveBeenCalled());
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    },
  );
});

describe('the tour’s glossary links', () => {
  const slugsIn = (text: string) =>
    segmentProse(text, TOUR_LINKS)
      .filter((s) => s.slug)
      .map((s) => s.slug);

  it('every dial in TOUR_LINKS is doing real work', () => {
    // a forced slug that doesn't exist, or isn't linkify:false sitewide, is
    // dead weight in the policy — and a stale one hides a broken link
    for (const slug of TOUR_LINKS.force ?? []) {
      const term = TERM_BY_SLUG.get(slug);
      expect(term, `forced slug ${slug} is not a core term`).toBeDefined();
      expect(term!.linkify, `forcing ${slug} is redundant — it already links`).toBe(false);
    }
    for (const slug of TOUR_LINKS.skip ?? []) expect(TERM_BY_SLUG.get(slug), slug).toBeDefined();
  });

  it('teaches the common words gameplay prose deliberately leaves unlinked', () => {
    expect(slugsIn(STEPS[2].say)).toContain('trump'); // "eight trumps between you"
    expect(slugsIn(STEPS[4].say)).toEqual(['dummy', 'trick']);
    // and none of it leaks into the sitewide policy the rest of the app reads
    expect(segmentProse(STEPS[2].say).filter((s) => s.slug)).toHaveLength(0);
  });

  it('never links a term in the wrong sense: splitting matchpoints is a tie, not a suit break', () => {
    expect(slugsIn(COPY.fieldSay)).toContain('matchpoints');
    expect(slugsIn(COPY.fieldSay)).not.toContain('break');
  });

  it('never links "game" in its everyday sense — only Board.tsx\'s per-instance skip catches this, bare TOUR_LINKS can\'t', () => {
    // "the most honest bid in the game" means bridge itself, not the scoring
    // term — bare TOUR_LINKS still links it (that's the whole reason step 0
    // carries its own `skip`, applied at Tollkeeper's TourProse call site)
    expect(slugsIn(STEPS[0].say)).toContain('game');
    expect(STEPS[0].skip).toContain('game');
    const stepZeroPolicy = { ...TOUR_LINKS, skip: [...(TOUR_LINKS.skip ?? []), ...(STEPS[0].skip ?? [])] };
    expect(
      segmentProse(STEPS[0].say, stepZeroPolicy)
        .filter((s) => s.slug)
        .map((s) => s.slug),
    ).not.toContain('game');
    // step 2's "a choice of game" is the real scoring term and stays linked
    expect(STEPS[2].skip).toBeUndefined();
    expect(slugsIn(STEPS[2].say)).toContain('game');
  });

  it('links the tollkeeper’s narration, and opens the sheet on a tap', async () => {
    const user = userEvent.setup();
    renderWithMe(
      <GlossaryProvider>
        <Tour />
      </GlossaryProvider>,
      { me: meFreshCrosser },
    );
    // step 0's line: "fifteen high card points (HCP), evenly spread"
    await user.click(await screen.findByRole('button', { name: 'high card points' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/high card point/i);
  });

  // The tour reads without an account (App.tsx's isPublicPath) — it is the one
  // thing a visitor can actually DO before being asked for one, so none of it
  // may depend on a session. The board itself never did; the two doors out
  // of it did.
  describe('walked without an account', () => {
    it('skips straight out, without a POST that could only 401', async () => {
      const user = userEvent.setup();
      renderWithMe(<Tour />, { me: meLoggedOut });
      await screen.findByRole('button', { name: '1NT' });
      await user.click(screen.getByRole('button', { name: /skip the tutorial/i }));
      expect(apiMock.setOnboarded).not.toHaveBeenCalled();
    });

    it('lands straight on the real board UI', async () => {
      renderWithMe(<Tour />, { me: meLoggedOut });
      expect(await screen.findByRole('button', { name: '1NT' })).toBeInTheDocument();
    });
  });

  // The last page is the payoff, and signed out it is also the sign-up: the
  // one moment where asking for an account buys the visitor something they
  // have just been shown. Rendered directly — reaching it through the board
  // costs a 30-second walk, and what changed is only these two doors.
  describe('the postmark, as a gate', () => {
    it('asks for the account there, and records the walk before the redirect', async () => {
      const user = userEvent.setup();
      renderWithMe(<TourPostmark authed={false} busy={false} onPlay={vi.fn()} onSkip={vi.fn()} />, {
        me: meLoggedOut,
      });
      expect(screen.getByText(/nor of anyone who only came to look/)).toBeInTheDocument();
      // no lobby to be sent back to — the ledger is what they can read now
      expect(screen.getByRole('link', { name: /read the ledger instead/i })).toHaveAttribute('href', '/glossary');
      expect(peekTourDone()).toBe(false);
      await user.click(screen.getByRole('link', { name: /play the toll/i }));
      // stamped on the way out, so signing in doesn't hand them this same tour
      expect(peekTourDone()).toBe(true);
    });

    it('sends a signed-in finisher to a real table instead', async () => {
      const onPlay = vi.fn();
      const user = userEvent.setup();
      renderWithMe(<TourPostmark authed busy={false} onPlay={onPlay} onSkip={vi.fn()} />, { me: meFreshCrosser });
      await user.click(screen.getByRole('button', { name: /play the toll/i }));
      expect(onPlay).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /to the lobby instead/i })).toBeInTheDocument();
      expect(peekTourDone()).toBe(false);
    });
  });

  it('leaves display type alone — no dotted underlines through the headlines', () => {
    const { container } = renderWithMe(<Tour />, { me: meFreshCrosser });
    expect(container.querySelector('.tour-cover-title .gloss-link')).toBeNull();
  });
});
