import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { freshDbEnv } from './helpers.js';

freshDbEnv('game');

const { db } = await import('../src/db.js');
const game = await import('../src/game.js');

const here = dirname(fileURLToPath(import.meta.url));

let userId = 0;
beforeAll(() => {
  userId = (
    db.prepare(`INSERT INTO users (google_id, name) VALUES ('dev:tester','Tester') RETURNING id`).get() as {
      id: number;
    }
  ).id;
});

function makeTournament(seed: string) {
  return db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t', ?) RETURNING *`).get(seed) as any;
}

async function loadBoardFor(seed: string, boardNo: number) {
  const t = makeTournament(seed);
  const b = game.loadBoard(t, userId, boardNo, true)!;
  await game.ensureAdvanced(b);
  return { t, b };
}

/** Drive to completion; human strategy mirrors the golden-trace convention. */
async function driveBoard(t: any, b: any, callFor: (view: any) => number = () => 0): Promise<any[]> {
  const views: any[] = [];
  let view = game.boardView(t, b, 1200);
  views.push(view);
  let safety = 250;
  while (view.state !== 'done' && safety-- > 0) {
    if (view.state === 'bidding' && view.myTurn) await game.submitCall(b, callFor(view));
    else if (view.state === 'playing' && view.myTurn) await game.submitPlay(b, (view.legalCards as number[])[0]);
    else throw new Error(`stuck: ${view.state} myTurn=${view.myTurn}`);
    view = game.boardView(t, b, 1200);
    views.push(view);
  }
  return views;
}

describe('declarer scenarios (pinned seeds)', () => {
  it('E/W declares: human defends South only, robots never stall', async () => {
    const { t, b } = await loadBoardFor('hunt-0', 1);
    const views = await driveBoard(t, b);
    expect(b.contract!.declarer % 2).toBe(1); // E or W
    const playViews = views.filter((v) => v.state === 'playing');
    expect(playViews.every((v) => v.flipped === false)).toBe(true);
    // whenever it was our turn, the hand to play was South
    for (const v of playViews.filter((v2) => v2.myTurn)) expect(v.handToPlay).toBe(2);
    expect(b.row.score_ns).toBe(-280); // deterministic outcome for this seed
  });

  it('North declares: board flips and the human plays both N and dummy S', async () => {
    const { t, b } = await loadBoardFor('hunt-0', 3);
    const views = await driveBoard(t, b);
    expect(b.contract!.declarer).toBe(0);
    const playViews = views.filter((v) => v.state === 'playing');
    expect(playViews.every((v) => v.flipped === true && v.playingSeat === 0)).toBe(true);
    const handsPlayed = new Set(playViews.filter((v) => v.myTurn).map((v) => v.handToPlay));
    expect(handsPlayed).toEqual(new Set([0, 2])); // both declarer hand and dummy
    expect(b.row.score_ns).toBe(-150);
  });

  it('South declares: human plays South and dummy North, no flip', async () => {
    const { t, b } = await loadBoardFor('hunt2-2', 4);
    let bidOnce = true;
    const views = await driveBoard(t, b, (view) => {
      if (bidOnce && view.legalCalls.includes(7)) {
        bidOnce = false;
        return 7; // 1NT
      }
      return 0;
    });
    expect(b.contract).toMatchObject({ declarer: 2, strain: 4, level: 1 });
    const playViews = views.filter((v) => v.state === 'playing');
    expect(playViews.every((v) => v.flipped === false)).toBe(true);
    const handsPlayed = new Set(playViews.filter((v) => v.myTurn).map((v) => v.handToPlay));
    expect(handsPlayed).toEqual(new Set([0, 2]));
  });

  it('passed-out board completes with zero score and no contract', async () => {
    const { b } = await loadBoardFor('hunt-1', 1);
    // all four players pass; ensureAdvanced already ran the robots
    if (b.row.state !== 'done') await game.submitCall(b, 0);
    expect(b.row.state).toBe('done');
    expect(b.contract).toBeNull();
    expect(b.row.score_ns).toBe(0);
    expect(b.row.tricks_declarer).toBeNull();
  });
});

describe('board completion side effects', () => {
  it('completing all boards for two users rates them without any close step', async () => {
    const t = makeTournament('elo-side-effect');
    const other = (
      db.prepare(`INSERT INTO users (google_id, name) VALUES ('dev:tester2','Tester2') RETURNING id`).get() as {
        id: number;
      }
    ).id;
    for (const uid of [userId, other]) {
      for (let no = 1; no <= 4; no++) {
        const b = game.loadBoard(t, uid, no, true)!;
        await game.ensureAdvanced(b);
        // second user bids once on board 2 so results differ
        let bidOnce = uid === other;
        await driveBoard(t, b, (view) => {
          if (bidOnce && no === 2) {
            const bid = (view.legalCalls as number[]).find((a) => a >= 3);
            if (bid !== undefined) {
              bidOnce = false;
              return bid;
            }
          }
          return 0;
        });
      }
    }
    const history = db
      .prepare(`SELECT COUNT(*) AS n FROM elo_history WHERE tournament_id = ?`)
      .get(t.id) as { n: number };
    expect(history.n).toBe(2);
  });
});

describe('robot determinism golden trace', () => {
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures/robot-trace.json'), 'utf8'));

  it('replays byte-identically (fairness invariant of duplicate scoring)', async () => {
    for (const expected of fixture.boards) {
      const { t, b } = await loadBoardFor(fixture.seed, expected.boardNo);
      await driveBoard(t, b);
      expect(b.calls, `board ${expected.boardNo} auction`).toEqual(expected.calls);
      expect(b.plays, `board ${expected.boardNo} play`).toEqual(expected.plays);
      expect(b.contract).toEqual(expected.contract);
      expect(b.row.score_ns).toBe(expected.scoreNS);
    }
  }, 30000);

  it('is reproducible within the same process (same seed → same trace)', async () => {
    const first = await loadBoardFor(fixture.seed, 1);
    await driveBoard(first.t, first.b);
    const second = await loadBoardFor(fixture.seed, 1);
    await driveBoard(second.t, second.b);
    expect(second.b.calls).toEqual(first.b.calls);
    expect(second.b.plays).toEqual(first.b.plays);
  });
});
