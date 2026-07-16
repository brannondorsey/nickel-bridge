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

// Fly sends SIGTERM before stopping a machine (redeploys, idle scale-to-zero) — drain
// in-flight requests instead of letting Node kill the process immediately.
process.on('SIGTERM', async () => {
  await app.close();
  process.exit(0);
});
