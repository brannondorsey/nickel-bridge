import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Bidder, MC_SAMPLES, chooseCardSampled, loadPolicyModel, mcDecisionSeed, solveFutureTricks } from '@bridge/ai';
import { Contract, Seat, legalCards, partnerOf, playState } from '@bridge/core';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

freshDbEnv('difficulty');

/**
 * Robot-difficulty plumbing: schema defaults, the preference endpoint,
 * difficulty-matched placement, and — the invariant that matters — identical
 * sampled robots for every player on the same non-expert board.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await makeApp();
});

describe('difficulty defaults and preference endpoint', () => {
  it('a bare tournament insert defaults to legacy perfect; a fresh user to intermediate', async () => {
    const { db } = await import('../src/db.js');
    const t = db
      .prepare(`INSERT INTO tournaments (name, seed) VALUES ('legacy', 'legacy-seed') RETURNING *`)
      .get() as any;
    expect(t.difficulty).toBe('perfect');
    expect(t.board_difficulties).toBeNull();

    const alice = new TestClient(app, 'DefaultAlice');
    await alice.login();
    const me = await alice.get('/api/me');
    expect(me.user.difficulty).toBe('intermediate');
  });

  it('POST /api/me/difficulty updates the preference; bad and hidden values 400', async () => {
    const bob = new TestClient(app, 'PrefBob');
    await bob.login();
    const res = await bob.post('/api/me/difficulty', { difficulty: 'beginner' });
    expect(res.user.difficulty).toBe('beginner');
    expect((await bob.get('/api/me')).user.difficulty).toBe('beginner');

    const bad = await bob.raw('POST', '/api/me/difficulty', { difficulty: 'impossible' });
    expect(bad.statusCode).toBe(400);
    // 'perfect' is the internal legacy tier — never player-selectable
    const hidden = await bob.raw('POST', '/api/me/difficulty', { difficulty: 'perfect' });
    expect(hidden.statusCode).toBe(400);
  });
});

describe('difficulty-matched placement', () => {
  it('placement stamps new tournaments with the preference and never mixes tiers', async () => {
    const beg1 = new TestClient(app, 'BegOne');
    await beg1.login();
    await beg1.post('/api/me/difficulty', { difficulty: 'beginner' });
    const placed = await beg1.post('/api/play');
    const t1 = await beg1.get(`/api/tournaments/${placed.tournamentId}`);
    expect(t1.difficulty).toBe('beginner');

    // An expert-pref user placed next must not land in the young beginner
    // tournament, grace window notwithstanding.
    const exp1 = new TestClient(app, 'ExpOne');
    await exp1.login();
    await exp1.post('/api/me/difficulty', { difficulty: 'expert' });
    const expPlaced = await exp1.post('/api/play');
    expect(expPlaced.tournamentId).not.toBe(placed.tournamentId);
    const t2 = await exp1.get(`/api/tournaments/${expPlaced.tournamentId}`);
    expect(t2.difficulty).toBe('expert');

    // A second beginner IS grace-joined into the first beginner tournament.
    const beg2 = new TestClient(app, 'BegTwo');
    await beg2.login();
    await beg2.post('/api/me/difficulty', { difficulty: 'beginner' });
    const joined = await beg2.post('/api/play');
    expect(joined.tournamentId).toBe(placed.tournamentId);
  });

  it('boardView carries the per-board difficulty, and a uniform schedule is stamped at creation', async () => {
    const carol = new TestClient(app, 'ViewCarol');
    await carol.login();
    await carol.post('/api/me/difficulty', { difficulty: 'expert' });
    const placed = await carol.post('/api/play');
    const view = await carol.get(`/api/tournaments/${placed.tournamentId}/boards/1`);
    expect(view.difficulty).toBe('expert');
    const { db } = await import('../src/db.js');
    const row = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(placed.tournamentId) as any;
    expect(JSON.parse(row.board_difficulties)).toEqual(['expert', 'expert', 'expert', 'expert']);
  });

  it('difficulty is a per-board property: a mixed schedule resolves per board', async () => {
    const { db } = await import('../src/db.js');
    const t = db
      .prepare(
        `INSERT INTO tournaments (name, seed, difficulty, board_difficulties)
         VALUES ('mixed', 'mixed-seed', 'expert', ?) RETURNING *`,
      )
      .get(JSON.stringify(['beginner', 'intermediate', 'expert', 'perfect'])) as any;
    const dana = new TestClient(app, 'MixedDana');
    await dana.login();
    const views = [];
    for (let no = 1; no <= 4; no++) views.push(await dana.get(`/api/tournaments/${t.id}/boards/${no}`));
    expect(views.map((v) => v.difficulty)).toEqual(['beginner', 'intermediate', 'expert', 'perfect']);
    const detail = await dana.get(`/api/tournaments/${t.id}`);
    expect(detail.boardDifficulties).toEqual(['beginner', 'intermediate', 'expert', 'perfect']);
  });
});

describe('sampled robots are deterministic across players', () => {
  it('two users replay a beginner board to the identical auction, play, and score', async () => {
    const p1 = new TestClient(app, 'DetOne');
    const p2 = new TestClient(app, 'DetTwo');
    await p1.login();
    await p2.login();
    await p1.post('/api/me/difficulty', { difficulty: 'beginner' });
    await p2.post('/api/me/difficulty', { difficulty: 'beginner' });
    const placed1 = await p1.post('/api/play');
    const placed2 = await p2.post('/api/play');
    expect(placed2.tournamentId).toBe(placed1.tournamentId); // grace-joined

    const seen1 = await playBoard(p1, placed1.tournamentId, 1);
    const seen2 = await playBoard(p2, placed1.tournamentId, 1);
    const last1 = seen1[seen1.length - 1];
    const last2 = seen2[seen2.length - 1];
    expect(last1.auction).toEqual(last2.auction);
    expect(last1.playHistory).toEqual(last2.playHistory);
    expect(last1.contract).toEqual(last2.contract);
    expect(last1.declarerTricks).toEqual(last2.declarerTricks);
  }, 120_000);
});

/**
 * Mirrors game.ts's private humanControls: South always, plus North (the
 * dummy/declarer seat) when N-S is the declaring side. Duplicated here
 * rather than exported from game.ts since it's only needed to walk a
 * completed board's decision sequence from outside advanceRobots.
 */
