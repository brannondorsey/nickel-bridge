import { describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp } from './helpers.js';

/**
 * With DEMO unset, none of the demo surface exists — this is the production
 * posture (CLAUDE.md invariant 5), enforced here and by the CI guard on the
 * production deploy job.
 */
freshDbEnv('demo-off');
delete process.env.DEMO;
const app = await makeApp();

describe('demo mode disabled', () => {
  it('does not register /demo — no session, no redirect', async () => {
    const client = new TestClient(app, 'Someone');
    const res = await client.raw('GET', '/demo');
    // The route doesn't exist, so the request falls through to the SPA
    // fallback like any unknown path. The load-bearing assertions: nobody
    // gets signed in and nothing redirects to the gallery.
    expect(res.statusCode).not.toBe(302);
    expect(res.headers['set-cookie']).toBeUndefined();
    const me = await client.get('/api/me');
    expect(me.user).toBeNull();
  });

  it('does not expose the scenario API, even to a signed-in user', async () => {
    const client = new TestClient(app, 'Someone');
    await client.login();
    expect((await client.raw('GET', '/api/demo/scenarios')).statusCode).toBe(404);
    expect((await client.raw('POST', '/api/demo/scenarios/your-call')).statusCode).toBe(404);
    expect((await client.raw('POST', '/api/demo/reset')).statusCode).toBe(404);
  });

  it('reports demo: false on /api/me', async () => {
    const client = new TestClient(app, 'Someone');
    const me = await client.get('/api/me');
    expect(me.demo).toBe(false);
  });
});
