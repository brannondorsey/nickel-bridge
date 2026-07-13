import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Shared harness for server integration tests.
 *
 * Call `freshDbEnv()` at the very top of a test file (before any dynamic
 * import of ../src/*) so the db module initializes against a throwaway file,
 * then `await makeApp()` for a fully-wired in-process app driven via inject().
 */
export function freshDbEnv(prefix: string): string {
  const path = join(mkdtempSync(join(tmpdir(), `bridge-${prefix}-`)), 'test.db');
  process.env.DB_PATH = path;
  process.env.DEV_AUTH = '1';
  process.env.LOG_LEVEL = 'silent';
  return path;
}

export async function makeApp(): Promise<FastifyInstance> {
  const { buildApp } = await import('../src/app.js');
  return buildApp();
}

/** Cookie-jar client over app.inject() — one per simulated user. */
export class TestClient {
  private cookie = '';

  constructor(
    private app: FastifyInstance,
    public name: string,
  ) {}

  async login(): Promise<void> {
    await this.post('/auth/dev', { name: this.name });
  }

  async get(url: string, expectStatus = 200): Promise<any> {
    const res = await this.app.inject({ method: 'GET', url, headers: { cookie: this.cookie } });
    this.capture(res.headers['set-cookie']);
    if (res.statusCode !== expectStatus) {
      throw new Error(`GET ${url} -> ${res.statusCode} (expected ${expectStatus}): ${res.body}`);
    }
    return res.body ? res.json() : null;
  }

  async post(url: string, body?: unknown, expectStatus = 200): Promise<any> {
    const res = await this.app.inject({
      method: 'POST',
      url,
      headers: { cookie: this.cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    this.capture(res.headers['set-cookie']);
    if (res.statusCode !== expectStatus) {
      throw new Error(`POST ${url} -> ${res.statusCode} (expected ${expectStatus}): ${res.body}`);
    }
    return res.body ? res.json() : null;
  }

  /** raw variant when the test wants to assert the status itself */
  async raw(method: 'GET' | 'POST', url: string, body?: unknown) {
    const res = await this.app.inject({
      method,
      url,
      headers: { cookie: this.cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    this.capture(res.headers['set-cookie']);
    return res;
  }

  private capture(setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    this.cookie = first.split(';')[0];
  }
}

/**
 * Drive a board to completion through the HTTP API, like a player would.
 * strategy.call picks the user's call from view state; strategy.card picks
 * the card. Defaults: always pass, always play the first legal card.
 * Returns every board payload seen along the way (for invariant checks).
 */
export async function playBoard(
  client: TestClient,
  tournamentId: number,
  boardNo: number,
  strategy: {
    call?: (view: any) => number;
    card?: (view: any) => number;
  } = {},
): Promise<any[]> {
  const chooseCall = strategy.call ?? (() => 0);
  const chooseCard = strategy.card ?? ((view: any) => view.legalCards[0]);
  const seen: any[] = [];
  let view = await client.get(`/api/tournaments/${tournamentId}/boards/${boardNo}`);
  seen.push(view);
  let safety = 250;
  while (view.state !== 'done' && safety-- > 0) {
    if (view.state === 'bidding' && view.myTurn) {
      view = (await client.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/call`, { call: chooseCall(view) }))
        .board;
    } else if (view.state === 'playing' && view.myTurn) {
      view = (await client.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/play`, { card: chooseCard(view) }))
        .board;
    } else {
      throw new Error(`board stuck: state=${view.state} myTurn=${view.myTurn}`);
    }
    seen.push(view);
  }
  if (view.state !== 'done') throw new Error('board did not finish');
  return seen;
}
