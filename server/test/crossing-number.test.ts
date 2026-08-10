import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Type-only, so it is erased at runtime and does NOT run db.ts's migrations
// before the fixture below is written — the dynamic import further down is
// what does that, deliberately.
import type { TournamentRow } from '../src/db.js';

/**
 * Crossing display numbers — db.ts's `number` column, its backfill migration,
 * and assignCrossingNumber().
 *
 * Tested against a replica of production's actual shape rather than a toy
 * table, because the bug it fixes only appears when rehearsals are INTERLEAVED
 * with tournaments in the shared id sequence: production held 88 standard rows
 * whose ids ran to 100, with 13 rehearsals scattered through the gaps. A
 * fixture that appends the rehearsals at the end would renumber correctly even
 * with an off-by-one ordinal, so the interleaving is the whole test.
 *
 * The migration runs at db.ts import time, so the file has to be built and
 * populated BEFORE the dynamic import below — which also means this must stay
 * its own test file (vitest isolates the module registry per file, and db.ts
 * is a singleton that would otherwise already be initialized by a sibling).
 */
const dir = mkdtempSync(join(tmpdir(), 'bridge-crossingno-'));
const DB_PATH = join(dir, 'test.db');

// Pre-migration shape: the old naming rule (name = '#' || id), 88 standard
// rows and 13 rehearsals sharing one id sequence.
//
// `kind` is seeded here rather than left to db.ts's own migration, and that is
// load-bearing: that migration adds the column with DEFAULT 'standard', which
// would relabel the rehearsals as tournaments before the renumber ever saw
// them. Production has carried `kind` since the rehearsal work, so a table
// that already has it is the honest fixture — and it means the assertions
// below run against db.ts's REAL migration statement rather than a copy of it
// pasted into this file, which is the only version worth testing.
const seed = new Database(DB_PATH);
seed.exec(`
  CREATE TABLE tournaments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    seed TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'standard',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);
const REHEARSAL_IDS = new Set([75, 76, 77, 78, 79, 81, 82, 84, 88, 89, 90, 92, 101]);
const ins = seed.prepare(`INSERT INTO tournaments (id, name, seed, kind) VALUES (?, ?, 'seed', ?)`);
const standardIds: number[] = [];
for (let id = 1; id <= 101; id++) {
  const rehearsal = REHEARSAL_IDS.has(id);
  ins.run(id, `Tournament #${id}`, rehearsal ? 'rehearsal' : 'standard');
  if (!rehearsal) standardIds.push(id);
}
seed.close();

// Importing db.ts is what runs the migration under test.
process.env.DB_PATH = DB_PATH;
const { db, createCrossing } = await import('../src/db.js');

const rowOf = (id: number) =>
  db.prepare(`SELECT name, number FROM tournaments WHERE id = ?`).get(id) as {
    name: string;
    number: number | null;
  };
const nameOf = (id: number) => rowOf(id).name;
/** every display number worn by more than one row — the thing that must always be empty */
const duplicates = () =>
  db
    .prepare(
      `SELECT number FROM tournaments WHERE number IS NOT NULL GROUP BY number HAVING COUNT(*) > 1`,
    )
    .all();
/** what a real creation site passes to createCrossing: its own INSERT, nothing more */
const insertStandard = () =>
  db
    .prepare(`INSERT INTO tournaments (name, seed, kind) VALUES ('Tournament', 's', 'standard') RETURNING *`)
    .get() as TournamentRow;
const newCrossing = () => createCrossing(insertStandard);
const standardCount = () =>
  (db.prepare(`SELECT COUNT(*) AS n FROM tournaments WHERE kind = 'standard'`).get() as { n: number }).n;
/** standard rows carrying no display number — must always be empty */
const unnumbered = () =>
  db.prepare(`SELECT id FROM tournaments WHERE kind = 'standard' AND number IS NULL`).all();

