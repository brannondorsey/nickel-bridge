#!/usr/bin/env node
/**
 * Generate the first-crossing tour's practice board (web/src/onboarding/board0.json).
 *
 * The tour (web/src/onboarding) replays one deal through the REAL Board UI —
 * exported BiddingPhase/PlayPhase fed captured BoardView snapshots — so
 * everything the player sees must be genuine engine output: robot calls and
 * cards from the real model/DDS, bid meanings from core's SAYC explainer,
 * grades from the real Bidder.evaluate, matchpoints from the real field
 * scorer with the three benchmark personas as the pre-seeded field. This
 * tool produces that capture offline, exactly like gen_trace_fixture.mjs /
 * find_scenarios.mjs drive the engine for their fixtures.
 *
 * Search mode sweeps candidate seeds for a teachable board 3 (dealer South):
 * the "human" follows the model's own choice at every call — so every grade
 * is honestly "the robot's choice too" — and plays DD-optimal cards, and a
 * seed qualifies when that line is the canonical teaching shape:
 *   1M by S · pass · a raise from partner with an exact SAYC meaning ·
 *   pass · 4M by S · passed out · S declares (no flip case on the very
 *   first board), and declarer comes home with the contract made.
 *
 * Usage (from repo root, after npm run build):
 *   node tools/gen_tour_board.mjs --search --prefix crossing- --count 200
 *   node tools/gen_tour_board.mjs --seed crossing-17 --write
 *
 * The narration in web/src/onboarding/script.ts is hand-curated against the
 * emitted capture (call values, card values, trick shape); the tour's guard
 * test fails loudly if this file is regenerated onto a different line — same
 * re-curate-by-hand contract as server/src/scenarios.ts recipes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'bridge-tour-'));
process.env.DB_PATH = join(dbDir, 'tour.db');
process.env.LOG_LEVEL = 'silent';
process.env.AI_PLAYERS = '0';

const { db } = await import('../server/dist/db.js');
const game = await import('../server/dist/game.js');
const botPlay = await import('../server/dist/bot-play.js');
const aiPlayers = await import('../server/dist/ai-players.js');
const ai = await import('../packages/ai/dist/index.js');

const BOARD_NO = 3; // dealer South — the tour opens with "the auction starts with you"
const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const userId = db.prepare(`INSERT INTO users (google_id, name, handle, handle_key) VALUES ('dev:tour','You','You','you') RETURNING id`).get().id;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const cardName = (c) => `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}`;
const CALLS = ['Pass', 'X', 'XX'];
const callName = (c) => (c < 3 ? CALLS[c] : `${Math.floor((c - 3) / 5) + 1}${['♣', '♦', '♥', '♠', 'NT'][(c - 3) % 5]}`);

/**
 * Drive one board with the model-following human (model-argmax calls,
 * DD-optimal cards), capturing the view + action at every human decision.
 */
async function captureRun(seed) {
  // The "#0" matters: the web's tournamentNo() reads it, so the receipt's
  // postmark cancels the practice board as TOURNAMENT Nº0.
  const t = db
    .prepare(`INSERT INTO tournaments (name, seed) VALUES (?, ?) RETURNING *`)
    .get('Practice crossing #0', seed);
  const b = game.loadBoard(t, userId, BOARD_NO, true);
  await game.ensureAdvanced(b);

  const steps = [];
  let view = game.boardView(t, b, 1200);
  let safety = 250;
  while (view.state !== 'done' && safety-- > 0) {
    if (view.state === 'bidding' && view.myTurn) {
      const call = game.bidder.chooseCall(b.deal, b.calls);
      const evaluation = await game.submitCall(b, call);
      steps.push({ kind: 'call', view, action: call, evaluation });
    } else if (view.state === 'playing' && view.myTurn) {
      const card = await ai.chooseCard(b.deal, b.contract, b.plays);
      if (!view.legalCards.includes(card)) throw new Error('DD card not legal?');
      await game.submitPlay(b, card);
      steps.push({ kind: 'card', view, action: card });
    } else {
      throw new Error(`stuck: ${view.state}`);
    }
    view = game.boardView(t, b, 1200);
  }
  if (safety <= 0) throw new Error('runaway');
  return { t, b, steps, final: view };
}

/** The canonical teaching shape — see the doc comment. */
function teachable({ b, steps, final }) {
  const calls = steps.filter((s) => s.kind === 'call').map((s) => s.action);
  if (calls.length !== 2) return null;
  const [open, game4] = calls;
  const strain = (open - 3) % 5;
  if (open < 3 || Math.floor((open - 3) / 5) + 1 !== 1 || (strain !== 2 && strain !== 3)) return null; // 1♥/1♠
  if (Math.floor((game4 - 3) / 5) + 1 !== 4 || (game4 - 3) % 5 !== strain) return null; // 4 of the same major
  if (b.calls.length !== 8 || b.calls.filter((c) => c === 0).length !== 6) return null; // 1M P raise P 4M P P P
  const raise = b.calls[2];
  const raiseMeaning = final.auction[2]?.meaning;
  if (!raiseMeaning?.exact) return null; // partner's raise must be a named SAYC convention
  if (b.contract?.declarer !== 2) return null; // South declares — no flip on board №0
  if (final.result.scoreNS <= 0) return null; // the first crossing should come home
  // both graded calls must be the model's own choice (they are by construction,
  // but a guardrail-vs-argmax disagreement can break it — check anyway)
  if (!steps.filter((s) => s.kind === 'call').every((s) => s.evaluation.bestCall === s.action)) return null;
  return { open, raise, game4, made: final.result.tricksDeclarer };
}

