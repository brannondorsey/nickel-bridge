/**
 * Shared helpers for web unit tests.
 *
 * Mocking pattern (vi.mock is hoisted, so each test file declares it):
 *
 *   import { apiMock } from './test/utils';           // adjust relative path
 *   vi.mock('../api', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('../api')>()),
 *     api: (await import('./test/utils')).apiMock,
 *   }));
 *
 * Only the `api` network object is replaced; `callDisplay`, `displaySort`,
 * card helpers etc. stay real. Configure per-test with
 * `apiMock.board.mockResolvedValue(fixture)` — every method starts as an
 * unconfigured vi.fn() that rejects, so a screen touching an endpoint you
 * didn't stub fails loudly.
 */
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, vi } from 'vitest';
import type { Me, api as realApi } from '../api';
import { MeContext } from '../App';

type Api = typeof realApi;
type ApiMock = { [K in keyof Api]: ReturnType<typeof vi.fn> };

function freshApiMock(): ApiMock {
  const stub = () => vi.fn(() => Promise.reject(new Error('api method not stubbed in this test')));
  return {
    me: stub(),
    devLogin: stub(),
    setHandle: stub(),
    setOnboarded: stub(),
    logout: stub(),
    play: stub(),
    tournaments: stub(),
    tournament: stub(),
    board: stub(),
    call: stub(),
    playCard: stub(),
    playerStats: stub(),
    leaderboard: stub(),
    demoScenarios: stub(),
    runDemoScenario: stub(),
    resetDemo: stub(),
  };
}

export const apiMock: ApiMock = freshApiMock();

beforeEach(() => {
  const fresh = freshApiMock();
  for (const k of Object.keys(apiMock) as (keyof ApiMock)[]) apiMock[k] = fresh[k];
});

/** Render a screen inside MemoryRouter + MeContext, as App would mount it. */
export function renderWithMe(ui: ReactElement, { me, route = '/' }: { me: Me | null; route?: string }) {
  const refresh = vi.fn();
  const result = render(
    <MeContext.Provider value={{ me, refresh }}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </MeContext.Provider>,
  );
  return { ...result, refresh };
}
