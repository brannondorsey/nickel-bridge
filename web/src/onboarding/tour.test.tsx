import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
});

describe('the first crossing (Tour)', () => {
  it('skips in-world at the gate, stamping the visit', async () => {
    apiMock.setOnboarded.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { refresh } = renderWithMe(<Tour />, { me: meFreshCrosser });
    expect(await screen.findByText(/First time across this bridge/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /i know the way/i }));
    await waitFor(() => expect(apiMock.setOnboarded).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it(
    'walks board №0 through the real board UI to the ledger and postmark',
    { timeout: 20000 },
    async () => {
      apiMock.setOnboarded.mockResolvedValue({ ok: true });
      const user = userEvent.setup();
      const { container, refresh } = renderWithMe(<Tour />, { me: meFreshCrosser });

      // gate → offer → the practice board
      await user.click(await screen.findByRole('button', { name: /first time/i }));
      await user.click(await screen.findByRole('button', { name: /take the practice board/i }));

      // decision 0 — the real bid box, meanings before commit
      const nt = await screen.findByRole('button', { name: '1NT' });
      expect(container.querySelector('.bidbox')).toBeTruthy();
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
      await screen.findByText(/choice of games/);
      await user.click(screen.getByRole('button', { name: '4♠' }));
      await user.click(screen.getByRole('button', { name: 'Bid 4♠' }));

      // play: dummy comes down; the forced ♥10 self-plays (real auto-play path)
      await screen.findByText(/lays their hand on the table/);
      // decision 4 — two-step tap on the ♥4 (card 15)
      await screen.findByText(/Dummy’s ten is already winning/);
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

      // the tail self-plays to the real receipt…
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
