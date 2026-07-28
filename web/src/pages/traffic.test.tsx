import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_NOW, activityEmpty, activityResponse, meFixture } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Activity from './Activity';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

// The screen reads the wall clock to decide which day is "Today" and where the
// now rule falls, so the whole suite runs at the fixture's own instant.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(ACTIVITY_NOW);
});
afterEach(() => vi.useRealTimers());

describe('Traffic', () => {
  it('shows the loading treatment while the feed loads', () => {
    apiMock.activity.mockReturnValue(new Promise(() => {}));
    renderWithMe(<Activity />, { me: meFixture, route: '/activity' });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('surfaces load failures in the error treatment', async () => {
    apiMock.activity.mockRejectedValue(new Error('offline'));
    renderWithMe(<Activity />, { me: meFixture, route: '/activity' });
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });

  it('groups runs under their day and links each to that player', async () => {
    apiMock.activity.mockResolvedValue(activityResponse);
    renderWithMe(<Activity />, { me: meFixture, route: '/activity' });

    expect(await screen.findByText('The traffic')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();

    const alice = screen.getAllByText('Alice')[0].closest('a')!;
    expect(alice).toHaveAttribute('href', '/players/7');
    expect(within(alice).getByText('▲26')).toHaveClass('positive');
    expect(within(alice).getByText('8 boards · 2 crossings, best 62%')).toBeInTheDocument();
  });

  it('marks the viewer’s own run and renders a loss with the ▼ glyph', async () => {
    apiMock.activity.mockResolvedValue(activityResponse);
    renderWithMe(<Activity />, { me: meFixture, route: '/activity' });

    const mine = (await screen.findByText('Margaret — you')).closest('a')!;
    expect(mine).toHaveClass('traffic-row-you');
    expect(within(mine).getByText('▼11')).toHaveClass('negative');
  });

  it('shows a new arrival as a joined tag rather than a rating change', async () => {
    apiMock.activity.mockResolvedValue(activityResponse);
    renderWithMe(<Activity />, { me: meFixture, route: '/activity' });

    const bob = (await screen.findByText('Bob')).closest('a')!;
    expect(within(bob).getByText('JOINED')).toBeInTheDocument();
    expect(within(bob).getByText('paid the first toll — no boards yet')).toBeInTheDocument();
  });

  it('prints the days nobody crossed instead of dropping them', async () => {
    apiMock.activity.mockResolvedValue(activityResponse);
    renderWithMe(<Activity />, { me: meFixture, route: '/activity' });
    expect((await screen.findAllByText('The bridge was empty.')).length).toBeGreaterThan(0);
  });

  it('draws the now rule on today only', async () => {
    apiMock.activity.mockResolvedValue(activityResponse);
    const { container } = renderWithMe(<Activity />, { me: meFixture, route: '/activity' });
    await screen.findByText('The traffic');
    expect(container.querySelectorAll('.daystrip-now')).toHaveLength(1);
  });

  it('invites the first crosser when the week is empty', async () => {
    apiMock.activity.mockResolvedValue(activityEmpty);
    renderWithMe(<Activity />, { me: meFixture, route: '/activity' });
    expect(await screen.findByText(/Nobody has crossed in the last seven days/)).toBeInTheDocument();
    // The cold start replaces the day list entirely — no empty panels behind it.
    expect(screen.queryByText('The bridge was empty.')).not.toBeInTheDocument();
  });

  it('always discloses that ratings can be restated', async () => {
    apiMock.activity.mockResolvedValue(activityResponse);
    renderWithMe(<Activity />, { me: meFixture, route: '/activity' });
    expect(await screen.findByText(/can restate a number you saw yesterday/)).toBeInTheDocument();
  });
});
