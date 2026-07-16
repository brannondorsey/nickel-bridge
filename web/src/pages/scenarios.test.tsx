import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
