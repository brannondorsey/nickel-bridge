import { describe, expect, it } from 'vitest';
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
