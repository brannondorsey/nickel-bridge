import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_VISIT_KEY, stampVisit } from '../splash';
import { meFixture } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Scenarios from './Scenarios';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

const meDemo = { ...meFixture, demo: true };

const catalog = {
  scenarios: [
    { id: 'your-call', label: 'An opening bid, your call', description: 'Bid it yourself.', category: 'bidding' },
    { id: 'claim-fires', label: 'The defense claims the rest', description: 'Play the ♦4.', category: 'claims' },
    // a category the frontend has never heard of must still render — section
    // order is derived from the catalog, not a hardcoded list
    { id: 'brand-new', label: 'A brand new exhibit', description: 'Fresh from the mine.', category: 'oddities' },
  ],
};

const rowFor = (label: string | RegExp) => screen.getByText(label).closest('.exhibit-row') as HTMLElement;

describe('Scenarios (the Exhibit Hall)', () => {
  it('only opens in demo mode', () => {
    renderWithMe(<Scenarios />, { me: meFixture });
    expect(screen.getByText(/only opens on demo deployments/i)).toBeInTheDocument();
    expect(apiMock.demoScenarios).not.toHaveBeenCalled();
  });

  it('schedules the desync behind the tester for the exhibit that declares one', async () => {
    // The stale-board exhibit's client half: the board has to be moved on
    // AFTER Board.tsx has fetched it, so this fires on a bare timer that
    // outlives this component's unmount. Without it the tester lands on an
    // ordinary playable board and the refusal never happens.
    const withDesync = {
      scenarios: [
        { id: 'stale-board', label: 'A second device moves the board on', description: 'Wait, then tap.', category: 'card play', desyncAfterMs: 1500 },
        { id: 'your-call', label: 'An opening bid, your call', description: 'Bid it yourself.', category: 'bidding' },
      ],
    };
    apiMock.demoScenarios.mockResolvedValue(withDesync);
    apiMock.runDemoScenario.mockResolvedValue({ tournamentId: 7, boardNo: 2 });
    apiMock.demoDesync.mockResolvedValue({ advanced: true });

    renderWithMe(<Scenarios />, { me: meDemo });
    const row = (await screen.findByText('A second device moves the board on')).closest('.exhibit-row') as HTMLElement;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await userEvent.click(within(row).getByRole('button', { name: /enter/i }));
      await vi.waitFor(() => expect(apiMock.runDemoScenario).toHaveBeenCalledWith('stale-board'));

      // not immediately — the tester has to be looking at the board first
      expect(apiMock.demoDesync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1500);
      expect(apiMock.demoDesync).toHaveBeenCalledWith(7, 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not desync an exhibit that did not ask for one', async () => {
    apiMock.demoScenarios.mockResolvedValue(catalog);
    apiMock.runDemoScenario.mockResolvedValue({ tournamentId: 7, boardNo: 2 });
    renderWithMe(<Scenarios />, { me: meDemo });
    const row = (await screen.findByText('An opening bid, your call')).closest('.exhibit-row') as HTMLElement;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await userEvent.click(within(row).getByRole('button', { name: /enter/i }));
      await vi.waitFor(() => expect(apiMock.runDemoScenario).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(apiMock.demoDesync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('groups exhibits by category and runs one on ENTER', async () => {
    apiMock.demoScenarios.mockResolvedValue(catalog);
    let land!: (v: { tournamentId: number; boardNo: number }) => void;
    apiMock.runDemoScenario.mockReturnValue(new Promise((resolve) => (land = resolve)));
    renderWithMe(<Scenarios />, { me: meDemo });

    expect(await screen.findByText('BIDDING')).toBeInTheDocument();
    expect(screen.getByText('CLAIMS')).toBeInTheDocument();
    // unknown categories render too, in catalog order
    expect(screen.getByText('ODDITIES')).toBeInTheDocument();
    expect(screen.getByText('A brand new exhibit')).toBeInTheDocument();
    const row = rowFor('An opening bid, your call');
    await userEvent.click(within(row).getByRole('button', { name: /enter/i }));
    expect(apiMock.runDemoScenario).toHaveBeenCalledWith('your-call');
    // busy state on the clicked row, other rows locked while dealing
    expect(within(row).getByRole('button', { name: /dealing…/i })).toBeDisabled();
    const other = rowFor('The defense claims the rest');
    expect(within(other).getByRole('button', { name: /enter/i })).toBeDisabled();
    land({ tournamentId: 7, boardNo: 2 });
    await vi.waitFor(() => expect(apiMock.runDemoScenario).toHaveBeenCalled());
  });

  it('shows the splash exhibit as an overlay and closes it on tap', async () => {
    apiMock.demoScenarios.mockResolvedValue(catalog);
    renderWithMe(<Scenarios />, { me: meDemo });
    const row = (await screen.findByText('The returning-visitor curtain')).closest('.exhibit-row') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /enter/i }));
    const splash = screen.getByTestId('splash');
    expect(splash).toBeInTheDocument();
    await userEvent.click(splash);
    expect(screen.queryByTestId('splash')).not.toBeInTheDocument();
  });

  // The SIGNED OUT group is the one that really ends the session — an overlay
  // can't fake the states it shows, since they're all decided by whether
  // me.user is genuinely null. It leaves with a hard navigation so the app
  // boots the way a first-time visitor's browser would, with no stale `me`.
  describe('the signed-out exhibits', () => {
    const assign = vi.fn();
    beforeEach(() => {
      assign.mockClear();
      Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    });

    it('drops the session, clears the returning-player stamp, then hard-loads the target', async () => {
      apiMock.demoScenarios.mockResolvedValue(catalog);
      apiMock.logout.mockResolvedValue({ ok: true });
      stampVisit();
      renderWithMe(<Scenarios />, { me: meDemo });
      const row = (await screen.findByText('The practice deal, no account')).closest('.exhibit-row') as HTMLElement;
      await userEvent.click(within(row).getByRole('button', { name: /enter/i }));
      expect(apiMock.logout).toHaveBeenCalled();
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/tour'));
      expect(localStorage.getItem(LAST_VISIT_KEY)).toBeNull();
    });

    it('leaves anyway when the session was already gone, and still clears the stamp', async () => {
      apiMock.demoScenarios.mockResolvedValue(catalog);
      apiMock.logout.mockRejectedValue(new Error('no session'));
      stampVisit();
      renderWithMe(<Scenarios />, { me: meDemo });
      const row = (await screen.findByText('The front door, as a stranger')).closest('.exhibit-row') as HTMLElement;
      await userEvent.click(within(row).getByRole('button', { name: /enter/i }));
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
      expect(localStorage.getItem(LAST_VISIT_KEY)).toBeNull();
    });

    // This one needs a seeded player to refuse, so it stays disabled until the
    // catalog carries one rather than navigating to /players/null.
    it('holds the refused-profile exhibit shut until the seeded id arrives', async () => {
      apiMock.demoScenarios.mockResolvedValue(catalog); // no richProfileId
      renderWithMe(<Scenarios />, { me: meDemo });
      const row = (await screen.findByText('A player’s record, refused')).closest('.exhibit-row') as HTMLElement;
      expect(within(row).getByRole('button', { name: /enter/i })).toBeDisabled();
    });

    it('opens the refused-profile exhibit on the seeded player once it has one', async () => {
      apiMock.demoScenarios.mockResolvedValue({ ...catalog, richProfileId: 42 });
      apiMock.logout.mockResolvedValue({ ok: true });
      renderWithMe(<Scenarios />, { me: meDemo });
      const row = (await screen.findByText('A player’s record, refused')).closest('.exhibit-row') as HTMLElement;
      await userEvent.click(within(row).getByRole('button', { name: /enter/i }));
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/players/42'));
    });

    it('says once how to get back in, rather than in every row', async () => {
      apiMock.demoScenarios.mockResolvedValue(catalog);
      renderWithMe(<Scenarios />, { me: meDemo });
      expect(await screen.findByText(/come back as the Inspector/i)).toBeInTheDocument();
    });
  });

  it('arms the reset on first tap and only wipes on the second', async () => {
    apiMock.demoScenarios.mockResolvedValue(catalog);
    apiMock.resetDemo.mockResolvedValue({ ok: true });
    const { refresh } = renderWithMe(<Scenarios />, { me: meDemo });
    const row = (await screen.findByText('Reset the exhibition')).closest('.exhibit-row') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /reset/i }));
    expect(apiMock.resetDemo).not.toHaveBeenCalled();
    await userEvent.click(within(row).getByRole('button', { name: /sure\?/i }));
    expect(apiMock.resetDemo).toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
