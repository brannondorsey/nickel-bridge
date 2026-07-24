import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'bridge-standings-')), 'test.db');

// dynamic imports so DB_PATH is set before the db module initializes
const { db } = await import('../src/db.js');
const { STANDINGS, standings, visibleStandings } = await import('../src/tournaments.js');

const NOW = Math.floor(Date.now() / 1000);
const days = (n: number) => n * 86400;

function addUser(name: string, kind: 'human' | 'ai' = 'human'): number {
  return (
    db
      .prepare(`INSERT INTO users (google_id, name, handle, handle_key, kind) VALUES (?, ?, ?, ?, ?) RETURNING id`)
      .get(`dev:${name}`, name, name, name.toLowerCase(), kind) as { id: number }
  ).id;
}

function addTournament(): number {
  return (db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('T', 'seed') RETURNING id`).get() as {
    id: number;
  }).id;
}

function finishBoard(tournamentId: number, userId: number, boardNo: number, score: number, updatedAt: number): void {
  db.prepare(
    `INSERT INTO boards (tournament_id, user_id, board_no, state, score_ns, updated_at) VALUES (?, ?, ?, 'done', ?, ?)`,
  ).run(tournamentId, userId, boardNo, score, updatedAt);
}

const STALE = STANDINGS.ABANDON_TTL_S + days(1);

describe('standings() — the stats.ts source of truth, never filtered', () => {
  it('keeps a stale partial player, unlike visibleStandings()', () => {
    const tid = addTournament();
    const alice = addUser('alice');
    const carol = addUser('carol');

    finishBoard(tid, alice, 1, 100, NOW);
    finishBoard(tid, carol, 1, -100, NOW - STALE);

    const full = standings(tid);
    expect(full.map((s) => s.userId).sort()).toEqual([alice, carol].sort());

    const visible = visibleStandings(tid);
    expect(visible.map((s) => s.userId)).toEqual([alice]);
  });
});

describe('visibleStandings() — abandoned partial players dropped from the field panel', () => {
  it('drops a partial player whose last completed board is past the abandon TTL', () => {
    const tid = addTournament();
    const alice = addUser('alice2'); // completes everything, recently
    const bob = addUser('bob2'); // partial, recently active — stays visible
    const carol = addUser('carol2'); // partial, stale — dropped

    for (let no = 1; no <= 4; no++) finishBoard(tid, alice, no, 100, NOW);
    finishBoard(tid, bob, 1, 100, NOW - days(1));
    finishBoard(tid, carol, 1, -100, NOW - STALE);

    const list = visibleStandings(tid);
    expect(list.map((s) => s.userId).sort()).toEqual([alice, bob].sort());
    expect(list.find((s) => s.userId === carol)).toBeUndefined();
  });

  it("a stale player's board score still shapes other players' matchpoints on that board", () => {
    const tid = addTournament();
    const alice = addUser('alice3');
    const carol = addUser('carol3');

    finishBoard(tid, alice, 1, 100, NOW);
    finishBoard(tid, carol, 1, -100, NOW - STALE);

    const list = visibleStandings(tid);
    expect(list.map((s) => s.userId)).toEqual([alice]);
    // alice beat carol's -100 on board 1 — a 100% board — even though carol
    // (stale) never shows up in the returned field herself.
    expect(list[0].totalPct).toBe(100);
  });

  it('a stale player reappears immediately after finishing another board', () => {
    const tid = addTournament();
    const dave = addUser('dave2');

    finishBoard(tid, dave, 1, 100, NOW - STALE);
    expect(visibleStandings(tid).find((s) => s.userId === dave)).toBeUndefined();

    finishBoard(tid, dave, 2, 100, NOW);
    const list = visibleStandings(tid);
    expect(list.find((s) => s.userId === dave)?.boardsDone).toBe(2);
  });

  it('never drops a benchmark AI persona, however stale its last board', () => {
    const tid = addTournament();
    const shark = addUser('The Shark', 'ai');

    finishBoard(tid, shark, 1, 100, NOW - STALE);

    const list = visibleStandings(tid);
    expect(list.find((s) => s.userId === shark)).toBeDefined();
  });
});
