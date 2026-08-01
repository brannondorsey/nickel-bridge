import { describe, expect, it } from 'vitest';
import { freshDbEnv, makeApp, TestClient } from './helpers.js';

/**
 * Compare (server/src/compare.ts): two records side by side, and the gate that
 * decides which differences are allowed to be called.
 *
 * Seeded by direct board inserts rather than real play, for the same reason
 * tops.test.ts is: the assertions here are about specific sample sizes and
 * specific rates, and two bots playing identically would tie everything at 50%
 * and let every case pass vacuously. The numbers below are chosen so the gate
 * arithmetic can be worked by hand in the comments.
 */
freshDbEnv('compare');

const { db } = await import('../src/db.js');
const { COMPARE_MIN_BOARDS, GATE_SIGMA } = await import('../src/compare.js');

const mkTournament = (name: string) =>
  (
    db
      .prepare(`INSERT INTO tournaments (name, seed, difficulty) VALUES (?, ?, 'intermediate') RETURNING id`)
      .get(name, `${name}-seed`) as { id: number }
  ).id;

const mkUser = (handle: string) =>
  (
    db
      .prepare(`INSERT INTO users (google_id, name, handle, handle_key) VALUES (?, ?, ?, ?) RETURNING id`)
      .get(`dev:${handle}`, handle, handle, handle.toLowerCase()) as { id: number }
  ).id;

const insert = db.prepare(
  `INSERT INTO boards (tournament_id, user_id, board_no, state, score_ns, bid_evals, contract, tricks_declarer, updated_at)
   VALUES (?, ?, ?, 'done', ?, ?, ?, ?, ?)`,
);

const EXCELLENT = JSON.stringify([{ grade: 'excellent', score: 1 }]);
const FAIR = JSON.stringify([{ grade: 'fair', score: 0.4 }]);

/** A declaring contract for the human's side (declarer 0 = North, an even seat). */
const declaring = (level: number) => JSON.stringify({ level, strain: 4, declarer: 0, doubled: false, redoubled: false });

/**
 * Give `user` `n` completed boards, alternating grades so the score histogram
 * has real spread, with `declared` of them as declaring contracts of which
 * `made` succeed. Boards are spread across tournaments of four.
 */
function seedRecord(user: number, n: number, opts: { declared: number; made: number; score: number }) {
  let declaredLeft = opts.declared;
  let madeLeft = opts.made;
  for (let i = 0; i < n; i++) {
    const tid = tournamentFor(Math.floor(i / 4));
    const isDeclaring = declaredLeft > 0;
    const made = isDeclaring && madeLeft > 0;
    if (isDeclaring) declaredLeft--;
    if (made) madeLeft--;
    insert.run(
      tid,
      user,
      (i % 4) + 1,
      opts.score,
      i % 2 === 0 ? EXCELLENT : FAIR,
      isDeclaring ? declaring(2) : null,
      isDeclaring ? (made ? 8 : 6) : null,
      1000 + i,
    );
  }
}

// (tournament_id, user_id, board_no) is unique, so a 20-board record needs five
// tournaments of four. Shared across users on purpose — that is what makes two
// seeded players opponents rather than strangers.
const tournaments = new Map<number, number>();
const tournamentFor = (n: number) => {
  if (!tournaments.has(n)) tournaments.set(n, mkTournament(`Compare ${n}`));
  return tournaments.get(n)!;
};

/** A separate pool, for a player who must share no field with the viewer. */
const farTournaments = new Map<number, number>();
const farTournament = (n: number) => {
  if (!farTournaments.has(n)) farTournaments.set(n, mkTournament(`Far ${n}`));
  return farTournaments.get(n)!;
};

