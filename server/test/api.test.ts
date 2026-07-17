import { describe, expect, it } from 'vitest';
import { dealBoard } from '@bridge/core';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

freshDbEnv('api');
const app = await makeApp();
const { db } = await import('../src/db.js');

const alice = new TestClient(app, 'Alice');
const bob = new TestClient(app, 'Bob');
const carol = new TestClient(app, 'Carol');

/**
 * Redaction invariant: while a board is in progress, concealed hands must not
 * be derivable from the payload. Card values may only travel under a fixed
 * whitelist of keys, and every whitelisted list must be a subset of what the
 * viewer is entitled to see (own/playing hand, dummy, cards on the table).
 */
const CARD_LIST_KEYS = new Set(['hand', 'fullHand', 'dummyHand', 'legalCards']);
const NUMBER_LIST_KEYS = new Set([...CARD_LIST_KEYS, 'legalCalls', 'calls', 'probs']);

function numericArrays(node: unknown, path: string, out: { path: string; key: string; values: number[] }[]): void {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => typeof x === 'number')) {
      const key = path.split('.').pop() ?? '';
      out.push({ path, key, values: node as number[] });
    } else {
      node.forEach((x, i) => numericArrays(x, `${path}[${i}]`, out));
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) numericArrays(v, path ? `${path}.${k}` : k, out);
  }
}

function assertRedacted(view: any, seed: string): void {
  if (view.state === 'done') {
    expect(view.allHands).toBeDefined();
    return;
  }
  expect(view.allHands).toBeUndefined();
  expect(view.playHistory).toBeUndefined();

  const deal = dealBoard(seed, view.boardNo);
  const playingSeat = view.playingSeat ?? 2;
  const entitled = new Set<number>([...deal.hands[2], ...deal.hands[playingSeat]]);
  if (view.dummyHand) for (const c of deal.hands[view.dummy]) entitled.add(c);
  for (const t of [...(view.currentTrick ?? []), ...(view.lastTrick ?? [])]) entitled.add(t.card);

  const lists: { path: string; key: string; values: number[] }[] = [];
  numericArrays(view, '', lists);
  for (const { path, key, values } of lists) {
    // every numeric list in the payload must be a known field...
    expect(NUMBER_LIST_KEYS.has(key), `unexpected numeric list "${path}" in in-progress payload`).toBe(true);
    // ...and card-bearing lists may only contain cards the viewer may see
    if (CARD_LIST_KEYS.has(key)) {
      for (const card of values) {
        expect(entitled.has(card), `card ${card} leaked via "${path}"`).toBe(true);
      }
    }
  }
}

describe('auth', () => {
  it('rejects unauthenticated API calls', async () => {
    const anon = new TestClient(app, 'Anon');
    const res = await anon.raw('GET', '/api/tournaments');
    expect(res.statusCode).toBe(401);
    const play = await anon.raw('POST', '/api/play');
    expect(play.statusCode).toBe(401);
  });

  it('dev login creates a session, logout kills it', async () => {
    const eve = new TestClient(app, 'Eve');
    await eve.login();
    const me = await eve.get('/api/me');
    expect(me.user.handle).toBe('Eve');
    await eve.post('/auth/logout');
    const after = await eve.get('/api/me');
    expect(after.user).toBeNull();
  });
});

describe('handle (first-login username)', () => {
  it('starts null and gates game routes until claimed', async () => {
    const frank = new TestClient(app, 'Frank');
    await frank.post('/auth/dev', { name: frank.name });
    const me = await frank.get('/api/me');
    expect(me.user.handle).toBeNull();

    const blocked = await frank.raw('POST', '/api/play');
    expect(blocked.statusCode).toBe(403);

    await frank.post('/api/handle', { handle: 'Frank' });
    const after = await frank.get('/api/me');
    expect(after.user.handle).toBe('Frank');

    const allowed = await frank.raw('POST', '/api/play');
    expect(allowed.statusCode).toBe(200);
  });

  it('excludes handle-less signups from the leaderboard, then includes them once they register', async () => {
    const kate = new TestClient(app, 'Kate');
    await kate.login();
    const judy = new TestClient(app, 'Judy');
    await judy.post('/auth/dev', { name: judy.name }); // signed in, never claims a handle

    let { leaderboard } = await kate.get('/api/leaderboard');
    expect(leaderboard.every((r: { handle: string | null }) => r.handle !== null)).toBe(true);
    expect(leaderboard.some((r: { handle: string }) => r.handle === 'Judy')).toBe(false);

    // registration itself is untouched by the leaderboard filter — Judy can
    // still complete onboarding at any point after her initial sign-in
    await judy.post('/api/handle', { handle: 'Judy' });
    const me = await judy.get('/api/me');
    expect(me.user.handle).toBe('Judy');

    ({ leaderboard } = await kate.get('/api/leaderboard'));
    const judyRow = leaderboard.find((r: { handle: string }) => r.handle === 'Judy');
    expect(judyRow).toBeTruthy();
    expect(judyRow.elo).toBe(1200);
  });

  it('rejects invalid handles', async () => {
    const grace = new TestClient(app, 'Grace');
    await grace.post('/auth/dev', { name: grace.name });

    const empty = await grace.raw('POST', '/api/handle', { handle: '   ' });
    expect(empty.statusCode).toBe(400);

    const withControlChar = await grace.raw('POST', '/api/handle', { handle: 'ab\u0000cd' });
    expect(withControlChar.statusCode).toBe(400);

    const tooLong = await grace.raw('POST', '/api/handle', { handle: 'x'.repeat(25) });
    expect(tooLong.statusCode).toBe(400);

    const unicode = await grace.raw('POST', '/api/handle', { handle: '\u96ea\u3060\u308b\u307e\u2603\ufe0f' });
    expect(unicode.statusCode).toBe(200);
    expect((await grace.get('/api/me')).user.handle).toBe('\u96ea\u3060\u308b\u307e\u2603\ufe0f');
  });

  it('enforces case-insensitive uniqueness', async () => {
    const heidi = new TestClient(app, 'Heidi');
    const ivan = new TestClient(app, 'Ivan');
    await heidi.post('/auth/dev', { name: heidi.name });
    await ivan.post('/auth/dev', { name: ivan.name });

    await heidi.post('/api/handle', { handle: 'Skywalker' });
    const conflict = await ivan.raw('POST', '/api/handle', { handle: 'SKYWALKER' });
    expect(conflict.statusCode).toBe(409);

    const ok = await ivan.raw('POST', '/api/handle', { handle: 'Skywalker2' });
    expect(ok.statusCode).toBe(200);
  });
});

