import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { freshDbEnv, makeApp, playBoard, TestClient } from './helpers.js';

freshDbEnv('admin');

const TOKEN = 'test-admin-token-long-enough-to-pass';
process.env.ADMIN_TOKEN = TOKEN;

let app: FastifyInstance;

const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

async function get(url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers });
}

/** Parse a CSV into objects, honouring RFC 4180 quoting. */
function parseCsv(body: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body_] = rows;
  return body_.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

beforeAll(async () => {
  app = await makeApp();
});

describe('admin roster auth', () => {
  it('rejects a request with no token', async () => {
    const res = await get('/api/admin/players.csv');
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong token of the same length', async () => {
    // Same length as the real one, so this exercises the comparison itself
    // rather than the length pre-check that guards timingSafeEqual.
    const wrong = 'x'.repeat(TOKEN.length);
    expect(wrong).toHaveLength(TOKEN.length);
    expect((await get('/api/admin/players.csv', auth(wrong))).statusCode).toBe(401);
  });

  it('rejects a token that is a prefix of the real one', async () => {
    expect((await get('/api/admin/players.csv', auth(TOKEN.slice(0, -1)))).statusCode).toBe(401);
  });

  it('rejects a non-Bearer authorization scheme carrying the right secret', async () => {
    const res = await get('/api/admin/players.csv', { authorization: `Basic ${TOKEN}` });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the configured token', async () => {
    expect((await get('/api/admin/players.csv', auth())).statusCode).toBe(200);
  });

  it('is not reachable through an ordinary signed-in session', async () => {
    const client = new TestClient(app, 'nosy');
    await client.login();
    // A logged-in player has a cookie, not a bearer token: session auth must
    // buy nothing here, or every user could export every other user's email.
    expect((await client.raw('GET', '/api/admin/players.csv')).statusCode).toBe(401);
  });

  it('404s (not 401) when no token is configured, so it does not advertise itself', async () => {
    const saved = process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_TOKEN;
    try {
      expect((await get('/api/admin/players.csv')).statusCode).toBe(404);
      expect((await get('/api/admin/players.csv', auth(saved!))).statusCode).toBe(404);
    } finally {
      process.env.ADMIN_TOKEN = saved;
    }
  });

  it('stays disabled when the configured token is too short to be safe', async () => {
    const saved = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'short';
    try {
      expect((await get('/api/admin/players.csv', auth('short'))).statusCode).toBe(404);
    } finally {
      process.env.ADMIN_TOKEN = saved;
    }
  });
});

describe('admin roster content', () => {
  it('sends PII with no-store and as a dated attachment', async () => {
    const res = await get('/api/admin/players.csv', auth());
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="nickel-bridge-players-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it('classifies players into cohorts from real played boards', async () => {
    // A player who finishes a board, and one who opens a board and walks away
    // mid-auction without ever bidding — the two cohorts that matter most.
    const finisher = new TestClient(app, 'finisher');
    await finisher.login();
    const seat = await finisher.post('/api/play');
    await playBoard(finisher, seat.tournamentId, seat.boardNo);

    const quitter = new TestClient(app, 'quitter');
    await quitter.login();
    const q = await quitter.post('/api/play');
    await quitter.get(`/api/tournaments/${q.tournamentId}/boards/${q.boardNo}`); // deals it, no call made

    const lurker = new TestClient(app, 'lurker');
    await lurker.login(); // signs up, never opens a board

    const rows = parseCsv((await get('/api/admin/players.csv', auth())).body);
    const by = (h: string) => rows.find((r) => r.handle === h)!;

    expect(by('finisher').cohort).toBe('friction');
    expect(Number(by('finisher').boards_done)).toBeGreaterThanOrEqual(1);

    expect(by('quitter').cohort).toBe('abandoned_first');
    expect(by('quitter').boards_done).toBe('0');
    expect(by('quitter').stopped_at).toBe('auction');
    expect(by('quitter').human_calls).toBe('0'); // reached the bid box, bid nothing

    expect(by('lurker').cohort).toBe('never_played');
    expect(by('lurker').stopped_at).toBe(''); // no abandoned board at all
  });

  it('excludes the benchmark AI personas from the roster', async () => {
    const report = (await get('/api/admin/players.json', auth())).json();
    const handles = report.players.map((p: { handle: string }) => p.handle);
    expect(handles).not.toContain('The Shark');
    expect(handles).not.toContain('The Regular');
    expect(handles).not.toContain('The Novice');
  });

  it('honours the exclude query param without dropping the row', async () => {
    const before = (await get('/api/admin/players.json', auth())).json();
    const victim = before.players.find((p: { handle: string }) => p.handle === 'finisher');
    const after = (await get('/api/admin/players.json?exclude=FINISHER', auth())).json();
    const row = after.players.find((p: { id: number }) => p.id === victim.id);
    // Still present and still counted as a player — just not mailable.
    expect(row.excluded).toBe(true);
    expect(after.totals.players).toBe(before.totals.players);
    expect(after.totals.excluded).toBe(before.totals.excluded + 1);
  });

  it('applies the cooldown so freshly-active players are not called churned', async () => {
    // Everyone in this suite played just now, so at any positive cooldown the
    // whole friction cohort should be held, and at 0 none of it should be.
    const held = (await get('/api/admin/players.json?cooldown_days=3', auth())).json();
    expect(held.totals.friction).toBe(0);
    expect(held.totals.friction_held).toBeGreaterThan(0);

    const none = (await get('/api/admin/players.json?cooldown_days=0', auth())).json();
    expect(none.totals.friction_held).toBe(0);
    expect(none.totals.friction).toBe(held.totals.friction_held);
  });

  it('agrees between the CSV and JSON representations', async () => {
    const report = (await get('/api/admin/players.json', auth())).json();
    const rows = parseCsv((await get('/api/admin/players.csv', auth())).body);
    expect(rows).toHaveLength(report.players.length);
    expect(rows.map((r) => Number(r.id))).toEqual(report.players.map((p: { id: number }) => p.id));
  });

  it('neutralizes spreadsheet formula injection in user-controlled names', async () => {
    // Display names come from Google in production, so they are attacker-ish
    // input: a cell starting with =, +, - or @ executes on open in Excel and
    // Sheets. DEV_AUTH's name rule allows a leading '-', which is enough to
    // prove the guard fires on a name a real signup could carry.
    const sneaky = new TestClient(app, '-2-3');
    await sneaky.login();
    const body = (await get('/api/admin/players.csv', auth())).body;
    expect(body).not.toMatch(/(^|,)-2-3/m);
    expect(body).toContain("'-2-3");
  });
});