describe('compare', () => {
  it('refuses without a session, refuses self-comparison, and 404s an unknown id', async () => {
    const app = await makeApp();
    const anon = new TestClient(app, 'nobody');
    expect((await anon.raw('GET', '/api/compare/1')).statusCode).toBe(401);

    const me = new TestClient(app, 'CmpSelf');
    await me.login();
    const myId = (await me.get('/api/me')).user.id;
    expect((await me.raw('GET', `/api/compare/${myId}`)).statusCode).toBe(400);
    expect((await me.raw('GET', '/api/compare/999999')).statusCode).toBe(404);
    // A non-numeric id must not reach the build either.
    expect((await me.raw('GET', '/api/compare/abc')).statusCode).toBe(404);
  });

  it('reports ineligible without building profiles when either record is thin', async () => {
    const app = await makeApp();
    const me = new TestClient(app, 'CmpThin');
    await me.login();
    const myId = (await me.get('/api/me')).user.id;
    const other = mkUser('CmpThinOther');

    seedRecord(myId, 20, { declared: 8, made: 4, score: 300 });
    seedRecord(other, 4, { declared: 2, made: 1, score: 100 }); // under the floor

    const view = await me.get(`/api/compare/${other}`);
    expect(view.eligible).toBe(false);
    expect(view.minBoards).toBe(COMPARE_MIN_BOARDS);
    expect(view.them.boards).toBe(4);
    expect(view.measures).toEqual([]);
    // The page still gets enough to name both players and explain itself.
    expect(view.them.handle).toBe('CmpThinOther');
  });

  /**
   * The Agresti-Coull guard, which is the whole reason `rateSe` is not the
   * textbook formula. A 2-of-2 declaring record has a naive standard error of
   * EXACTLY ZERO — p(1-p) = 0 — so a 50-point margin against it would clear any
   * gate and be reported as a confident verdict.
   *
   *   naive:  seA = 0, seB = sqrt(.5*.5/20) = .1118  -> gate 11.2pp, margin 50 -> CALLED
   *   shrunk: pA~ = 4/6 = .667, seA = sqrt(.667*.333/6)  = .1925
   *           pB~ = 12/24 = .5, seB = sqrt(.5*.5/24)     = .1021
   *           combined = .2179 -> gate 21.8pp > fullTilt 14 -> SET ASIDE
   *
   * When this was written, 11 of the 24 production players with any declared
   * board sat at exactly 0% or 100%, so this is the common case, not a corner.
   */
  it('does not call a rate built on a boundary sample', async () => {
    const app = await makeApp();
    const me = new TestClient(app, 'CmpBoundary');
    await me.login();
    const myId = (await me.get('/api/me')).user.id;
    const other = mkUser('CmpBoundaryOther');

    seedRecord(myId, 20, { declared: 2, made: 2, score: 300 }); // 100% on two boards
    seedRecord(other, 20, { declared: 20, made: 10, score: 100 }); // 50% on twenty

    const view = await me.get(`/api/compare/${other}`);
    const declaringRow = view.measures.find((m: { key: string }) => m.key === 'declaring');

    expect(declaringRow.a).toBe(100);
    expect(declaringRow.b).toBe(50);
    expect(declaringRow.margin).toBe(50);
    // The raw figure is still printed honestly; only the verdict is withheld.
    expect(declaringRow.verdict).toBe('aside');
    expect(declaringRow.reason).toBe('thin');
    expect(declaringRow.gate).toBeGreaterThan(declaringRow.fullTilt);
    expect(declaringRow.gate).toBeCloseTo(21.8, 0);
  });

  it('sets the rating row aside while either player is provisional', async () => {
    const app = await makeApp();
    const me = new TestClient(app, 'CmpProv');
    await me.login();
    const myId = (await me.get('/api/me')).user.id;
    const other = mkUser('CmpProvOther');
    seedRecord(myId, 20, { declared: 8, made: 5, score: 300 });
    seedRecord(other, 20, { declared: 8, made: 4, score: 100 });

    const view = await me.get(`/api/compare/${other}`);
    const elo = view.measures.find((m: { key: string }) => m.key === 'elo');
    // Neither has any elo_history here, so both are provisional.
    expect(elo.verdict).toBe('aside');
    expect(elo.reason).toBe('provisional');
  });

  it('calls a difference that clears its gate and levels one that does not', async () => {
    const app = await makeApp();
    const me = new TestClient(app, 'CmpCall');
    await me.login();
    const myId = (await me.get('/api/me')).user.id;
    const other = mkUser('CmpCallOther');

    // Identical grade histograms -> identical accuracy -> margin 0 -> level.
    seedRecord(myId, 40, { declared: 20, made: 14, score: 300 });
    seedRecord(other, 40, { declared: 20, made: 6, score: 100 });

    const view = await me.get(`/api/compare/${other}`);
    const acc = view.measures.find((m: { key: string }) => m.key === 'bidAccuracy');
    expect(acc.margin).toBe(0);
    expect(acc.verdict).toBe('level');

    // Declaring: 70% against 30% on twenty boards each.
    //   pA~ = 16/24 = .667 -> se .0962 ; pB~ = 8/24 = .333 -> se .0962
    //   combined .136 -> gate 13.6pp < fullTilt 14, margin 40 -> called
    const decl = view.measures.find((m: { key: string }) => m.key === 'declaring');
    expect(decl.a).toBe(70);
    expect(decl.b).toBe(30);
    expect(decl.verdict).toBe('you');
    expect(decl.gate).toBeLessThan(decl.fullTilt);

    expect(view.tally.you).toBeGreaterThanOrEqual(1);
    expect(view.tally.you + view.tally.them + view.tally.level + view.tally.aside).toBe(view.measures.length);
  });

  it('carries head-to-head when the two have met, and common ground when they have not', async () => {
    const app = await makeApp();
    const me = new TestClient(app, 'CmpMet');
    await me.login();
    const myId = (await me.get('/api/me')).user.id;
    const met = mkUser('CmpMetOther');
    seedRecord(myId, 20, { declared: 8, made: 5, score: 300 });
    seedRecord(met, 20, { declared: 8, made: 4, score: 100 }); // same tournaments, lower scores

    const shared = await me.get(`/api/compare/${met}`);
    expect(shared.headToHead).not.toBeNull();
    expect(shared.headToHead.shared).toBeGreaterThan(0);
    expect(shared.headToHead.ahead).toBe(shared.headToHead.shared); // higher score every crossing
    expect(shared.headToHead.sequence).toContain('you');
    expect(shared.commonGround).toBeNull();

    // Someone whose boards live in tournaments this viewer never touched. Four
    // boards per tournament, since (tournament, user, board_no) is unique.
    const stranger = mkUser('CmpStranger');
    for (let i = 0; i < 20; i++) {
      const far = farTournament(Math.floor(i / 4));
      insert.run(far, stranger, (i % 4) + 1, 200, i % 2 === 0 ? EXCELLENT : FAIR, null, null, 9000 + i);
    }
    const unmet = await me.get(`/api/compare/${stranger}`);
    expect(unmet.headToHead).toBeNull();
    expect(unmet.commonGround).not.toBeNull();
  });

  /**
   * The demo relaxation, which exists because the seeder's bots top out at
   * EIGHT completed boards: at the production floor of 16, every comparison on
   * a preview would show "not enough crossings yet" and the feature would be
   * unreachable in the one environment built to click-test it. That is the same
   * bug that once made the activity feed's `entered-rankings` milestone
   * untestable, so the floor is read from the environment in exactly one place
   * and passed everywhere else as an argument.
   */
  /**
   * Common ground means an opponent BOTH have faced, and never one of the two
   * being compared.
   *
   * Both halves were live bugs. Comparing against a house persona is reachable
   * from the UI — their profiles are public and their board counts clear any
   * floor — and the persona used to appear in its own common-ground panel as a
   * record against itself, every crossing "level". Separately, an `||` filter
   * let a persona only one side had met through, printing "0 of 0" beside a
   * real record: a player who never played reads as one who lost every time,
   * which is the single misreading this screen exists to prevent.
   */
  it('never lists a compared player, or a persona only one side has faced, as common ground', async () => {
    const app = await makeApp();
    const me = new TestClient(app, 'CmpHouse');
    await me.login();
    const myId = (await me.get('/api/me')).user.id;

    // Two personas: one only the viewer has faced, one nobody has.
    const shark = mkUser('The Shark');
    db.prepare(`UPDATE users SET kind = 'ai' WHERE id = ?`).run(shark);
    const novice = mkUser('The Novice');
    db.prepare(`UPDATE users SET kind = 'ai' WHERE id = ?`).run(novice);

    seedRecord(myId, 20, { declared: 8, made: 5, score: 300 });
    // The Shark shares the viewer's tournaments, but not the target's.
    seedRecord(shark, 20, { declared: 8, made: 4, score: 100 });

    // A target in tournaments of its own, so there is no head-to-head at all.
    const stranger = mkUser('CmpHouseStranger');
    for (let i = 0; i < 20; i++) {
      insert.run(farTournament(100 + Math.floor(i / 4)), stranger, (i % 4) + 1, 200, EXCELLENT, null, null, 5000 + i);
    }

    const view = await me.get(`/api/compare/${stranger}`);
    expect(view.headToHead).toBeNull();
    // The Shark is the viewer's opponent alone, so he is not common ground.
    expect(view.commonGround.map((c: { handle: string }) => c.handle)).not.toContain('The Shark');
    expect(view.commonGround).toEqual([]);

    // And comparing directly against a persona must never list that persona.
    const vsShark = await me.get(`/api/compare/${shark}`);
    const listed = (vsShark.commonGround ?? []).map((c: { userId: number }) => c.userId);
    expect(listed).not.toContain(shark);
    expect(listed).not.toContain(myId);
  });

  it('sends an unbounded gate as null rather than a broken number', async () => {
    const app = await makeApp();
    const me = new TestClient(app, 'CmpGate');
    await me.login();
    const myId = (await me.get('/api/me')).user.id;
    const other = mkUser('CmpGateOther');
    // No slam contracts on either side, so that row's rate has n = 0.
    seedRecord(myId, 20, { declared: 4, made: 2, score: 300 });
    seedRecord(other, 20, { declared: 4, made: 3, score: 100 });

    const view = await me.get(`/api/compare/${other}`);
    const slam = view.measures.find((m: { key: string }) => m.key === 'contract:slam');
    // JSON.stringify(Infinity) is null anyway — this pins that the type says so.
    expect(slam.gate).toBeNull();
    expect(slam.verdict).toBe('aside');
    for (const m of view.measures) {
      expect(m.gate === null || Number.isFinite(m.gate)).toBe(true);
    }
  });

  it('relaxes the board floor under DEMO so the exhibits can reach a real comparison', async () => {
    const { compareMin, COMPARE_MIN_BOARDS, DEMO_COMPARE_MIN_BOARDS } = await import('../src/compare.js');
    expect(compareMin()).toBe(COMPARE_MIN_BOARDS);
    const prior = process.env.DEMO;
    process.env.DEMO = '1';
    try {
      expect(compareMin()).toBe(DEMO_COMPARE_MIN_BOARDS);
      // Below the demo seeder's eight-board ceiling, or the exhibits stay dead.
      expect(DEMO_COMPARE_MIN_BOARDS).toBeLessThanOrEqual(8);
    } finally {
      if (prior === undefined) delete process.env.DEMO;
      else process.env.DEMO = prior;
    }
  });

  it('exposes the gate multiplier as a single constant', () => {
    // Pinned so that changing it is a deliberate edit with a failing test
    // attached, not a silent shift in how confident the page sounds.
    expect(GATE_SIGMA).toBe(1.0);
  });
});
