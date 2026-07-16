#!/usr/bin/env node
/**
 * Offline scenario miner for the demo-mode gallery (server/src/scenarios.ts).
 *
 * The game is deterministic given (seed, boardNo, human actions), so a demo
 * scenario is just a replay recipe: the exact human action list that lands a
 * board one step short of an interesting state. This tool derives those
 * recipes on a dev machine — it is never imported by the server and never
 * runs in a deployment; its findings are pasted into scenarios.ts by hand
 * (labels/descriptions are curated by a human, from the tester's point of
 * view). Two modes:
 *
 * Recorder — replay one board and print every human action with what was
 * observable before/after it (legal calls/cards, state, claim flips), plus
 * the interesting truncation points:
 *   node tools/find_scenarios.mjs --seed hunt-0 --board 3
 *   node tools/find_scenarios.mjs --seed hunt2-2 --board 4 --calls "7"
 *
 * Search — sweep candidate seeds against predicates and print paste-ready
 * Scenario entries (label/description left TODO):
 *   node tools/find_scenarios.mjs --search --prefix demo- --count 50 \
 *     --predicates north-declares,doubled,slam,passed-out,claim,sole-legal,ends-auction,sayc-divergence
 *
 * Human strategy during replay: calls from --calls (space-separated call
 * numbers, consumed in order) then pass; always the first legal card. This
 * mirrors the golden-trace convention so recipes stay tiny and robust.
 *
 * Run `npm run build` first — imports the built server/dist and packages.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'bridge-scenarios-'));
process.env.DB_PATH = join(dbDir, 'scenarios.db');
process.env.LOG_LEVEL = 'silent';

const { db } = await import('../server/dist/db.js');
const game = await import('../server/dist/game.js');
const core = await import('../packages/core/dist/index.js');
const ai = await import('../packages/ai/dist/index.js');

// ---- CLI ----

const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const ALL_PREDICATES = [
  'north-declares',
  'east-declares',
  'west-declares',
  'doubled',
  'slam',
  'passed-out',
  'claim',
  'sole-legal',
  'ends-auction',
  'sayc-divergence',
];

const userId = db
  .prepare(`INSERT INTO users (google_id, name) VALUES ('dev:miner','Miner') RETURNING id`)
  .get().id;
const bidder = new ai.Bidder(ai.loadPolicyModel('sl'));

/**
 * Replay one board to completion with the scripted-calls-then-pass /
 * first-legal-card human strategy, recording each human action and what was
 * observable around it. Returns the trajectory the predicates inspect.
 */
async function replay(seed, boardNo, scriptedCalls = []) {
  const t = db
    .prepare(`INSERT INTO tournaments (name, seed) VALUES (?, ?) RETURNING *`)
    .get(`mine ${seed} #${boardNo} ${Math.floor(Math.random() * 1e9)}`, seed);
  const b = game.loadBoard(t, userId, boardNo, true);
  await game.ensureAdvanced(b);
  const pendingCalls = [...scriptedCalls];
  const actions = []; // { kind, value, before: view snapshot bits, after: {state, claimed} }
  let view = game.boardView(t, b, 1200);
  const claimedBeforeAnyAction = Boolean(b.claimed);
  let safety = 250;
  while (view.state !== 'done' && safety-- > 0) {
    if (!view.myTurn) throw new Error(`stuck: state=${view.state}`);
    const before = {
      state: view.state,
      legalCalls: view.legalCalls ?? null,
      legalCards: view.legalCards ?? null,
    };
    let action;
    if (view.state === 'bidding') {
      let call = 0;
      const scripted = pendingCalls.shift();
      if (scripted !== undefined && view.legalCalls.includes(scripted)) call = scripted;
      await game.submitCall(b, call);
      action = { kind: 'call', value: call, before };
    } else {
      const card = view.legalCards[0];
      await game.submitPlay(b, card);
      action = { kind: 'card', value: card, before };
    }
    action.after = { state: b.row.state, claimed: Boolean(b.claimed) };
    actions.push(action);
    view = game.boardView(t, b, 1200);
  }
  if (safety <= 0) throw new Error('runaway board');
  return { seed, boardNo, board: b, actions, claimedBeforeAnyAction };
}

const callName = (c) => core.callName(c);
const cardName = (c) => core.cardName(c);
const actionLabel = (a) => (a.kind === 'call' ? `call ${a.value} (${callName(a.value)})` : `card ${a.value} (${cardName(a.value)})`);

/** First action index at which the in-process board's claim flag flipped on. */
function claimIndex(traj) {
  if (traj.claimedBeforeAnyAction) return -1; // claimed before the human ever acted — not recipe-able
  return traj.actions.findIndex((a) => a.after.claimed);
}

