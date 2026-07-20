import { buildApp } from './app.js';

const app = await buildApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

// Demo mode: fill ambient data AFTER listen, fire-and-forget, so /health
// answers immediately and the seeder's DDS solves never block boot. The
// module is only imported under DEMO=1 — it never loads in production.
if (process.env.DEMO === '1') {
  import('./demo-seed.js')
    .then((m) => m.seedDemo(app.log))
    .catch((err) => app.log.error(err, 'demo seed failed'));
}

// Benchmark AI personas: ensure the three accounts exist, then re-enqueue
// tournaments whose persona play STARTED but didn't finish — crash/redeploy
// recovery for play interrupted mid-board. After listen and fire-and-forget
// for the same reason as the seeder. Tournaments nobody has opened are
// deliberately not swept: persona play starts on demand from the placement
// and board routes (see ai-players.ts scheduling). Disabled by AI_PLAYERS=0
// inside these calls (the test harness sets it; buildApp() never runs this
// file, so app.inject() suites are exempt regardless).
if (process.env.AI_PLAYERS !== '0') {
  import('./ai-players.js')
    .then((m) => {
      m.ensureAiPlayers();
      m.sweepAiFields(app.log);
    })
    .catch((err) => app.log.error(err, 'ai-players boot sweep failed'));
}

// Fly sends SIGTERM before stopping a machine (redeploys, idle scale-to-zero) — drain
// in-flight requests instead of letting Node kill the process immediately.
process.on('SIGTERM', async () => {
  await app.close();
  process.exit(0);
});
