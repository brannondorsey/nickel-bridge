#!/usr/bin/env node
/**
 * Regenerate the robot-determinism golden traces (server/test/fixtures/).
 *
 * A trace pins the exact auction, play, contract, and score the robots produce
 * on a fixed seed when the human always passes and always plays their first
 * legal card — until/unless a laydown claim fires, at which point the server
 * plays out the remaining cards DD-optimally for both sides instead (see
 * `advanceRobots`/`resolveClaim` in server/src/game.ts).
 * server/test/game.test.ts replays these and fails on any difference —
 * identical robots on identical deals is the fairness invariant of duplicate
 * scoring, so a diff here must be a *deliberate* robot change.
 *
 * TWO fixtures, one per claim rule (see db.ts's claim_rule migration), because
 * "tournaments created before the pessimistic gate replay exactly as they did"
 * is now a live promise rather than a theoretical one, and a promise nothing
 * checks is a promise nothing keeps:
 *
 *   robot-trace.json           the shipped gate. A claim fires only once the
 *                              position is settled whatever anybody plays.
 *   robot-trace-optimistic.json  the legacy gate every pre-migration
 *                              tournament still carries.
 *
 * READING A DIFF. Under the legacy rule a claim could only ever REORDER the
 * tail of `plays` — it fires on a position that is already 100% determined
 * double dummy, so the score could not move. That is no longer the whole
 * story for robot-trace.json: the pessimistic gate hands decisions back to
 * the player that the old gate quietly made for them, and this fixture's
 * "human" is a stub that always plays its first legal card — a genuinely bad
 * endgame strategy. So a SCORE change here can be correct. Confirm it is the
 * new line actually earning that score before accepting it.
 * robot-trace-optimistic.json has no such excuse: it should stay byte-frozen
 * unless robot behaviour itself deliberately changed.
 *
 * Usage (from repo root, after npm run build):
 *   node tools/gen_trace_fixture.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'bridge-trace-'));
process.env.DB_PATH = join(dbDir, 'trace.db');
process.env.LOG_LEVEL = 'silent';

const { db } = await import('../server/dist/db.js');
const game = await import('../server/dist/game.js');

export const TRACE_SEED = 'robot-trace-v1';

const userId = db.prepare(`INSERT INTO users (google_id, name) VALUES ('dev:trace','Trace') RETURNING id`).get().id;

/** Play all four boards of a fresh tournament under one claim rule. */
async function trace(claimRule) {
  const t = db
    .prepare(`INSERT INTO tournaments (name, seed, claim_rule) VALUES ('trace', ?, ?) RETURNING *`)
    .get(TRACE_SEED, claimRule);
  const boards = [];
  for (let no = 1; no <= 4; no++) {
    const b = game.loadBoard(t, userId, no, true);
    await game.ensureAdvanced(b);
    let view = game.boardView(t, b, 1200);
    let safety = 250;
    while (view.state !== 'done' && safety-- > 0) {
      if (view.state === 'bidding' && view.myTurn) await game.submitCall(b, 0);
      else if (view.state === 'playing' && view.myTurn) await game.submitPlay(b, view.legalCards[0]);
      else throw new Error('stuck');
      view = game.boardView(t, b, 1200);
    }
    boards.push({
      boardNo: no,
      calls: b.calls,
      plays: b.plays,
      contract: b.contract,
      scoreNS: b.row.score_ns,
      claimedAtPly: b.row.claimed_at_ply,
    });
    console.log(
      `[${claimRule}] board ${no}: ${view.result.contractLabel} score ${b.row.score_ns} claimedAtPly ${b.row.claimed_at_ply}`,
    );
  }
  return boards;
}

for (const [claimRule, file] of [
  ['pessimistic', 'robot-trace.json'],
  ['optimistic', 'robot-trace-optimistic.json'],
]) {
  const boards = await trace(claimRule);
  const out = new URL(`../server/test/fixtures/${file}`, import.meta.url).pathname;
  writeFileSync(
    out,
    JSON.stringify(
      {
        seed: TRACE_SEED,
        claimRule,
        strategy: 'human passes; plays first legal card (until a laydown claim plays the tail DD-optimally)',
        boards,
      },
      null,
      1,
    ),
  );
  console.log(`wrote ${out}`);
}
rmSync(dbDir, { recursive: true, force: true });
