import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'bridge-standings-')), 'test.db');

// dynamic imports so DB_PATH is set before the db module initializes
const { db } = await import('../src/db.js');
const { STANDINGS, standings } = await import('../src/tournaments.js');

const NOW = Math.floor(Date.now() / 1000);
const days = (n: number) => n * 86400;

function addUser(name: string): number {
  return (
    db
      .prepare(`INSERT INTO users (google_id, name, handle, handle_key) VALUES (?, ?, ?, ?) RETURNING id`)
      .get(`dev:${name}`, name, name, name.toLowerCase()) as { id: number }
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

describe('standings — abandoned partial players', () => {
  it('drops a partial player whose last completed board is past the abandon TTL', () => {
    const tid = addTournament();
    const alice = addUser('alice'); // completes everything, recently
    const bob = addUser('bob'); // partial, recently active — stays visible
    const carol = addUser('carol'); // partial, stale — dropped

    for (let no = 1; no <= 4; no++) finishBoard(tid, alice, no, 100, NOW);
    finishBoard(tid, bob, 1, 100, NOW - days(1));
    finishBoard(tid, carol, 1, -100, NOW - (STANDINGS.ABANDON_TTL_S + days(1)));

    const list = standings(tid);
    expect(list.map((s) => s.userId).sort()).toEqual([alice, bob].sort());
    expect(list.find((s) => s.userId === carol)).toBeUndefined();
  });

  it("a stale player's board score still shapes other players' matchpoints on that board", () => {
    const tid = addTournament();
    const alice = addUser('alice2');
    const carol = addUser('carol2');

    finishBoard(tid, alice, 1, 100, NOW);
    finishBoard(tid, carol, 1, -100, NOW - (STANDINGS.ABANDON_TTL_S + days(1)));

    const list = standings(tid);
    expect(list.map((s) => s.userId)).toEqual([alice]);
    // alice beat carol's -100 on board 1 — a 100% board — even though carol
    // (stale) never shows up in the returned field herself.
    expect(list[0].totalPct).toBe(100);
  });

  it('a stale player reappears immediately after finishing another board', () => {
    const tid = addTournament();
    const dave = addUser('dave');

    finishBoard(tid, dave, 1, 100, NOW - (STANDINGS.ABANDON_TTL_S + days(1)));
    expect(standings(tid).find((s) => s.userId === dave)).toBeUndefined();

    finishBoard(tid, dave, 2, 100, NOW);
    const list = standings(tid);
    expect(list.find((s) => s.userId === dave)?.boardsDone).toBe(2);
  });
});