/** Paste-ready scenarios.ts entry (label/description are curated by hand). */
function emitScenario({ id, seed, boardNo, actions, expect, note }) {
  const list = actions.map((a) => `{ kind: '${a.kind}', value: ${a.value} }`).join(', ');
  console.log(`  // ${note}`);
  console.log(`  {`);
  console.log(`    id: '${id}',`);
  console.log(`    label: 'TODO — tester-facing label',`);
  console.log(`    description: 'TODO — what the tester sees and what to do next',`);
  console.log(`    category: 'TODO',`);
  console.log(`    seed: '${seed}',`);
  console.log(`    boardNo: ${boardNo},`);
  console.log(`    actions: [${list}],`);
  console.log(`    expect: '${expect}',`);
  console.log(`  },`);
}

// ---- predicates: trajectory -> emitted recipe(s) ----

function evaluatePredicates(traj, wanted, counters, maxPer) {
  const { seed, boardNo, board: b, actions } = traj;
  const suffix = `${seed}-b${boardNo}`;
  const contract = b.contract;
  const callActions = actions.filter((a) => a.kind === 'call');
  const found = [];

  const take = (pred) => {
    if (!wanted.includes(pred)) return false;
    if ((counters.get(pred) ?? 0) >= maxPer) return false;
    counters.set(pred, (counters.get(pred) ?? 0) + 1);
    return true;
  };

  // Declarer-seat predicates: the recipe is the auction only — the tester
  // arrives at their first play decision of a board with that table shape.
  const declarerPreds = [
    ['north-declares', 0],
    ['east-declares', 1],
    ['west-declares', 3],
  ];
  for (const [pred, seat] of declarerPreds) {
    if (contract && contract.declarer === seat && take(pred)) {
      found.push({
        id: `${pred}-${suffix}`,
        seed,
        boardNo,
        actions: callActions,
        expect: 'playing',
        note: `${pred}: ${core.contractLabel(contract)} by seat ${seat}`,
      });
    }
  }

  // Contract-shape predicates: the recipe stops one card short of completion
  // so the tester plays the final card and the receipt prints live.
  for (const [pred, match] of [
    ['doubled', contract && (contract.doubled || contract.redoubled)],
    ['slam', contract && contract.level >= 6],
  ]) {
    if (match && b.row.state === 'done' && actions.length > callActions.length && take(pred)) {
      found.push({
        id: `${pred}-${suffix}`,
        seed,
        boardNo,
        actions: actions.slice(0, -1),
        expect: 'playing',
        note: `${pred}: ${core.contractLabel(contract, b.row.tricks_declarer ?? undefined)}, score ${b.row.score_ns}`,
      });
    }
  }

  // Passed out by the human's own final pass: stop before it so the grade
  // toast from that live pass survives into the pass-out result.
  const last = actions[actions.length - 1];
  if (!contract && b.row.state === 'done' && last?.kind === 'call' && take('passed-out')) {
    found.push({
      id: `passed-out-${suffix}`,
      seed,
      boardNo,
      actions: actions.slice(0, -1),
      expect: 'bidding',
      note: 'passed-out: the human’s own pass ends the auction',
    });
  }

  // Claim: stop one action before the submit whose robot continuation flipped
  // the claim flag — the tester's next action triggers the fast-forward live.
  const ci = claimIndex(traj);
  if (ci > 0 && take('claim')) {
    found.push({
      id: `claim-${suffix}`,
      seed,
      boardNo,
      actions: actions.slice(0, ci),
      expect: 'playing',
      note: `claim fires on human action #${ci + 1} (${actionLabel(actions[ci])})`,
    });
  }

  // Sole legal card: stop right at the first human turn that has exactly one
  // legal card, so the tester watches the auto-play hint fire.
  const si = actions.findIndex((a) => a.kind === 'card' && a.before.legalCards?.length === 1);
  if (si > 0 && (ci < 0 || si <= ci) && take('sole-legal')) {
    found.push({
      id: `sole-legal-${suffix}`,
      seed,
      boardNo,
      actions: actions.slice(0, si),
      expect: 'playing',
      note: `sole legal card ${cardName(actions[si].value)} at human action #${si + 1}`,
    });
  }

  // The human's own call flips the board into play: stop before it, so the
  // call response stages the opening lead + dummy tabling live.
  const ei = actions.findIndex((a) => a.kind === 'call' && a.after.state === 'playing');
  if (ei > 0 && take('ends-auction')) {
    found.push({
      id: `ends-auction-${suffix}`,
      seed,
      boardNo,
      actions: actions.slice(0, ei),
      expect: 'bidding',
      note: `human ${actionLabel(actions[ei])} ends the auction into ${contract ? core.contractLabel(contract) : '?'}`,
    });
  }

  // A textbook SAYC call the model itself wouldn't pick (the grade-floor
  // case): stop at that decision; the note names the call the tester makes.
  if (wanted.includes('sayc-divergence')) {
    let seen = 0;
    for (const a of actions) {
      if (a.kind !== 'call') continue;
      for (const call of a.before.legalCalls ?? []) {
        if (call === 0) continue;
        const ev = bidder.evaluate(b.deal, callsBefore(b, seen), call);
        if (ev.saycConsistent && ev.bestCall !== call && take('sayc-divergence')) {
          found.push({
            id: `sayc-divergence-${suffix}`,
            seed,
            boardNo,
            actions: actions.slice(0, seen === 0 ? 0 : actionIndexOfNthCall(actions, seen)),
            expect: 'bidding',
            note: `bid ${callName(call)} (SAYC-consistent, graded ≥ good) — the robot itself prefers ${callName(ev.bestCall)}`,
          });
          break;
        }
      }
      seen++;
    }
  }

  return found;
}