describe('tournament lifecycle over the API', () => {
  let tid = 0;
  let seed = '';

  it('JIT-places the first player into a fresh tournament', async () => {
    await alice.login();
    await bob.login();
    await carol.login();
    const placement = await alice.post('/api/play');
    tid = placement.tournamentId;
    expect(placement.boardNo).toBe(1);
    seed = (db.prepare(`SELECT seed FROM tournaments WHERE id = ?`).get(tid) as { seed: string }).seed;
  });

  it('alice plays all four boards; payloads stay redacted throughout', async () => {
    for (let no = 1; no <= 4; no++) {
      const seen = await playBoard(alice, tid, no);
      for (const view of seen) assertRedacted(view, seed);
    }
    const list = await alice.get('/api/tournaments');
    expect(list.tournaments[0].myDone).toBe(4);
  });

  it('resumes an unfinished tournament before joining/creating others', async () => {
    const b = await bob.post('/api/play');
    expect(b.tournamentId).toBe(tid); // grace window: young + under-filled → force-joined
    await playBoard(bob, tid, 1);
    const again = await bob.post('/api/play');
    expect(again).toEqual({ tournamentId: tid, boardNo: 2 }); // resumes, not a new one
    for (let no = 2; no <= 4; no++) await playBoard(bob, tid, no);
  });

  it('identical deals and complementary matchpoints for identical play', async () => {
    const a1 = await alice.get(`/api/tournaments/${tid}/boards/1`);
    const b1 = await bob.get(`/api/tournaments/${tid}/boards/1`);
    expect(a1.allHands).toEqual(b1.allHands);
    const pcts = b1.result.field.map((f: any) => f.pct);
    expect(pcts.length).toBe(2);
    expect(pcts[0] + pcts[1]).toBeCloseTo(100, 1);
  });

  it('rates the tournament immediately (continuous Elo) and re-ranks on late join', async () => {
    let lb = (await alice.get('/api/leaderboard')).leaderboard;
    expect(lb.filter((r: any) => r.rated_tournaments === 1).length).toBe(2);

    // carol late-joins the same evergreen tournament with a different auction
    const c = await carol.post('/api/play');
    expect(c.tournamentId).toBe(tid);
    for (let no = 1; no <= 4; no++) {
      let bidOnce = no === 1;
      await playBoard(carol, tid, no, {
        call: (view) => {
          if (bidOnce) {
            bidOnce = false;
            return view.legalCalls.find((a: number) => a >= 3) ?? 0;
          }
          return 0;
        },
      });
    }
    lb = (await carol.get('/api/leaderboard')).leaderboard;
    expect(lb.filter((r: any) => r.rated_tournaments === 1).length).toBe(3);
    const standings = await carol.get(`/api/tournaments/${tid}`);
    expect(standings.standings.filter((s: any) => s.complete).length).toBe(3);
  });

  it('a player who finished everything gets a brand-new tournament', async () => {
    const next = await alice.post('/api/play');
    expect(next.tournamentId).not.toBe(tid);
    expect(next.boardNo).toBe(1);
  });
});

describe('error paths', () => {
  it('rejects out-of-turn and illegal actions with 4xx, done boards with 409', async () => {
    // board 1 of tid is done for alice → any call/play is rejected
    const list = await alice.get('/api/tournaments');
    const doneTid = list.tournaments.find((t: any) => t.myDone === 4).id;
    let res = await alice.raw('POST', `/api/tournaments/${doneTid}/boards/1/call`, { call: 0 });
    expect(res.statusCode).toBe(409);
    res = await alice.raw('POST', `/api/tournaments/${doneTid}/boards/1/play`, { card: 0 });
    expect(res.statusCode).toBe(409);

    // fresh board: illegal call value and illegal card are 400
    const placement = await alice.post('/api/play');
    const view = await alice.get(`/api/tournaments/${placement.tournamentId}/boards/1`);
    expect(view.state).toBe('bidding');
    res = await alice.raw('POST', `/api/tournaments/${placement.tournamentId}/boards/1/call`, { call: 99 });
    expect(res.statusCode).toBe(400);
    const illegal = [...Array(38).keys()].find((a) => !view.legalCalls.includes(a) && a >= 1);
    res = await alice.raw('POST', `/api/tournaments/${placement.tournamentId}/boards/1/call`, { call: illegal });
    expect(res.statusCode).toBe(400);

    // nonexistent board number
    res = await alice.raw('GET', `/api/tournaments/${placement.tournamentId}/boards/9`);
    expect(res.statusCode).toBe(404);
    // nonexistent tournament
    res = await alice.raw('GET', `/api/tournaments/424242/boards/1`);
    expect(res.statusCode).toBe(404);
  });
});
