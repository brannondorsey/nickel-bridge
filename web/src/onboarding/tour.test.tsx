import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { claimAnnouncement, stageClaimSteps } from '../components/game/playAnim';
import Tour from '../pages/Tour';
import { meFreshCrosser } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import board0 from './board0.json';
import type { TourBoard } from './board0';
import { COPY, STEPS, guidanceFor } from './script';

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

  it('reads the pamphlet: philosophy panel, then duplicate as a specimen ledger', async () => {
    const user = userEvent.setup();
    renderWithMe(<Tour />, { me: meFreshCrosser });
    await user.click(await screen.findByRole('button', { name: /read the pamphlet/i }));
    // I · THE BRIDGE — the club philosophy and the naming story
    expect(screen.getByText(/robot of even temper/)).toBeInTheDocument();
    expect(screen.getByText(/at their own pace/)).toBeInTheDocument();
    expect(screen.getByText(/a dime to cross, then a nickel, now fifty cents/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // II · THE LEDGER — one deal, three fates
    expect(screen.getByText(/luck is dealt out of the game/)).toBeInTheDocument();
    expect(screen.getByText('Harold')).toBeInTheDocument();
    expect(screen.getByText('Margaret')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // III · THE PRACTICE — the board №0 offer
    expect(screen.getByRole('button', { name: /practice/i })).toBeInTheDocument();
  });

  it(
    'walks board №0 through the real board UI to the ledger and postmark',
    { timeout: 20000 },
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
      expect(screen.getByText(/fifteen high card points \(HCP\)/)).toBeInTheDocument();
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
      await screen.findByText(/choice of game\b/);
      await user.click(screen.getByRole('button', { name: '4♠' }));
      await user.click(screen.getByRole('button', { name: 'Bid 4♠' }));

      // play: dummy comes down; the forced ♥10 self-plays, but only after a
      // real beat to read the narration (GUIDED_FORCED_DELAY_MS — this line
      // used to vanish in ~250ms, too fast to read)
      await screen.findByText(/lays their hand on the table/);
      // decision 4 — two-step tap on the ♥4 (card 15); "Deliberate, always"
      // was dropped from this line per review
      await screen.findByText(/Dummy’s ten is already winning/);
      expect(screen.queryByText(/Deliberate, always/)).not.toBeInTheDocument();
      const heart4 = () => container.querySelector('[data-card="15"]') as HTMLElement;
      await waitFor(() => expect(heart4()).toBeTruthy());
      await user.click(heart4());
      await user.click(heart4()); // second tap plays
      // decision 5 — lead trumps from dummy (card 0)
      await screen.findByText(/the table leads/i);
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
      await user.click(await screen.findByRole('button', { name: /see the field/i }, { timeout: 15000 }));
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
