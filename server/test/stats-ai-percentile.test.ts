import { describe, expect, it } from 'vitest';
import { freshDbEnv, makeApp, TestClient } from './helpers.js';

/**
 * Regression for stats.ts's fieldPercentiles() "111%" bug: betterThan's
 * "everyone but me" denominator (field.length - 1) is only correct when the
 * profile being ranked is itself a member of the comparison pool. Under the
 * old shadow-row partition the pools were human-only and personas needed a
 * special-case re-insertion; now personas are full field members
 * (avgPct/bidAccuracy pools include kind='ai'), so membership holds by
 * construction — this suite pins that a persona beating every human still
 * caps at exactly 100%, never 200%-style overshoot. It gets its own
 * freshDbEnv/db file so the persona has no board history beyond what's
 * inserted here — otherwise its totals.avgPct would be diluted by whatever
 * other suites happened to run first.
 */
freshDbEnv('stats-ai-pct');
process.env.AI_PLAYERS = '1';

const { db } = await import('../src/db.js');
const { ensureAiPlayers } = await import('../src/ai-players.js');
const { standings } = await import('../src/tournaments.js');

describe("a benchmark AI persona's own percentile", () => {
  it('stays within [0, 100] even when it beats every human in the comparison pool', async () => {
    const app = await makeApp();
    const viewer = new TestClient(app, 'PctViewer');
    await viewer.login();
    const persona = ensureAiPlayers().expert;

    const t = db
      .prepare(
        `INSERT INTO tournaments (name, seed, difficulty, ai_field) VALUES ('Pct', 'pct-seed', 'intermediate', 1) RETURNING id`,
      )
      .get() as { id: number };
    const humanA = db
      .prepare(`INSERT INTO users (google_id, name, handle, handle_key) VALUES ('dev:pct-a', 'PA', 'PctA', 'pcta') RETURNING id`)
      .get() as { id: number };
    const humanB = db
      .prepare(`INSERT INTO users (google_id, name, handle, handle_key) VALUES ('dev:pct-b', 'PB', 'PctB', 'pctb') RETURNING id`)
      .get() as { id: number };

    const insertBoard = db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, score_ns, bid_evals)
       VALUES (?, ?, ?, 'done', ?, ?)`,
    );
    const evals = (score: number) => JSON.stringify([{ grade: 'excellent', score }]);
    // The persona tops every board; the humans swap second and third. In the
    // unified 3-row field each board scores 100/50/0, so the humans average
    // 25 each and the persona 100 — a clean field-beating case with no ties
    // to dodge the bug via a boundary coincidence.
    insertBoard.run(t.id, humanA.id, 1, 100, evals(1.0));
    insertBoard.run(t.id, humanB.id, 1, -100, evals(0.0));
    insertBoard.run(t.id, persona.id, 1, 500, evals(1.0));
    insertBoard.run(t.id, humanA.id, 2, -100, evals(0.0));
    insertBoard.run(t.id, humanB.id, 2, 100, evals(1.0));
    insertBoard.run(t.id, persona.id, 2, 500, evals(1.0));

    // sanity: everyone else in the pool really is below the persona's value.
    const rows = standings(t.id);
    expect(rows.find((s) => s.userId === humanA.id)?.totalPct).toBe(25);
    expect(rows.find((s) => s.userId === humanB.id)?.totalPct).toBe(25);
    expect(rows.find((s) => s.userId === persona.id)?.totalPct).toBe(100);

    const stats = await viewer.get(`/api/users/${persona.id}/stats`);
    expect(stats.user.kind).toBe('ai');
    expect(stats.totals.avgPct).toBe(100);
    expect(stats.totals.avgBidAccuracy).toBe(100);
    expect(stats.percentiles.avgPct).not.toBeNull();
    expect(stats.percentiles.bidAccuracy).not.toBeNull();
    expect(stats.percentiles.avgPct).toBeLessThanOrEqual(100);
    expect(stats.percentiles.bidAccuracy).toBeLessThanOrEqual(100);
    // the persona is a natural member of the pool it's ranked against, so
    // beating both humans caps out exactly at 100 — not 200.
    expect(stats.percentiles.avgPct).toBe(100);
    expect(stats.percentiles.bidAccuracy).toBe(100);
  });
});
