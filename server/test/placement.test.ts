import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'bridge-placement-')), 'test.db');

// dynamic imports so DB_PATH is set before the db module initializes
const { db } = await import('../src/db.js');
const { PLACEMENT, chooseTournament, placeUser, tournamentScore } = await import('../src/tournaments.js');
type PlacementCandidate = import('../src/tournaments.js').PlacementCandidate;

// A stable "now" for injected clocks. Anchored to the real clock because the
// create path stamps created_at with the DB's unixepoch(); day-scale offsets
// dwarf the seconds of drift a test run adds.
const NOW = Math.floor(Date.now() / 1000);
const days = (n: number) => n * 86400;

let nextId = 1000; // synthetic ids for pure chooseTournament tests
function cand(opts: { donePlayers?: number; starters?: number; ageSec?: number }): PlacementCandidate {
  const id = nextId++;
  return {
    id,
    name: `T${id}`,
    seed: 'seed',
    created_at: NOW - (opts.ageSec ?? 0),
    done_players: opts.donePlayers ?? 0,
    starters: opts.starters ?? 0,
  };
}

function addUser(name: string): number {
  return (
    db.prepare(`INSERT INTO users (google_id, name) VALUES (?, ?) RETURNING id`).get(`dev:${name}`, name) as {
      id: number;
    }
  ).id;
}

function addTournament(name: string, createdAt: number): number {
  // Stamp 'expert' explicitly: these are placement candidates for the
  // placeUser(…, 'expert', …) calls below, and the schema default is the
  // legacy 'perfect' tier, which the difficulty filter would exclude.
  return (
    db
      .prepare(
        `INSERT INTO tournaments (name, seed, difficulty, created_at) VALUES (?, 'seed', 'expert', ?) RETURNING id`,
      )
      .get(name, createdAt) as { id: number }
  ).id;
}

function finishBoards(tournamentId: number, userId: number, count: number): void {
  for (let no = 1; no <= count; no++) {
    db.prepare(`INSERT INTO boards (tournament_id, user_id, board_no, state, score_ns) VALUES (?, ?, ?, 'done', 100)`).run(
      tournamentId,
      userId,
      no,
    );
  }
}

function startBoard(tournamentId: number, userId: number): void {
  db.prepare(`INSERT INTO boards (tournament_id, user_id, board_no, state) VALUES (?, ?, 1, 'bidding')`).run(
    tournamentId,
    userId,
  );
}

const RNG_SWEEP = [0, 0.25, 0.5, 0.75, 0.999];

describe('tournamentScore', () => {
  it('scores a fresh one-finisher tournament exactly at the new-tournament threshold', () => {
    expect(tournamentScore(1, 0)).toBe(PLACEMENT.NEW_TOURNAMENT_SCORE);
  });

  it('grows with finishers and decays with age', () => {
    expect(tournamentScore(3, 0)).toBeGreaterThan(tournamentScore(2, 0));
    expect(tournamentScore(3, days(5))).toBeLessThan(tournamentScore(3, days(1)));
    expect(tournamentScore(0, 0)).toBe(0);
  });
});

