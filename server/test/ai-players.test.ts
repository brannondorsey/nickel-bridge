import { describe, expect, it } from 'vitest';
import { freshDbEnv, makeApp, playBoard, TestClient } from './helpers.js';

/**
 * Benchmark AI personas (ai-players.ts): identity, the shadow-row contract
 * (AI rows can NEVER move a human number — standings, per-board pcts, Elo),
 * replay determinism, and the placement exclusions that keep the grace
 * window and popularity scoring human-only.
 *
 * freshDbEnv sets AI_PLAYERS=0 for every other suite; this one turns the
 * feature back on — it's the thing under test.
 */
freshDbEnv('ai-players');
process.env.AI_PLAYERS = '1';

const { matchpoints } = await import('@bridge/core');
const { db } = await import('../src/db.js');
const { AI_PLAYER_HANDLES, ensureAiPlayers, enqueueAiField, whenAiPlayersIdle } = await import('../src/ai-players.js');
const { myBoardSummaries, placeUser, recomputeElo, standings } = await import('../src/tournaments.js');

const log = { info() {}, error(...a: unknown[]) { throw a[0]; }, warn() {}, debug() {} } as never;

interface DoneRow {
  user_id: number;
  board_no: number;
  calls: string;
  plays: string;
  score_ns: number | null;
}

const aiBoards = (tid: number): DoneRow[] =>
  db
    .prepare(
      `SELECT b.user_id, b.board_no, b.calls, b.plays, b.score_ns FROM boards b
       JOIN users u ON u.id = b.user_id AND u.kind = 'ai'
       WHERE b.tournament_id = ? ORDER BY b.user_id, b.board_no`,
    )
    .all(tid) as DoneRow[];

const eloHistory = () => db.prepare(`SELECT user_id, tournament_id, before, after FROM elo_history ORDER BY id`).all();

