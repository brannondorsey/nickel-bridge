import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAuthRoutes, requireUser } from './auth.js';
import { db } from './db.js';
import { boardView, ensureAdvanced, httpError, loadBoard, submitCall, submitPlay } from './game.js';
import { closeExpired, getTournament, myTournaments, placeUser, standings } from './tournaments.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.register(fastifyCookie);

registerAuthRoutes(app);

// ---- game & tournament API ----

app.post('/api/play', (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const { tournament, nextBoard } = placeUser(user.id);
  return reply.send({ tournamentId: tournament.id, boardNo: nextBoard });
});

app.get('/api/tournaments', (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  closeExpired();
  const mine = myTournaments(user.id).map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    closesAt: t.closes_at,
    myDone: t.myDone,
    standings: standings(t.id),
  }));
  return reply.send({ tournaments: mine });
});

app.get('/api/tournaments/:id', (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  closeExpired();
  const t = getTournament(Number((req.params as { id: string }).id));
  if (!t) return reply.code(404).send({ error: 'not found' });
  return reply.send({
    id: t.id,
    name: t.name,
    status: t.status,
    closesAt: t.closes_at,
    standings: standings(t.id),
  });
});

app.get('/api/tournaments/:id/boards/:no', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  closeExpired();
  const { id, no } = req.params as { id: string; no: string };
  const t = getTournament(Number(id));
  const boardNo = Number(no);
  if (!t || boardNo < 1 || boardNo > 4) return reply.code(404).send({ error: 'not found' });
  const canStart = t.status === 'open' && t.closes_at > Date.now() / 1000;
  const b = loadBoard(t, user.id, boardNo, canStart);
  if (!b) return reply.code(409).send({ error: 'tournament is closed' });
  await ensureAdvanced(b);
  return reply.send(boardView(t, b, user.elo));
});

app.post('/api/tournaments/:id/boards/:no/call', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const { id, no } = req.params as { id: string; no: string };
  const { call } = (req.body ?? {}) as { call?: number };
  const t = getTournament(Number(id));
  if (!t) return reply.code(404).send({ error: 'not found' });
  if (t.status !== 'open') return reply.code(409).send({ error: 'tournament is closed' });
  const b = loadBoard(t, user.id, Number(no), false);
  if (!b) return reply.code(404).send({ error: 'board not started' });
  if (typeof call !== 'number' || call < 0 || call > 37) return reply.code(400).send({ error: 'bad call' });
  const evaluation = await submitCall(b, call);
  return reply.send({ evaluation, board: boardView(t, b, user.elo) });
});

app.post('/api/tournaments/:id/boards/:no/play', async (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  const { id, no } = req.params as { id: string; no: string };
  const { card } = (req.body ?? {}) as { card?: number };
  const t = getTournament(Number(id));
  if (!t) return reply.code(404).send({ error: 'not found' });
  if (t.status !== 'open') return reply.code(409).send({ error: 'tournament is closed' });
  const b = loadBoard(t, user.id, Number(no), false);
  if (!b) return reply.code(404).send({ error: 'board not started' });
  if (typeof card !== 'number' || card < 0 || card > 51) return reply.code(400).send({ error: 'bad card' });
  await submitPlay(b, card);
  return reply.send({ board: boardView(t, b, user.elo) });
});

app.get('/api/leaderboard', (req, reply) => {
  const user = requireUser(req, reply);
  if (!user) return;
  closeExpired();
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.picture, u.elo,
              (SELECT COUNT(*) FROM elo_history h WHERE h.user_id = u.id) AS rated_tournaments,
              (SELECT COUNT(DISTINCT b.tournament_id) FROM boards b WHERE b.user_id = u.id) AS played_tournaments
       FROM users u ORDER BY u.elo DESC, u.name`,
    )
    .all();
  return reply.send({ leaderboard: rows });
});

// ---- static SPA ----
const here = dirname(fileURLToPath(import.meta.url));
const webDist = process.env.WEB_DIST ?? join(here, '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/auth')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}

app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) req.log.error(err);
  reply.code(status).send({ error: err.message });
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
export { httpError };
