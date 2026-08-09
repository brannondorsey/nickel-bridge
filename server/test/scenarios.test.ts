import { describe, expect, it } from 'vitest';
import { cardName } from '@bridge/core';
import { freshDbEnv } from './helpers.js';

/**
 * The recipe-drift guard (see CLAUDE.md invariant 1): every catalog entry in
 * server/src/scenarios.ts replays through the real engine to exactly its
 * declared state. A failure here means robot behavior changed out from under
 * the recipes — if that change was deliberate, re-derive them with
 * `node tools/find_scenarios.mjs` and re-curate the copy; if it wasn't, you
 * were about to break robot determinism itself.
 */
freshDbEnv('scenarios');
const { db } = await import('../src/db.js');
const { runScenario } = await import('../src/demo.js');
const { SCENARIOS } = await import('../src/scenarios.js');
const game = await import('../src/game.js');
const { standings } = await import('../src/tournaments.js');

const userId = (
  db.prepare(`INSERT INTO users (google_id, name, handle, handle_key) VALUES ('dev:drift','Drift','Drift','drift') RETURNING id`).get() as {
    id: number;
  }
).id;

describe('scenario recipes replay to their declared states', () => {
  for (const s of SCENARIOS) {
    it(
      `'${s.id}' → ${s.expect}`,
      async () => {
        // runScenario itself throws on state drift; the assertions below add
        // the tester-facing contract: it is their turn when they arrive.
        const { tournamentId, boardNo } = await runScenario(userId, s);
        const t = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId) as never;
        const b = game.loadBoard(t, userId, boardNo, false)!;
        const view = game.boardView(t, b, 1200);
        expect(view.state).toBe(s.expect);
        expect(view.myTurn).toBe(true);
        if (s.expectClaimOnFinalAction) {
          // `expect` only describes the board one action BEFORE the payoff, so
          // an exhibit whose copy promises a claim needs the payoff itself
          // checked — take the tester's final action here and require the claim
          // to actually fire. Without this the pessimistic claim gate silently
          // turned both claim exhibits into ordinary card play with the
          // descriptions still promising a ticket.
          //
          // Every legal final card is tried, not just the first: under the
          // pessimistic gate whether a claim fires can depend on WHICH card is
          // played (in 'claim-fires' the ♣9 claims and the ♣K does not), so a
          // one-card check could stay green while the card the copy actually
          // names stopped claiming. Each attempt needs its own replay, since
          // the first one finishes the board. Which cards claim is the flag's
          // own contract ('all' vs 'any') — see its doc comment for why the
          // difference is a copy-writing constraint and not a detail.
          const claimed: string[] = [];
          for (const c of view.legalCards) {
            db.prepare(`DELETE FROM boards WHERE tournament_id = ? AND user_id = ?`).run(tournamentId, userId);
            const replay = await runScenario(userId, s);
            const fresh = game.loadBoard(t, userId, replay.boardNo, false)!;
            await game.submitPlay(fresh, c);
            if (!fresh.claimed) continue;
            expect(fresh.row.claimed_at_ply).not.toBeNull();
            claimed.push(cardName(c));
          }
          expect(claimed, 'the description promises a claim, but no legal final card produces one').not.toHaveLength(0);
          if (s.expectClaimOnFinalAction === 'all') {
            expect(claimed, `every legal final card should claim — only ${claimed.join(', ')} does`).toHaveLength(
              view.legalCards.length,
            );
          } else {
            // 'any': the copy has to name the card, so a change in WHICH cards
            // claim is a re-curation trigger even though the exhibit still
            // works. The assertion can't read the prose; it just refuses to let
            // the set drift silently.
            expect(
              claimed.length,
              `claiming cards for '${s.id}' changed (now ${claimed.join(', ')}) — re-read its description`,
            ).toBeLessThan(view.legalCards.length);
          }
        }
        if (s.completesTournament) {
          // The tester's live final play is supposed to finish the whole
          // tournament, not just this board — so every prior board must
          // already be done before they take that last action.
          const mine = standings(tournamentId).find((row) => row.userId === userId);
          expect(mine?.boardsDone).toBe(boardNo - 1);
        }
      },
      120_000,
    );
  }
});
