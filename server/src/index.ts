import { buildApp } from './app.js';

const app = await buildApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

// Fly sends SIGTERM before stopping a machine (redeploys, idle scale-to-zero) — drain
// in-flight requests instead of letting Node kill the process immediately.
process.on('SIGTERM', async () => {
  await app.close();
  process.exit(0);
});
