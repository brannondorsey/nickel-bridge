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

  it('first-crossing onboarding stamp: null for new accounts, write-once via POST', async () => {
    const nora = new TestClient(app, 'Nora');
    await nora.login();
    expect((await nora.get('/api/me')).user.onboardedAt).toBeNull();

    await nora.post('/api/me/onboarded');
    const stamped = (await nora.get('/api/me')).user.onboardedAt;
    expect(typeof stamped).toBe('number');

    // idempotent: re-walking the tour from /tour never moves the stamp
    await nora.post('/api/me/onboarded');
    expect((await nora.get('/api/me')).user.onboardedAt).toBe(stamped);
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

  it('excludes handle-less signups from the leaderboard, and keeps them out (provisional) once registered', async () => {
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

    // still provisional: 0 rated tournaments is well under the quota, so a
    // brand-new player at the ELO_INITIAL default can't outrank proven players
    ({ leaderboard } = await kate.get('/api/leaderboard'));
    expect(leaderboard.some((r: { handle: string }) => r.handle === 'Judy')).toBe(false);
    const judyView = await judy.get('/api/leaderboard');
    expect(judyView.yourRatedTournaments).toBe(0);
    expect(judyView.provisionalMin).toBe(4);
  });

  // The ladder reads without an account (App.tsx's isPublicPath) — it's the
  // social proof a visitor who hasn't signed up should be able to see. Only
  // the "…and where do you sit?" field has an anonymous case, and it must come
  // back null rather than 0: the client prints a "you'll join the field once
  // you've completed N crossings — x of N so far" note off that number, and 0
  // would say that to somebody with no record to be provisional about.
  it('serves the leaderboard to a caller with no session, minus the you-shaped field', async () => {
    const anon = new TestClient(app, 'LurkerAnon');
    const res = await anon.raw('GET', '/api/leaderboard');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.yourRatedTournaments).toBeNull();
    expect(body.provisionalMin).toBe(4);
    // the ladder itself is identical to what a signed-in caller sees
    expect(body.leaderboard).toEqual((await alice.get('/api/leaderboard')).leaderboard);
  });

  /**
   * "Name on the ladder" (the settings tab): the ladder is the ONLY thing
   * about a human that reads signed out, so this one flag is the whole of
   * "can a stranger see me". It applies to anonymous callers only — the field
   * you are matchpointed against always sees who is in it.
   *
   * Rated-tournament rows are inserted directly rather than played: the route
   * hides anyone under PROVISIONAL_MIN_TOURNAMENTS (4), and playing sixteen
   * boards to reach it would test the placement machinery, not this filter.
   */
  it('omits an unlisted player from the anonymous ladder only, and renumbers around them', async () => {
    const nina = new TestClient(app, 'Nina');
    const oscar = new TestClient(app, 'Oscar');
    await nina.login();
    await oscar.login();
    const ninaId = (await nina.get('/api/me')).user.id;
    const oscarId = (await oscar.get('/api/me')).user.id;

    const { tournamentId } = await oscar.post('/api/play');
    const rate = db.prepare(`INSERT INTO elo_history (user_id, tournament_id, before, after) VALUES (?, ?, ?, ?)`);
    for (const id of [ninaId, oscarId]) for (let i = 0; i < 4; i++) rate.run(id, tournamentId, 1200, 1200);

    const handles = (body: { leaderboard: { handle: string }[] }) => body.leaderboard.map((r) => r.handle);
    expect(handles(await nina.get('/api/leaderboard'))).toContain('Nina');
    expect(handles(JSON.parse((await new TestClient(app, 'Anon1').raw('GET', '/api/leaderboard')).body))).toContain(
      'Nina',
    );

    expect((await nina.post('/api/me/prefs', { ladderListed: false })).ladderListed).toBe(false);
    expect((await nina.get('/api/me')).user.ladderListed).toBe(false);

    // signed in — everyone, Nina included, still sees the full field
    expect(handles(await nina.get('/api/leaderboard'))).toContain('Nina');
    expect(handles(await oscar.get('/api/leaderboard'))).toContain('Nina');

    // signed out — she is simply absent, and the rows that remain are the
    // ones the client numbers 1..n, so no gap advertises that she opted out
    const anonBody = JSON.parse((await new TestClient(app, 'Anon2').raw('GET', '/api/leaderboard')).body);
    expect(handles(anonBody)).not.toContain('Nina');
    expect(handles(anonBody)).toContain('Oscar');

    // and it is reversible
    await nina.post('/api/me/prefs', { ladderListed: true });
    expect(handles(JSON.parse((await new TestClient(app, 'Anon3').raw('GET', '/api/leaderboard')).body))).toContain(
      'Nina',
    );
  });

  it('patches preferences one key at a time, and refuses anything it does not recognise', async () => {
    const pete = new TestClient(app, 'Pete');
    await pete.login();

    // defaults, and a partial patch leaves the untouched key alone
    let me = await pete.get('/api/me');
    expect([me.user.ladderListed, me.user.fastForward, me.user.bidFeedback]).toEqual([true, true, true]);
    expect(me.user.ownMeaningsHidden).toBe(false); // unlike the other three, this one defaults OFF
    expect(await pete.post('/api/me/prefs', { fastForward: false })).toEqual({
      ladderListed: true,
      fastForward: false,
      bidFeedback: true,
      ownMeaningsHidden: false,
    });
    await pete.post('/api/me/prefs', { ladderListed: false });
    me = await pete.get('/api/me');
    expect([me.user.ladderListed, me.user.fastForward, me.user.bidFeedback]).toEqual([false, false, true]);

    // an empty patch is a legal no-op; a bad type or an unknown key is not,
    // so a typo can't look like a successful write
    expect(await pete.post('/api/me/prefs', {})).toEqual({
      ladderListed: false,
      fastForward: false,
      bidFeedback: true,
      ownMeaningsHidden: false,
    });
    expect((await pete.raw('POST', '/api/me/prefs', { fastForward: 'yes' })).statusCode).toBe(400);
    expect((await pete.raw('POST', '/api/me/prefs', { fastForwrad: true })).statusCode).toBe(400);
    expect((await pete.get('/api/me')).user.fastForward).toBe(false);

    // bidFeedback patches the same way as the other switches
    expect(await pete.post('/api/me/prefs', { bidFeedback: false })).toEqual({
      ladderListed: false,
      fastForward: false,
      bidFeedback: false,
      ownMeaningsHidden: false,
    });
    expect((await pete.get('/api/me')).user.bidFeedback).toBe(false);

    // ownMeaningsHidden is a plain boolean on the same partial-update path
    expect(await pete.post('/api/me/prefs', { ownMeaningsHidden: true })).toEqual({
      ladderListed: false,
      fastForward: false,
      bidFeedback: false,
      ownMeaningsHidden: true,
    });
    expect((await pete.get('/api/me')).user.ownMeaningsHidden).toBe(true);

    expect(
      (await new TestClient(app, 'AnonSet').raw('POST', '/api/me/prefs', { ladderListed: false })).statusCode,
    ).toBe(401);
  });

  // Play is still the toll: opening the game up to anonymous callers is
  // exactly what this change must NOT do.
  it('still refuses every gated endpoint without a session', async () => {
    const anon = new TestClient(app, 'LurkerGated');
    for (const [method, url] of [
      ['POST', '/api/play'],
      ['GET', '/api/tournaments'],
      ['GET', '/api/tournaments/1'],
      ['GET', '/api/tournaments/1/boards/1'],
      ['POST', '/api/me/onboarded'],
      ['POST', '/api/handle'],
    ] as const) {
      expect((await anon.raw(method, url)).statusCode, `${method} ${url}`).toBe(401);
    }
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
    // rated_tournaments per player stays below the leaderboard's provisional
    // quota this early, so assert directly against elo_history rather than
    // the (now-filtered) public leaderboard list.
    const ratedFor = (tournamentId: number) =>
      (
        db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM elo_history WHERE tournament_id = ?`).get(tournamentId) as {
          n: number;
        }
      ).n;
    expect(ratedFor(tid)).toBe(2);

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
    expect(ratedFor(tid)).toBe(3);
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