const HUMAN_SEAT: Seat = 2;
function humanControls(hand: Seat, contract: Contract): boolean {
  if (hand === HUMAN_SEAT) return true;
  return hand === partnerOf(HUMAN_SEAT) && contract.declarer % 2 === HUMAN_SEAT % 2;
}

/**
 * The BID_NOISE/PLAY_NOISE dials (difficulty.ts) only matter if game.ts
 * actually threads (difficulty, seed) into every robot decision — the
 * pre-existing determinism test above can't catch that wiring going missing,
 * since two players seeing identically-ABSENT noise would still agree with
 * each other. This drives a run of beginner boards directly through the game
 * module (bypassing the HTTP layer for easy access to the raw calls/plays
 * arrays), and for every decision the robots actually made, recomputes the
 * noise-OFF counterfactual (pure argmax bidding / playTopN=1 card play) with
 * the exact same seed. Finding at least one real deviation of each kind
 * confirms the noise is live end to end, not silently dead.
 */
describe('bidding and card-play noise are actually wired through advanceRobots', () => {
  it('a run of beginner boards diverges from pure-argmax bidding and pure-best card play at least once each', async () => {
    const { db } = await import('../src/db.js');
    const game = await import('../src/game.js');
    const pureBidder = new Bidder(loadPolicyModel('sl'));
    const userId = (
      db.prepare(`INSERT INTO users (google_id, name) VALUES ('dev:noisecheck', 'NoiseCheck') RETURNING id`).get() as {
        id: number;
      }
    ).id;

    async function driveToEnd(t: any, b: any): Promise<void> {
      await game.ensureAdvanced(b);
      let view = game.boardView(t, b, 1200);
      let safety = 300;
      while (view.state !== 'done' && safety-- > 0) {
        if (view.state === 'bidding' && view.myTurn) await game.submitCall(b, 0);
        else if (view.state === 'playing' && view.myTurn) await game.submitPlay(b, (view.legalCards as number[])[0]);
        else throw new Error(`board stuck: state=${view.state} myTurn=${view.myTurn}`);
        view = game.boardView(t, b, 1200);
      }
      if (view.state !== 'done') throw new Error('board did not finish');
    }

    let bidDeviated = false;
    let cardDeviated = false;
    const BOARDS = 20;

    for (let n = 0; n < BOARDS && (!bidDeviated || !cardDeviated); n++) {
      const t = db
        .prepare(`INSERT INTO tournaments (name, seed, difficulty) VALUES ('noise-check', ?, 'beginner') RETURNING *`)
        .get(`noise-${n}`) as any;
      const b = game.loadBoard(t, userId, 1, true)!;
      await driveToEnd(t, b);

      if (!bidDeviated) {
        for (let i = 0; i < b.calls.length; i++) {
          const seat = ((b.deal.dealer + i) % 4) as Seat;
          if (seat === HUMAN_SEAT) continue; // this drive always passes as South
          const pure = pureBidder.chooseCall(b.deal, b.calls.slice(0, i)); // no opts: noise-off argmax
          if (pure !== b.calls[i]) {
            bidDeviated = true;
            break;
          }
        }
      }

      if (!cardDeviated && b.contract) {
        const contract = b.contract;
        const dummy = partnerOf(contract.declarer);
        for (let i = 0; i < b.plays.length; i++) {
          const prefix = b.plays.slice(0, i);
          const ps = playState(b.deal, contract, prefix);
          if (ps.isOver) break;
          const legal = legalCards(b.deal, ps);
          if (legal.length <= 1) continue; // forced node: no noise possible
          if (humanControls(ps.handToPlay, contract)) continue; // this drive plays the human's own cards
          const actor = ps.handToPlay === dummy ? contract.declarer : ps.handToPlay;
          if (actor === 0) continue; // partner (North) is never subject to PLAY_NOISE

          // Replicate advanceRobots' claim gate: once the position is a 100%
          // laydown for either side, the rest of the hand is played true-DD
          // (chooseCard/resolveClaim), not through the sampled/noisy path —
          // recomputing a "pure" sampled counterfactual past this point would
          // compare against the wrong algorithm entirely, a false signal.
          const solve = await solveFutureTricks(b.deal, contract, prefix);
          const remainingTricks = 13 - ps.completedTricks.length;
          if (solve.bestScore === remainingTricks || solve.bestScore === 0) break;

          const pure = await chooseCardSampled(b.deal, contract, prefix, {
            k: MC_SAMPLES.beginner.kOpp,
            useAuction: MC_SAMPLES.beginner.auctionAware,
            playTopN: 1, // noise-off counterfactual
            seed: mcDecisionSeed(t.seed, b.row.board_no, prefix.length),
            dealer: b.deal.dealer,
            calls: b.calls,
          });
          if (pure !== b.plays[i]) {
            cardDeviated = true;
            break;
          }
        }
      }
    }

    expect(bidDeviated).toBe(true);
    expect(cardDeviated).toBe(true);
  }, 90_000);
});
