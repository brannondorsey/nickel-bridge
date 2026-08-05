import { describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

/**
 * The Home rail's medal progress (`/api/me`'s `medals` field, from
 * server/src/medals.ts) and the profile trophy case (`playerStats()`'s
 * `totals.earnedMedals`, stats.ts) — see packages/core/src/medals.ts for the
 * tier math itself, already covered by its own unit tests. This suite is
 * about the plumbing: the right counts reach the pure function, and AI/house
 * personas never get a medal regardless of how many tournaments they've
 * played.
 */
freshDbEnv('medals');
const app = await makeApp();

const dana = new TestClient(app, 'MedalsDana');
await dana.login();

/** Places `client` into a fresh tournament (solo — no rating needed for medals) and finishes all 4 boards. */
async function completeOneTournament(client: TestClient): Promise<void> {
  const placed = await client.post('/api/play');
  for (let no = 1; no <= 4; no++) await playBoard(client, placed.tournamentId, no);
}

describe('medal progress', () => {
  it('starts a fresh account at 0/4 toward the club medal', async () => {
    const me = await dana.get('/api/me');
    expect(me.user.medals).toEqual({ earned: [], target: 'c', pct: 0, tournamentsRemaining: 4 });
  });

  it('carries provisionalMin (production quota 4), so the club-tier copy can confirm "join the rankings" is true here', async () => {
    const me = await dana.get('/api/me');
    expect(me.provisionalMin).toBe(4);
  });

  it('earns the club medal on the 4th completed tournament, already 16% toward diamond (not reset to 0)', async () => {
    for (let i = 0; i < 4; i++) await completeOneTournament(dana);
    const me = await dana.get('/api/me');
    expect(me.user.medals.earned).toEqual(['c']);
    expect(me.user.medals.target).toBe('d');
    expect(me.user.medals.tournamentsRemaining).toBe(21);
    // 16 boards played so far, measured from zero against diamond's 100-board
    // target (25 tournaments * 4) — 16/100 = 16%, matching 4/25 exactly.
    expect(me.user.medals.pct).toBe(Math.round((16 / 100) * 100));
  });

  it('the bar keeps climbing board by board mid-tournament, ahead of the next medal actually being earned', async () => {
    // one more tournament, but stop after its 2nd board — the medal itself
    // must not move, even though the bar (now 18 of 100 boards) does.
    const placed = await dana.post('/api/play');
    await playBoard(dana, placed.tournamentId, 1);
    await playBoard(dana, placed.tournamentId, 2);
    const me = await dana.get('/api/me');
    expect(me.user.medals.earned).toEqual(['c']);
    expect(me.user.medals.target).toBe('d');
    expect(me.user.medals.pct).toBe(Math.round((18 / 100) * 100));
    expect(me.user.medals.tournamentsRemaining).toBe(21); // still 21 — no NEW tournament completed yet
  });

  it('reflects the same earned medals on the profile (playerStats), with no bar/target/pct', async () => {
    const meId = (await dana.get('/api/me')).user.id;
    const stats = await dana.get(`/api/users/${meId}/stats`);
    expect(stats.totals.earnedMedals).toEqual(['c']);
    expect(stats.totals).not.toHaveProperty('target');
    expect(stats.totals).not.toHaveProperty('pct');
  });

  it('never shows medals for an AI/house persona, however many tournaments they have played', async () => {
    const { ensureAiPlayers } = await import('../src/ai-players.js');
    const shark = ensureAiPlayers().expert;
    const stats = await dana.get(`/api/users/${shark.id}/stats`);
    expect(stats.totals.earnedMedals).toEqual([]);
  });
});
