import { describe, expect, it } from 'vitest';
import { freshDbEnv, makeApp } from './helpers.js';

freshDbEnv('health');
const app = await makeApp();

describe('GET /health', () => {
  it('responds 200 with no auth required', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
