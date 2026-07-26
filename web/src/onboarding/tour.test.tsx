import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { claimAnnouncement, stageClaimSteps } from '../components/game/playAnim';
import Tour from '../pages/Tour';
import { meFreshCrosser } from '../test/fixtures';
import { GlossaryProvider } from '../glossary/GlossaryContext';
import { apiMock, renderWithMe } from '../test/utils';
import board0 from './board0.json';
import { type TourBoard, loadTourBoard } from './board0';
import { segmentProse } from '../glossary/linkify';
import { TERM_BY_SLUG } from '../glossary/terms';
import { COPY, STEPS, TOUR_LINKS, guidanceFor } from './script';

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
    expect(row('The Novice').contract, 'the Novice goes two down').toMatch(/−2$/);
    expect(COPY.fieldSay).toContain('The Shark and The Regular');
    expect(COPY.fieldSay).toContain('went two down');
  });

  it('the captured tail is a genuine claim the tour can animate, not a flat cut to the ledger', () => {
    // Regression guard for the bug this capture fixed: gen_tour_board.mjs
    // used to reload the board fresh from the DB before recapturing `final`
    // (to pick up the persona field rows), which silently lost the
    // in-memory-only `claimed` flag (server/src/game.ts's b.claimed has no
    // persisted column) — Tour.tsx's stagePlaySteps can't stage a
    // multi-trick jump, so it fell back to an unanimated cut straight to
    // the ledger instead of the claim announcement + fast-forward.
    expect(data.final.claimed).toBe(true);
    const last = data.steps[data.steps.length - 1];
    expect(last.view.state).toBe('playing');
    // the exact two inputs Tour.tsx's runClaim needs to actually animate it
    const info = claimAnnouncement(last.view, data.final);
    expect(info).not.toBeNull();
    expect(stageClaimSteps(last.view, data.final).length).toBeGreaterThan(0);
  });
});

describe('the first crossing (Tour)', () => {
  it('skips in-world from the pamphlet cover, stamping the visit', async () => {
    apiMock.setOnboarded.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { refresh } = renderWithMe(<Tour />, { me: meFreshCrosser });
    expect(await screen.findByText(/Welcome to the bridge/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /skip the tutorial/i }));
    await waitFor(() => expect(apiMock.setOnboarded).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

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
    const skipBtn = await screen.findByRole('button', { name: /skip the tutorial/i });
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

  it('reads the pamphlet: philosophy panel, then duplicate as a specimen ledger', async () => {
    const user = userEvent.setup();
    renderWithMe(<Tour />, { me: meFreshCrosser });
    await user.click(await screen.findByRole('button', { name: /read the pamphlet/i }));
    // I · THE BRIDGE — the club philosophy and the naming story
    // "robot" is a glossary link now, so the sentence is split across elements
    expect(screen.getByRole('button', { name: 'robot' })).toBeInTheDocument();
    expect(screen.getByText(/of even temper/)).toBeInTheDocument();
    expect(screen.getByText(/at their own pace/)).toBeInTheDocument();
    expect(screen.getByText(/a dime to cross, then a nickel, now fifty cents/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // II · THE LEDGER — one deal, three fates
    expect(screen.getByText(/the luck is dealt out of the/)).toBeInTheDocument();
    // "game" appears here in its everyday sense, not the scoring term — the
    // ledger panel's TourProse call opts it out of TOUR_LINKS' sitewide force
    expect(screen.queryByRole('button', { name: 'game' })).not.toBeInTheDocument();
    expect(screen.getByText('Harold')).toBeInTheDocument();
    expect(screen.getByText('Margaret')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // III · THE PRACTICE — the board №0 offer
    expect(screen.getByRole('button', { name: /practice/i })).toBeInTheDocument();
  });

  it(
    'walks board №0 through the real board UI to the ledger and postmark',
    { timeout: 30000 },
    async () => {
      apiMock.setOnboarded.mockResolvedValue({ ok: true });
      const user = userEvent.setup();
      const { container, refresh } = renderWithMe(<Tour />, { me: meFreshCrosser });

      // pamphlet: cover → the bridge → the ledger → the offer → the board
      await user.click(await screen.findByRole('button', { name: /read the pamphlet/i }));
      await user.click(await screen.findByRole('button', { name: /continue/i }));
      await user.click(await screen.findByRole('button', { name: /continue/i }));
      await user.click(await screen.findByRole('button', { name: /practice/i }));

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

      // the tail self-plays through ordinary tricks, then hits this deal's
      // genuine claim — the same ClaimOverlay the live board uses (tap to
      // dismiss early), not a silent cut straight to the ledger
      const claimOverlay = await screen.findByRole('dialog', { name: /claim/i }, { timeout: 15000 });
      expect(claimOverlay).toHaveTextContent(/CLAIM/);
      await user.click(claimOverlay);

      // the tail finishes to the real receipt…
      await screen.findByRole('button', { name: /see the field/i }, { timeout: 15000 });
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
    expect(slugsIn(COPY.ledgerPanel.body2)).toEqual(['duplicate-bridge', 'game']);
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

  it('links the pamphlet’s body copy, and opens the sheet on a tap', async () => {
    const user = userEvent.setup();
    renderWithMe(
      <GlossaryProvider>
        <Tour />
      </GlossaryProvider>,
      { me: meFreshCrosser },
    );
    await user.click(await screen.findByRole('button', { name: /read the pamphlet/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: 'duplicate' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Duplicate bridge');
  });

  it('leaves display type alone — no dotted underlines through the headlines', () => {
    const { container } = renderWithMe(<Tour />, { me: meFreshCrosser });
    expect(container.querySelector('.tour-cover-title .gloss-link')).toBeNull();
  });
});
