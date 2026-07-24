import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { freshDbEnv } from './helpers.js';

/**
 * Seeder behavior on a tiny profile (full-scale seeding is a deploy-time
 * concern, not a test concern): data is genuine engine output — rated Elo,
 * bid grades, stats series — and reruns are no-ops.
 */
freshDbEnv('demo-seed');
const { db } = await import('../src/db.js');
const { seedDemo } = await import('../src/demo-seed.js');
const { playerStats } = await import('../src/stats.js');

const log = { info() {}, error() {}, warn() {}, debug() {} } as unknown as FastifyBaseLogger;

const tiny = {
  bots: ['Seed Bot A', 'Seed Bot B'],
  tournaments: [{ seed: 'demo-tiny-a', ageS: 2 * 86400, players: [0, 1] }],
  exhibitFields: false,
};

describe('demo seeder', () => {
  it(
    'produces genuine rated history through the real engine, then no-ops',
    async () => {
      await seedDemo(log, tiny);

      const bots = db
        .prepare(`SELECT * FROM users WHERE google_id LIKE 'demo:bot:%' ORDER BY id`)
        .all() as { id: number; elo: number; handle: string }[];
      expect(bots.map((b) => b.handle)).toEqual(['Seed Bot A', 'Seed Bot B']);

      // both bots completed the tournament → it rated (elo_history written)
      const rated = db.prepare(`SELECT COUNT(*) AS n FROM elo_history`).get() as { n: number };
      expect(rated.n).toBeGreaterThan(0);

      // stats only look like this when boards went through submitCall/submitPlay
      const stats = playerStats(bots[0].id)!;
      expect(stats.totals.boardsCompleted).toBe(4);
      expect(stats.totals.ratedTournaments).toBe(1);
      expect(stats.eloSeries.length).toBe(1);
      const grades = stats.totals.gradeCounts;
      expect(grades.excellent + grades.good + grades.fair + grades.poor).toBeGreaterThan(0);
      expect(stats.totals.avgBidAccuracy).not.toBeNull();

      // boards look played near the (backdated) tournament, not right now
      const finishedAt = db
        .prepare(`SELECT MAX(updated_at) AS at FROM boards WHERE user_id = ?`)
        .get(bots[0].id) as { at: number };
      expect(finishedAt.at).toBeLessThan(Date.now() / 1000 - 86400);

      // seeded accounts predate their backdated results ("Playing since")
      const botCreated = (db.prepare(`SELECT created_at FROM users WHERE id = ?`).get(bots[0].id) as {
        created_at: number;
      }).created_at;
      expect(botCreated).toBeLessThan(finishedAt.at);

      // the Inspector is provisioned even when no tournament includes them
      const inspector = db.prepare(`SELECT * FROM users WHERE google_id = 'demo:inspector'`).get() as {
        handle: string;
      };
      expect(inspector.handle).toBe('Inspector');

      // rerun is a no-op: every step is check-before-create
      const boardsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM boards`).get() as { n: number }).n;
      await seedDemo(log, tiny);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM boards`).get() as { n: number }).n).toBe(boardsBefore);
    },
    180_000,
  );
});
