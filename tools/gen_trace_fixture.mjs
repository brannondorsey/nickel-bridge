#!/usr/bin/env node
/**
 * Regenerate the robot-determinism golden trace (server/test/fixtures/robot-trace.json).
 *
 * The trace pins the exact auction, play, contract, and score the robots
 * produce on a fixed seed when the human always passes and always plays their
 * first legal card. server/test/game.test.ts replays it and fails on any
 * difference — identical robots on identical deals is the fairness invariant
 * of duplicate scoring, so a diff here must be a *deliberate* robot change.
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
const t = db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('trace', ?) RETURNING *`).get(TRACE_SEED);

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
  });
  console.log(`board ${no}: ${view.result.contractLabel} score ${b.row.score_ns}`);
}

const out = new URL('../server/test/fixtures/robot-trace.json', import.meta.url).pathname;
writeFileSync(out, JSON.stringify({ seed: TRACE_SEED, strategy: 'human passes; plays first legal card', boards }, null, 1));
console.log(`wrote ${out}`);
rmSync(dbDir, { recursive: true, force: true });
