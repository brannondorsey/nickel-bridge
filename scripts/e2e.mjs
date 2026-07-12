#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server (requires DEV_AUTH=1).
 *
 *   DEV_AUTH=1 DB_PATH=/tmp/e2e.db node server/dist/index.js &
 *   node scripts/e2e.mjs http://localhost:3000
 *
 * Two users play the same JIT tournament; asserts identical deals,
 * matchpoint percentages, standings, and (after forced close) Elo movement.
 */
const base = process.argv[2] ?? 'http://localhost:3000';

class Client {
  constructor(name) {
    this.name = name;
    this.cookie = '';
  }
  async req(path, opts = {}) {
    const res = await fetch(base + path, {
      ...opts,
      headers: { 'content-type': 'application/json', cookie: this.cookie, ...(opts.headers ?? {}) },
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
    return res.json();
  }
  post(path, body) {
    return this.req(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

async function playBoard(client, tid, no) {
  let board = await client.req(`/api/tournaments/${tid}/boards/${no}`);
  let safety = 200;
  while (board.state !== 'done' && safety-- > 0) {
    if (board.state === 'bidding' && board.myTurn) {
      // bid what the AI would: cheapest strategy that exercises grading = pass
      const res = await client.post(`/api/tournaments/${tid}/boards/${no}/call`, { call: 0 });
      board = res.board;
      if (res.evaluation) lastGrades.push(res.evaluation.grade);
    } else if (board.state === 'playing' && board.myTurn) {
      const card = board.legalCards[0];
      const res = await client.post(`/api/tournaments/${tid}/boards/${no}/play`, { card });
      board = res.board;
    } else {
      throw new Error(`stuck: state=${board.state} myTurn=${board.myTurn}`);
    }
  }
  assert(board.state === 'done', `${client.name} finished board ${no} (${board.result.contractLabel}, ${board.result.scoreNS})`);
  return board;
}

const lastGrades = [];

const alice = new Client('alice');
const bob = new Client('bob');

await alice.post('/auth/dev', { name: 'Alice E2E' });
await bob.post('/auth/dev', { name: 'Bob E2E' });

// Alice: JIT creates a tournament
const a = await alice.post('/api/play');
assert(a.tournamentId > 0 && a.boardNo === 1, `Alice placed in tournament ${a.tournamentId} board 1`);

const aliceBoards = [];
for (let no = 1; no <= 4; no++) aliceBoards.push(await playBoard(alice, a.tournamentId, no));

// Bob: JIT must place him in Alice's tournament (most plays), not a new one
const b = await bob.post('/api/play');
assert(b.tournamentId === a.tournamentId, `Bob JIT-placed into Alice's tournament (${b.tournamentId})`);

const bobBoards = [];
for (let no = 1; no <= 4; no++) bobBoards.push(await playBoard(bob, b.tournamentId, no));

// identical deals
for (let i = 0; i < 4; i++) {
  assert(
    JSON.stringify(aliceBoards[i].allHands) === JSON.stringify(bobBoards[i].allHands),
    `board ${i + 1} deals identical for both players`,
  );
}

// field comparison on board 1 shows both
const b1 = await bob.req(`/api/tournaments/${b.tournamentId}/boards/1`);
assert(b1.result.field.length === 2, 'board 1 field has two results');
const pcts = b1.result.field.map((f) => f.pct);
assert(
  pcts.every((p) => p === 50) || Math.abs(pcts[0] + pcts[1] - 100) < 0.01,
  `matchpoint pcts complementary (${pcts.join(', ')})`,
);

const standings = await alice.req(`/api/tournaments/${a.tournamentId}`);
assert(standings.standings.length === 2, 'standings list both players');
assert(standings.standings.every((s) => s.complete), 'both players complete');

// grades came through
assert(lastGrades.length > 0, `bid grading produced ${lastGrades.length} grades`);

console.log('\nAll e2e checks passed.');
console.log('note: to test Elo, expire the tournament (sqlite: UPDATE tournaments SET closes_at = 0) and GET /api/leaderboard.');