describe('chooseTournament', () => {
  it('joins on exact threshold equality but not below it', () => {
    // starters at GRACE_CAP so the grace tier can't claim it
    const atThreshold = cand({ donePlayers: 1, starters: PLACEMENT.GRACE_CAP, ageSec: 0 });
    expect(chooseTournament([atThreshold], NOW, () => 0)?.id).toBe(atThreshold.id);
    // any age > 0 puts a lone finisher below ln 2 → create instead
    const aged = cand({ donePlayers: 1, starters: PLACEMENT.GRACE_CAP, ageSec: days(1) });
    expect(chooseTournament([aged], NOW, () => 0)).toBeNull();
  });

  it('returns null (create) on an empty backlog or nothing above threshold', () => {
    expect(chooseTournament([], NOW, () => 0)).toBeNull();
    const stale = cand({ donePlayers: 2, starters: 5, ageSec: days(25) }); // ln3·e^(-25/30) ≈ 0.48
    expect(chooseTournament([stale], NOW, () => 0)).toBeNull();
  });

  it('grace tier force-joins a young under-filled tournament over a higher-scoring one', () => {
    const popular = cand({ donePlayers: 6, starters: 7, ageSec: days(1) });
    const fresh = cand({ donePlayers: 0, starters: 1, ageSec: 3600 });
    expect(chooseTournament([popular, fresh], NOW, () => 0)?.id).toBe(fresh.id);
  });

  // Grace ordering: rescue, then fill, then freshness. See graceOrder's doc
  // comment for the measurements behind it; these pin the behaviour it
  // describes. The tier ran oldest-first until tools/calibrate_placement.mjs
  // showed that starves boards stuck at one player, so the first test here is
  // deliberately the inverse of the one it replaced.
  it('grace tier rescues a stranded tournament over an older, fuller one', () => {
    const stranded = cand({ starters: 1, ageSec: 3600 });
    const older = cand({ starters: 2, ageSec: 7200 });
    expect(chooseTournament([stranded, older], NOW, () => 0)?.id).toBe(stranded.id);
  });

  it('grace tier fills the fullest when nobody is stranded', () => {
    // Both past the rescue case, so the tie-break that matters is depth: a
    // third player joining the 2-starter board makes a 3-way field, which is
    // worth more than making a second 2-way one.
    const fuller = cand({ starters: 2, ageSec: 7200 });
    const thinner = cand({ starters: 0, ageSec: 3600 });
    expect(chooseTournament([thinner, fuller], NOW, () => 0)?.id).toBe(fuller.id);
  });

  it('grace tier sorts a 0-starter candidate last, since joining it is not a rescue', () => {
    // A 0-starter tournament is one whose creator has not opened a board yet
    // (boards deal lazily). Joining leaves it at one human, so it must lose to
    // both a genuine rescue and a genuine fill.
    const empty = cand({ starters: 0, ageSec: 3600 });
    const stranded = cand({ starters: 1, ageSec: 7200 });
    const fuller = cand({ starters: 3, ageSec: 7200 });
    expect(chooseTournament([empty, stranded, fuller], NOW, () => 0)?.id).toBe(stranded.id);
    expect(chooseTournament([empty, fuller], NOW, () => 0)?.id).toBe(fuller.id);
  });

  it('grace tier prefers the freshest only as a tie-break, never over depth', () => {
    // Freshness is the co-presence lever (players meeting on the same board
    // the same day), but it is the LAST thing consulted: it must not pull a
    // player off a deeper field or away from a rescue.
    const freshThin = cand({ starters: 1, ageSec: 60 });
    const staleThin = cand({ starters: 1, ageSec: 40 * 3600 });
    expect(chooseTournament([staleThin, freshThin], NOW, () => 0)?.id).toBe(freshThin.id);

    const freshShallow = cand({ starters: 2, ageSec: 60 });
    const staleDeep = cand({ starters: 3, ageSec: 40 * 3600 });
    expect(chooseTournament([freshShallow, staleDeep], NOW, () => 0)?.id).toBe(staleDeep.id);
  });

  it('grace ordering is a total order, so placement stays deterministic', () => {
    // Invariant 1 is about robots rather than placement, but a comparator that
    // returns 0 for distinct rows makes the served tournament depend on the
    // input order Array.prototype.sort happens to see. Identical on every
    // field except id must still resolve the same way from any permutation.
    const a = cand({ starters: 2, ageSec: 3600 });
    const b = { ...cand({ starters: 2, ageSec: 3600 }), created_at: a.created_at };
    const lowest = Math.min(a.id, b.id);
    expect(chooseTournament([a, b], NOW, () => 0)?.id).toBe(lowest);
    expect(chooseTournament([b, a], NOW, () => 0)?.id).toBe(lowest);
  });

  it('grace ends at the starter cap and at the TTL', () => {
    const full = cand({ donePlayers: 0, starters: PLACEMENT.GRACE_CAP, ageSec: 3600 });
    expect(chooseTournament([full], NOW, () => 0)).toBeNull(); // score 0 → create
    const expired = cand({ donePlayers: 0, starters: 0, ageSec: PLACEMENT.GRACE_TTL_S });
    expect(chooseTournament([expired], NOW, () => 0)).toBeNull();
  });

  it('weighted-samples within SAMPLE_RATIO of the top score, excluding the rest', () => {
    const a = cand({ donePlayers: 7, starters: 8, ageSec: days(3) }); // ln8·e^(-0.1) ≈ 1.881
    const b = cand({ donePlayers: 5, starters: 6, ageSec: days(3) }); // ln6·e^(-0.1) ≈ 1.621 ≥ 0.8·top
    const c = cand({ donePlayers: 2, starters: 5, ageSec: days(3) }); // ln3·e^(-0.1) ≈ 0.994 < 0.8·top
    const picks = new Set(RNG_SWEEP.map((r) => chooseTournament([c, b, a], NOW, () => r)?.id));
    expect(picks.has(a.id)).toBe(true);
    expect(picks.has(b.id)).toBe(true);
    expect(picks.has(c.id)).toBe(false);
    // rng extremes are deterministic: 0 → top of pool, ~1 → bottom of pool
    expect(chooseTournament([c, b, a], NOW, () => 0)?.id).toBe(a.id);
    expect(chooseTournament([c, b, a], NOW, () => 0.999)?.id).toBe(b.id);
  });

  it('floors the sampling pool at the new-tournament threshold', () => {
    // top ≈ 0.712 (barely above ln 2); runner-up ≈ 0.627 is within 80% of the
    // top but below ln 2 — joining it would be worse than creating fresh.
    const top = cand({ donePlayers: 2, starters: 5, ageSec: days(13) });
    const belowThreshold = cand({ donePlayers: 1, starters: 5, ageSec: days(3) });
    for (const r of RNG_SWEEP) {
      expect(chooseTournament([belowThreshold, top], NOW, () => r)?.id).toBe(top.id);
    }
  });
});