/** The auction as the engine saw it just before the human's nth call. */
function callsBefore(b, nthHumanCall) {
  // b.calls holds the whole auction (robots included). Walk it and count
  // human turns — the human is always South (seat 2).
  const dealer = b.deal.dealer;
  let humanSeen = 0;
  for (let i = 0; i < b.calls.length; i++) {
    if ((dealer + i) % 4 === 2) {
      if (humanSeen === nthHumanCall) return b.calls.slice(0, i);
      humanSeen++;
    }
  }
  return b.calls;
}

/** Index in the action list of the human's nth call action. */
function actionIndexOfNthCall(actions, n) {
  let seen = 0;
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].kind === 'call') {
      if (seen === n) return i;
      seen++;
    }
  }
  return actions.length;
}

// ---- modes ----

try {
  if (has('search')) {
    const prefix = opt('prefix', 'demo-');
    const count = Number(opt('count', '50'));
    const wanted = (opt('predicates') ?? ALL_PREDICATES.join(',')).split(',').map((s) => s.trim());
    const bad = wanted.filter((p) => !ALL_PREDICATES.includes(p));
    if (bad.length) throw new Error(`unknown predicate(s): ${bad.join(', ')} (known: ${ALL_PREDICATES.join(', ')})`);
    const maxPer = Number(opt('max-per-predicate', '3'));
    const counters = new Map();
    console.log(`// mined by tools/find_scenarios.mjs --search --prefix ${prefix} --count ${count}`);
    for (let i = 0; i < count; i++) {
      const seed = `${prefix}${i}`;
      for (let boardNo = 1; boardNo <= 4; boardNo++) {
        const traj = await replay(seed, boardNo);
        for (const s of evaluatePredicates(traj, wanted, counters, maxPer)) emitScenario(s);
      }
      if (wanted.every((p) => (counters.get(p) ?? 0) >= maxPer)) break;
      if ((i + 1) % 10 === 0) console.error(`… ${i + 1}/${count} seeds swept`);
    }
    console.error(`done: ${[...counters.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing found'}`);
  } else {
    const seed = opt('seed');
    const boardNo = Number(opt('board', '1'));
    if (!seed) throw new Error('recorder mode needs --seed <seed> [--board N] [--calls "7 0"]; or use --search');
    const scripted = (opt('calls') ?? '').split(/\s+/).filter(Boolean).map(Number);
    const traj = await replay(seed, boardNo, scripted);
    const { board: b, actions } = traj;
    console.log(`seed ${seed} board ${boardNo}: dealer ${'NESW'[b.deal.dealer]}, ` +
      `${b.contract ? core.contractLabel(b.contract, b.row.tricks_declarer ?? undefined) : 'passed out'}, score ${b.row.score_ns}`);
    actions.forEach((a, i) => {
      const legals = a.kind === 'call'
        ? `legal calls [${a.before.legalCalls.join(' ')}]`
        : `legal cards [${a.before.legalCards.map(cardName).join(' ')}]`;
      console.log(
        `  #${i + 1} ${actionLabel(a)} — ${legals} → ${a.after.state}${a.after.claimed ? ' CLAIMED' : ''}`,
      );
    });
    console.log('\nfull action list:');
    console.log(`  [${actions.map((a) => `{ kind: '${a.kind}', value: ${a.value} }`).join(', ')}]`);
    const ci = claimIndex(traj);
    if (ci >= 0) console.log(`truncate to ${ci} actions for a live claim (fires on #${ci + 1})`);
    const si = actions.findIndex((a) => a.kind === 'card' && a.before.legalCards?.length === 1);
    if (si >= 0) console.log(`truncate to ${si} actions to arrive at a sole-legal-card turn (#${si + 1})`);
    const ei = actions.findIndex((a) => a.kind === 'call' && a.after.state === 'playing');
    if (ei >= 0) console.log(`truncate to ${ei} actions to make the human's own call end the auction (#${ei + 1})`);
    if (b.row.state === 'done') console.log(`truncate to ${actions.length - 1} actions to finish the board live (receipt)`);
  }
} finally {
  rmSync(dbDir, { recursive: true, force: true });
}
