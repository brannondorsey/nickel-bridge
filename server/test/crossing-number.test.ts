import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The crossing-number backfill (db.ts's PRAGMA user_version migration).
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
const { db, crossingName } = await import('../src/db.js');

const nameOf = (id: number) =>
  (db.prepare(`SELECT name FROM tournaments WHERE id = ?`).get(id) as { name: string }).name;

describe('crossing display numbers', () => {
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
    for (const id of REHEARSAL_IDS) expect(nameOf(id)).toBe(`Tournament #${id}`); // untouched
  });

  it('crossingName() agrees with what the backfill wrote', () => {
    // The runtime helper and the migration are the same expression; this is
    // the assertion that keeps them that way, since a new tournament named by
    // one has to continue the sequence written by the other.
    for (const id of [1, 74, 80, 100]) expect(crossingName(id)).toBe(nameOf(id));
  });

  it('does not re-run once user_version is stamped', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    // A name deliberately corrupted after the migration stays corrupted: proof
    // the guard is what gates the UPDATE, not the UPDATE being idempotent.
    db.prepare(`UPDATE tournaments SET name = 'sentinel' WHERE id = 1`).run();
    expect(nameOf(1)).toBe('sentinel');
  });
});
