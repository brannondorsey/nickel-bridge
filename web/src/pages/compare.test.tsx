import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Compare from './Compare';
import { apiMock, renderWithMe } from '../test/utils';
import { compareMet, compareThin, compareUnmet, meFixture } from '../test/fixtures';

// The getter is required: beforeEach in test/utils reassigns apiMock's methods.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

const renderCompare = (id = 50) => renderWithMe(<Compare />, { me: meFixture, route: `/compare/${id}` });

describe('Compare', () => {
  it('leads with the head-to-head record when the two have met', async () => {
    apiMock.compare.mockResolvedValue(compareMet);
    renderCompare();

    expect(await screen.findByText('HEAD TO HEAD')).toBeInTheDocument();
    // 2-3-1: ahead, behind, tied. Rendered as one figure with separators.
    const slip = document.querySelector('.cmp-slip') as HTMLElement;
    expect(slip.textContent).toContain('2');
    expect(within(slip).getByText(/6 crossings shared/)).toBeInTheDocument();
    expect(within(slip).getByText(/Marge leads/)).toBeInTheDocument();
    // One tick per shared crossing, capped by the server.
    expect(slip.querySelectorAll('.cmp-tick')).toHaveLength(6);
    expect(screen.queryByText('COMMON GROUND')).not.toBeInTheDocument();
  });

  it('substitutes common ground when the two have never crossed', async () => {
    apiMock.compare.mockResolvedValue(compareUnmet);
    renderCompare(60);

    expect(await screen.findByText('COMMON GROUND')).toBeInTheDocument();
    expect(screen.queryByText('HEAD TO HEAD')).not.toBeInTheDocument();
    expect(screen.getByText(/You have never crossed with Vance/)).toBeInTheDocument();
    // A record against each persona, not a matchpoint average: all three
    // personas play every ai_field tournament, so an average over "boards where
    // that persona was in the field" would print the same number three times.
    expect(screen.getByText('The Novice')).toBeInTheDocument();
    expect(screen.getByText('19 of 26')).toBeInTheDocument();
    expect(screen.getByText('The Shark')).toBeInTheDocument();
  });

  it('draws a beam per judged row and omits the ones set aside', async () => {
    apiMock.compare.mockResolvedValue(compareMet);
    renderCompare();

    const panel = (await screen.findByText('WHERE THE BEAM TIPS')).closest('.perf-panel') as HTMLElement;
    // Four headline measures in the fixture; the two set aside render a hatched
    // track rather than a bar, so the row is still there but claims nothing.
    expect(panel.querySelectorAll('.beam-aside').length).toBeGreaterThan(0);
    expect(panel.querySelectorAll('.beam-fill-you').length).toBe(1); // bid accuracy
    expect(panel.querySelectorAll('.beam-fill-level').length).toBe(1); // declaring

    // Figures print raw, in their own units. Read off the visible cells
    // specifically: the sr-only reading below each row repeats them, so a bare
    // text query would match twice.
    const figures = [...panel.querySelectorAll('.cmp-fig')].map((n) => n.textContent);
    expect(figures).toContain('71%');
    expect(figures).toContain('66%');
    expect(figures).toContain('1284'); // elo, unrounded and unsuffixed
    expect(figures).toContain('1341');
  });

  it('gives every row a text reading, since the bar itself is aria-hidden', async () => {
    apiMock.compare.mockResolvedValue(compareMet);
    renderCompare();

    // Called: names the leader, the margin, and the threshold it cleared.
    expect(
      await screen.findByText(/bid accuracy — you 71%, Marge 66%\. You lead by 5, past the 3.4 point threshold\./),
    ).toBeInTheDocument();
    // Level: says why no winner was named.
    expect(screen.getByText(/declaring —.*Too close to call.*inside the 12.3 point threshold\./)).toBeInTheDocument();
    // Set aside carries its reason rather than just vanishing.
    expect(screen.getByText(/nickel rating —.*needs more rated crossings first\./)).toBeInTheDocument();
    expect(screen.getByText(/defending —.*too few boards between you/i)).toBeInTheDocument();
  });

  it('summarises the verdict as chips and counts what was set aside', async () => {
    apiMock.compare.mockResolvedValue(compareMet);
    renderCompare();

    const verdict = (await screen.findByText('1 yours')).closest('.cmp-verdict') as HTMLElement;
    expect(within(verdict).getByText('1 theirs')).toBeInTheDocument();
    expect(within(verdict).getByText('1 level')).toBeInTheDocument();
    expect(verdict.textContent).toContain('3 are set aside for want of boards');
  });

  it('explains itself rather than erroring when a record is too thin', async () => {
    apiMock.compare.mockResolvedValue(compareThin);
    renderCompare(70);

    // Names the shortfall on the side that actually has it, with real numbers.
    expect(await screen.findByText(/Newcomer has 4 boards/)).toBeInTheDocument();
    expect(screen.getByText(/needs 16 from each of you/)).toBeInTheDocument();
    // No beam at all, and no empty panels left behind.
    expect(document.querySelectorAll('.beam')).toHaveLength(0);
    expect(screen.queryByText('WHERE THE BEAM TIPS')).not.toBeInTheDocument();
    // Still offers the one thing that does work: reading their record.
    expect(screen.getByText(/Read Newcomer's record/)).toHaveAttribute('href', '/players/70');
  });

  it('surfaces a failed load instead of hanging on the loader', async () => {
    apiMock.compare.mockRejectedValue(new Error('not signed in'));
    renderCompare();
    expect(await screen.findByText('not signed in')).toBeInTheDocument();
  });
});