describe('the backfill', () => {
  it('renumbers standard tournaments 1..N with no gaps', () => {
    expect(standardIds.length).toBe(88);
    const names = standardIds.map((id) => nameOf(id));
    expect(names).toEqual(standardIds.map((_, i) => `Tournament #${i + 1}`));
  });

  it('closes the gap production actually had: id 100 is crossing #88', () => {
    expect(nameOf(100)).toBe('Tournament #88');
    // ...and the first id after a rehearsal does not skip a number.
    expect(nameOf(74)).toBe('Tournament #74'); // last id before the first rehearsal
    expect(nameOf(80)).toBe('Tournament #75'); // 5 rehearsals (75-79) consumed no numbers
  });

  it('leaves rehearsals out of the sequence entirely', () => {
    for (const id of REHEARSAL_IDS) {
      expect(rowOf(id)).toEqual({ name: `Tournament #${id}`, number: null }); // name untouched
    }
  });

  it('stores the number alongside the name it renders into', () => {
    for (const id of [1, 74, 80, 100]) {
      const { name, number } = rowOf(id);
      expect(name).toBe(`Tournament #${number}`);
    }
  });

  it('leaves the structure its own guard keys on, so a second boot skips it', () => {
    // Deliberately NOT a sentinel-corruption check: db.ts runs once per
    // process, so nothing in this file can actually re-enter the migration.
    // What CAN be asserted is the post-state the `!tournamentColumns.has(...)`
    // guard reads on the next boot — the same structural test every other
    // migration in that file uses, and the reason this one needs no
    // PRAGMA user_version stamp.
    const columns = (db.prepare(`PRAGMA table_info(tournaments)`).all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('number');
    const index = (db.prepare(`PRAGMA index_list(tournaments)`).all() as { name: string; unique: number }[]).find(
      (i) => i.name === 'idx_tournaments_number',
    );
    expect(index?.unique).toBe(1);
  });
});

describe('createCrossing', () => {
  it('continues the sequence the backfill wrote, and returns the stamped row', () => {
    const stamped = newCrossing();
    // The returned row is the post-UPDATE one, so a caller cannot go on
    // holding the `number: null` row its INSERT ... RETURNING * produced.
    expect({ name: stamped.name, number: stamped.number }).toEqual({ name: 'Tournament #89', number: 89 });
    expect(rowOf(stamped.id)).toEqual({ name: 'Tournament #89', number: 89 });
  });

  it('commits the row and its number together, or neither', () => {
    // The INSERT runs inside createCrossing's transaction precisely so this
    // cannot leave a half-made crossing behind. Outside it, the INSERT commits
    // on its own and any failure before the stamp — a throw, a crash, or a
    // future creation site that simply forgets the second call — strands a
    // standard tournament with number NULL, which then renders as its raw id.
    const before = standardCount();
    expect(() =>
      createCrossing(() => {
        insertStandard();
        throw new Error('crash between INSERT and stamp');
      }),
    ).toThrow(/crash between/);
    expect(standardCount()).toBe(before); // the row went with it
    expect(unnumbered()).toEqual([]);
  });

  it('skips to a gap rather than reusing a number when a standard row is deleted', () => {
    // THE reason this is a MAX+1 sequence and not a COUNT of the rows before
    // it. Nothing in the app deletes a standard tournament today, so a count
    // would be correct today — but it is correct only for as long as that
    // holds, and it fails by handing the next crossing a number another one is
    // already displaying, silently and with nothing to catch it. Deleting the
    // row here stands in for whatever eventually does it: a retention job, an
    // account deletion, a hand-edit on the Fly volume.
    const before = db.prepare(`SELECT MAX(number) AS n FROM tournaments`).get() as { n: number };
    db.prepare(`DELETE FROM tournaments WHERE number = 40`).run();

    expect(newCrossing().number).toBe(before.n + 1); // a gap where #40 was, never a reissue
    expect(duplicates()).toEqual([]);
  });

  it('refuses to hand the same number out twice', () => {
    // The unique index is what makes the paragraph above a guarantee rather
    // than a promise: anything that would duplicate a number — a second
    // writer, a restored backup, a bad hand-edit — raises here instead of
    // shipping two crossings wearing it.
    const t = newCrossing();
    expect(() => db.prepare(`UPDATE tournaments SET number = 88 WHERE id = ?`).run(t.id)).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('never numbers a rehearsal, so discarding one cannot move a crossing', () => {
    const before = duplicates();
    const reh = (db.prepare(
      `INSERT INTO tournaments (name, seed, kind) VALUES ('rehearsal', 's', 'rehearsal') RETURNING id`,
    ).get() as { id: number }).id;
    const max = (db.prepare(`SELECT MAX(number) AS n FROM tournaments`).get() as { n: number }).n;
    db.prepare(`DELETE FROM tournaments WHERE id = ?`).run(reh);

    expect(newCrossing().number).toBe(max + 1);
    expect(duplicates()).toEqual(before);
  });
});