function summarize({ b, steps, final }) {
  const hand = (cards) => cards.map(cardName).join(' ');
  console.log(`  auction: ${b.calls.map(callName).join(' ')}  →  ${final.result.contractLabel}, score ${final.result.scoreNS}`);
  console.log(`  south:  ${hand(steps[0].view.hand)}   (${steps[0].view.hcp} HCP)`);
  const decisions = steps.map((s, i) => `${i}:${s.kind === 'call' ? callName(s.action) : cardName(s.action)}${s.view.legalCards?.length === 1 ? '(forced)' : ''}`);
  console.log(`  human decisions: ${decisions.join(' ')}`);
  const ph = final.playHistory ?? [];
  ph.slice(0, 3).forEach((trick, i) => {
    console.log(`  trick ${i + 1}: ${trick.map((p) => `${'NESW'[p.seat]}:${cardName(p.card)}`).join(' ')}`);
  });
}

if (has('search')) {
  const prefix = opt('prefix', 'crossing-');
  const count = Number(opt('count', 100));
  for (let i = 0; i < count; i++) {
    const seed = `${prefix}${i}`;
    const t0 = Date.now();
    try {
      const run = await captureRun(seed);
      const fit = teachable(run);
      const line = `${run.b.calls.map(callName).join(' ')} → ${run.final.result.contractLabel} ${run.final.result.scoreNS} (${((Date.now() - t0) / 1000).toFixed(0)}s)`;
      console.log(`${fit ? '✓' : ' '} ${seed}: ${line}`);
      if (fit) summarize(run);
    } catch (e) {
      console.log(`  ${seed}: ERROR ${e.message}`);
    }
  }
  rmSync(dbDir, { recursive: true, force: true });
  process.exit(0);
}

const seed = opt('seed');
if (!seed) {
  console.error('pass --search or --seed <seed> [--write]');
  process.exit(1);
}

const run = await captureRun(seed);
const fit = teachable(run);
console.log(fit ? `teachable ✓` : `NOT teachable — inspect before shipping`);
summarize(run);

// The pre-seeded field: the three benchmark personas play the same board at
// their real tiers under their real persona seeds (identical machinery to
// ai-players.ts's units — bidder noise, sampled-DD belief, play noise), so
// the ledger the tour teaches duplicate with is a genuine matchpoint field.
const personas = aiPlayers.ensureAiPlayers();
for (const tier of ['beginner', 'intermediate', 'expert']) {
  const seedBase = `${run.t.seed}:ai:${tier}`;
  const strategy = {
    call: (b) =>
      game.bidder.chooseCall(b.deal, b.calls, {
        difficulty: tier,
        seed: ai.bidDecisionSeed(seedBase, b.row.board_no, b.calls.length),
      }),
    card: (b) =>
      ai.chooseCardSampled(b.deal, b.contract, b.plays, {
        k: ai.MC_SAMPLES[tier].kOpp,
        useAuction: ai.MC_SAMPLES[tier].auctionAware,
        playTopN: ai.PLAY_NOISE[tier].topN,
        seed: ai.mcDecisionSeed(seedBase, b.row.board_no, b.plays.length),
        dealer: b.deal.dealer,
        calls: b.calls,
      }),
  };
  await botPlay.playSingleBoard(run.t, personas[tier].id, BOARD_NO, strategy);
  console.log(`  ${personas[tier].handle} played board ${BOARD_NO}`);
}

// Recapture the final view — the field now includes the house rows.
const finalBoard = game.loadBoard(run.t, userId, BOARD_NO, false);
const final = game.boardView(run.t, finalBoard, 1200);
console.log(`  field: ${final.result.field.map((f) => `${f.handle} ${f.contract} ${f.scoreNS} → ${f.pct}%`).join(' · ')}`);

if (has('write')) {
  // Intermediate decision views carry only what the live phases render;
  // result-only payloads (allHands, playHistory, accumulated evals) stay on
  // the final view. Tour-irrelevant identifiers are normalized so nothing
  // leaks about the temp database the capture ran in.
  const strip = (view) => {
    const { allHands, playHistory, bidEvals, result, ...rest } = view;
    return { ...rest, bidEvals: [] };
  };
  const out = {
    seed,
    boardNo: BOARD_NO,
    steps: run.steps.map((s) => ({ ...s, view: strip(s.view) })),
    final,
  };
  const path = new URL('../web/src/onboarding/board0.json', import.meta.url).pathname;
  writeFileSync(path, JSON.stringify(out));
  console.log(`wrote ${path} (${JSON.stringify(out).length} bytes)`);
}

rmSync(dbDir, { recursive: true, force: true });