describe('placeUser over the database', () => {
  const rng0 = () => 0;

  it('creates and names a tournament when the backlog is empty', () => {
    const u = addUser('creator');
    const { tournament, nextBoard } = placeUser(u, 'expert', { nowSec: NOW, rng: rng0 });
    // The display number comes off the `number` sequence, not the row id
    // (db.ts's createCrossing). Asserted against the STORED column rather
    // than re-derived here: re-deriving it would restate the implementation
    // and pass no matter what either side did. The rehearsal test below is
    // what tells the number and the id apart.
    const stored = db.prepare(`SELECT number FROM tournaments WHERE id = ?`).get(tournament.id) as {
      number: number | null;
    };
    expect(stored.number).not.toBeNull();
    expect(tournament.name).toBe(`Tournament #${stored.number}`);
    expect(nextBoard).toBe(1);
    db.prepare(`DELETE FROM tournaments WHERE id = ?`).run(tournament.id); // keep later backlogs clean
  });

  it('sends a real arrival to the stranded board, not the oldest one', () => {
    // The whole change, end to end through the DB rather than the pure
    // comparator: under the previous oldest-first rule this player landed on
    // `older` and the board sitting at one human aged out of its grace window
    // alone. Both candidates are inside the window and under the cap, so the
    // ordering is the only thing deciding it.
    const [alone, pair1, pair2, arrival] = ['g-alone', 'g-pair1', 'g-pair2', 'g-arrival'].map(addUser);
    const older = addTournament('older-fuller', NOW - 30 * 3600);
    startBoard(older, pair1);
    startBoard(older, pair2);
    const stranded = addTournament('younger-stranded', NOW - 3600);
    startBoard(stranded, alone);

    const picked = placeUser(arrival, 'expert', { nowSec: NOW, rng: rng0 }).tournament.id;

    // Clean up BEFORE asserting, so later cases in this file see the backlog
    // they expect even when this one fails. Cleanup after the expect() leaks
    // both tournaments on failure and takes four unrelated tests down with it,
    // which turns one honest red into a cascade nobody can read.
    for (const id of [older, stranded]) {
      db.prepare(`DELETE FROM boards WHERE tournament_id = ?`).run(id);
      db.prepare(`DELETE FROM tournaments WHERE id = ?`).run(id);
    }

    expect(picked).toBe(stranded);
  });

  it('numbers crossings past a rehearsal that consumed an id', () => {
    // The bug this guards: `tournaments.id` is one sequence shared by every
    // kind, so each Play-From-Here branch used to push the next tournament's
    // DISPLAYED number up by one. Production reached "Tournament #100" with 88
    // tournaments in existence. The id is still the address — only the name
    // skips the rehearsal.
    const [a, b] = ['numbering-a', 'numbering-b'].map(addUser);
    const first = placeUser(a, 'beginner', { nowSec: NOW, rng: rng0 }).tournament;

    // A rehearsal lands between the two placements and eats an id.
    const branch = db
      .prepare(
        `INSERT INTO tournaments (name, seed, kind, difficulty, origin_tournament_id, origin_board_no, branch_ply)
         VALUES ('rehearsal', 'seed', 'rehearsal', 'beginner', ?, 1, 12) RETURNING id`,
      )
      .get(first.id) as { id: number };

    // b must not be graced into `first` (that would resume, not create), so
    // give it a starter apiece up to the cap and age it past the grace TTL.
    db.prepare(`UPDATE tournaments SET created_at = ? WHERE id = ?`).run(NOW - days(5), first.id);
    const second = placeUser(b, 'beginner', { nowSec: NOW, rng: rng0 }).tournament;

    expect(second.id).toBeGreaterThan(branch.id); // the id sequence did advance
    const no = (t: { name: string }) => Number(t.name.match(/#(\d+)/)![1]);
    expect(no(second)).toBe(no(first) + 1); // ...but the crossing number did not skip
    expect(second.number).toBe(no(second)); // and the name renders the stored column
  });

  it('counts distinct finishers, not total plays', () => {
    const [solo, duoA, duoB, joiner] = ['solo', 'duoA', 'duoB', 'joiner'].map(addUser);
    // both past grace TTL; tSolo has 4 done boards from one player, tDuo has
    // one done board from each of two players
    const tSolo = addTournament('solo-grind', NOW - days(3));
    finishBoards(tSolo, solo, 4);
    const tDuo = addTournament('duo', NOW - days(3));
    finishBoards(tDuo, duoA, 1);
    finishBoards(tDuo, duoB, 1);
    const { tournament } = placeUser(joiner, 'expert', { nowSec: NOW, rng: rng0 });
    expect(tournament.id).toBe(tDuo);
    db.prepare(`DELETE FROM boards WHERE tournament_id IN (?, ?)`).run(tSolo, tDuo);
    db.prepare(`DELETE FROM tournaments WHERE id IN (?, ?)`).run(tSolo, tDuo);
  });

  it('prefers the candidate with the best popularity × recency score', () => {
    const finishers = ['f1', 'f2', 'f3', 'f4', 'f5'].map(addUser);
    const joiner = addUser('score-joiner');
    const tOldPopular = addTournament('old-popular', NOW - days(10));
    for (const f of finishers) finishBoards(tOldPopular, f, 1); // 5 finishers
    const tFreshSmall = addTournament('fresh-small', NOW - days(2.5));
    finishBoards(tFreshSmall, finishers[0], 1);
    finishBoards(tFreshSmall, finishers[1], 1); // 2 finishers, past grace TTL
    expect(tournamentScore(5, days(10))).toBeGreaterThan(tournamentScore(2, days(2.5)));
    const { tournament } = placeUser(joiner, 'expert', { nowSec: NOW, rng: rng0 });
    expect(tournament.id).toBe(tOldPopular);
    db.prepare(`DELETE FROM boards WHERE tournament_id IN (?, ?)`).run(tOldPopular, tFreshSmall);
    db.prepare(`DELETE FROM tournaments WHERE id IN (?, ?)`).run(tOldPopular, tFreshSmall);
  });

  it('archives tournaments beyond the backlog window but still resumes them', () => {
    const veterans = ['v1', 'v2', 'v3'].map(addUser);
    const returner = addUser('returner');
    const tArchived = addTournament('ancient', NOW - days(31));
    for (const v of veterans) finishBoards(tArchived, v, 4); // huge field, out of window
    const fresh = placeUser(returner, 'expert', { nowSec: NOW, rng: rng0 });
    expect(fresh.tournament.id).not.toBe(tArchived);
    // ...but their own unfinished boards in an archived tournament still resume
    finishBoards(tArchived, returner, 2);
    const resumed = placeUser(returner, 'expert', { nowSec: NOW, rng: rng0 });
    expect(resumed.tournament.id).toBe(tArchived);
    expect(resumed.nextBoard).toBe(3);
    db.prepare(`DELETE FROM boards WHERE tournament_id = ?`).run(tArchived);
    db.prepare(`DELETE FROM tournaments WHERE id IN (?, ?)`).run(tArchived, fresh.tournament.id);
  });

  it('funnels requesters into a fresh tournament until the grace cap, then creates', () => {
    const group = ['g1', 'g2', 'g3', 'g4', 'g5'].map(addUser);
    const first = placeUser(group[0], 'expert', { nowSec: NOW, rng: rng0 });
    startBoard(first.tournament.id, group[0]);
    for (const uid of group.slice(1, PLACEMENT.GRACE_CAP)) {
      const placed = placeUser(uid, 'expert', { nowSec: NOW, rng: rng0 });
      expect(placed.tournament.id).toBe(first.tournament.id);
      startBoard(placed.tournament.id, uid);
    }
    // grace cap reached, nobody has finished a board → score 0 → fresh one
    const overflow = placeUser(group[PLACEMENT.GRACE_CAP], 'expert', { nowSec: NOW, rng: rng0 });
    expect(overflow.tournament.id).not.toBe(first.tournament.id);
  });
});