describe('benchmark AI players', () => {
  let tid = 0;

  it('ensureAiPlayers is idempotent and survives handle collisions', () => {
    // a human already owns "A Beginner" — the persona must suffix, not steal
    db.prepare(`INSERT INTO users (google_id, name, handle, handle_key) VALUES ('dev:squatter', 'S', 'A Beginner', 'a beginner')`).run();
    const first = ensureAiPlayers();
    const again = ensureAiPlayers();
    for (const tier of ['beginner', 'intermediate', 'expert'] as const) {
      expect(first[tier].kind).toBe('ai');
      expect(again[tier].id).toBe(first[tier].id);
    }
    expect(first.beginner.handle).toBe(`${AI_PLAYER_HANDLES.beginner} 2`);
    expect(first.expert.handle).toBe(AI_PLAYER_HANDLES.expert);
  });

  it(
    'personas play a placed tournament; human numbers are untouched by their rows',
    { timeout: 240_000 },
    async () => {
      const app = await makeApp();
      const alice = new TestClient(app, 'Alice');
      const bob = new TestClient(app, 'Bob');
      await alice.login();
      await bob.login();

      // Placement creates the tournament (ai_field = 1) and the route
      // enqueues the personas; both humans then play it to completion.
      tid = (await alice.post('/api/play')).tournamentId;
      expect((await bob.post('/api/play')).tournamentId).toBe(tid); // grace-joined despite AI rows to come
      for (let no = 1; no <= 4; no++) {
        await playBoard(alice, tid, no);
        await playBoard(bob, tid, no);
      }
      await whenAiPlayersIdle();

      const rows = standings(tid);
      const humans = rows.filter((s) => s.kind === 'human');
      const ais = rows.filter((s) => s.kind === 'ai');
      expect(humans).toHaveLength(2);
      expect(ais).toHaveLength(3);
      expect(ais.every((s) => s.complete && s.boardsDone === 4 && s.rank === undefined)).toBe(true);
      expect(ais.every((s) => s.totalPct !== null)).toBe(true);
      // interleaved list stays pct-sorted
      const pcts = rows.map((s) => s.totalPct ?? -1);
      expect([...pcts].sort((a, b) => b - a)).toEqual(pcts);

      // phantom insertion, checked against raw board-1 scores
      const board1 = db
        .prepare(
          `SELECT b.score_ns, u.kind, b.user_id FROM boards b JOIN users u ON u.id = b.user_id
           WHERE b.tournament_id = ? AND b.board_no = 1 AND b.state = 'done'`,
        )
        .all(tid) as { score_ns: number; kind: string; user_id: number }[];
      const humanScores = board1.filter((r) => r.kind === 'human').map((r) => r.score_ns);
      for (const ai of board1.filter((r) => r.kind === 'ai')) {
        const phantom = matchpoints([...humanScores, ai.score_ns]);
        const summaries = myBoardSummaries(tid, ai.user_id);
        expect(summaries[0].pct).not.toBeNaN(); // persona's own summary view stays functional
        expect(phantom[phantom.length - 1].pct).toBeGreaterThanOrEqual(0);
      }

      // THE shadow-row contract: delete every AI row, recompute — every
      // human-facing number must be byte-identical.
      const humansBefore = humans.map((s) => ({ ...s }));
      const aliceBoardsBefore = myBoardSummaries(tid, humansBefore[0].userId);
      const eloBefore = eloHistory();
      expect(eloBefore.length).toBeGreaterThan(0); // two complete humans → rated

      const wiped = db.transaction(() => {
        db.prepare(`DELETE FROM boards WHERE user_id IN (SELECT id FROM users WHERE kind = 'ai')`).run();
        recomputeElo();
      });
      wiped();
      expect(standings(tid).filter((s) => s.kind === 'human')).toEqual(humansBefore);
      expect(myBoardSummaries(tid, humansBefore[0].userId)).toEqual(aliceBoardsBefore);
      expect(eloHistory()).toEqual(eloBefore);
    },
  );

  it('replay after a wipe (and after an interrupted board) is byte-identical', { timeout: 240_000 }, async () => {
    // the previous test deleted all AI boards — replay from scratch
    enqueueAiField(tid, log);
    await whenAiPlayersIdle();
    const first = aiBoards(tid);
    expect(first).toHaveLength(12);

    // simulate a crash mid-board: truncate one persona's last board
    const victim = first[3];
    db.prepare(`UPDATE boards SET state = 'playing', plays = '[]', bid_evals = '[]' WHERE tournament_id = ? AND user_id = ? AND board_no = ?`).run(
      tid,
      victim.user_id,
      victim.board_no,
    );
    enqueueAiField(tid, log);
    await whenAiPlayersIdle();
    expect(aiBoards(tid)).toEqual(first);
  });

  it('excludes personas from leaderboard and stats pools', async () => {
    const app = await makeApp();
    const alice = new TestClient(app, 'Alice');
    await alice.login();
    const { leaderboard } = await alice.get('/api/leaderboard');
    const aiIds = new Set(Object.values(ensureAiPlayers()).map((u) => u.id));
    expect(leaderboard.some((r: { id: number }) => aiIds.has(r.id))).toBe(false);

    const aliceId = (leaderboard as { id: number; handle: string }[]).find((r) => r.handle === 'Alice')!.id;
    const stats = await alice.get(`/api/users/${aliceId}/stats`);
    expect(stats.percentiles.activePlayers).toBe(2); // Alice + Bob, no personas
    expect(stats.pctSeries[0].fieldSize).toBe(2);
  });

  it('keeps placement grace and popularity human-only despite AI rows', () => {
    const now = Math.floor(Date.now() / 1000);
    const personas = ensureAiPlayers();
    // fresh young tournament: 1 human starter + all 3 personas done
    const t = db
      .prepare(
        `INSERT INTO tournaments (name, seed, difficulty, created_at, ai_field) VALUES ('T', 'grace-seed', 'intermediate', ?, 1) RETURNING id`,
      )
      .get(now - 3600) as { id: number };
    const human = db
      .prepare(`INSERT INTO users (google_id, name, difficulty) VALUES ('dev:grace-h', 'H', 'intermediate') RETURNING id`)
      .get() as { id: number };
    db.prepare(`INSERT INTO boards (tournament_id, user_id, board_no) VALUES (?, ?, 1)`).run(t.id, human.id);
    for (const tier of ['beginner', 'intermediate', 'expert'] as const) {
      for (let no = 1; no <= 4; no++) {
        db.prepare(
          `INSERT INTO boards (tournament_id, user_id, board_no, state, score_ns) VALUES (?, ?, ?, 'done', 100)`,
        ).run(t.id, personas[tier].id, no);
      }
    }
    const second = db
      .prepare(`INSERT INTO users (google_id, name, difficulty) VALUES ('dev:grace-h2', 'H2', 'intermediate') RETURNING id`)
      .get() as { id: number };
    // Unfixed counts would see starters = 4 (grace full) and done_players = 3
    // (instant popularity magnet); human-only counts grace-join the second
    // human into the same boards.
    const placed = placeUser(second.id, 'intermediate', { nowSec: now, rng: () => 0.5 });
    expect(placed.tournament.id).toBe(t.id);
  });
});
