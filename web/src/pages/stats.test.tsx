import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { meFixture, playerStatsEmpty, playerStatsFull } from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Player from './Player';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

const renderStats = (me = meFixture) => renderWithMe(<Player />, { me, route: '/players/1' });

describe('Stats', () => {
  it('shows the rating hero with flip digits and the monthly delta', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    expect(await screen.findByText('NICKEL RATING')).toBeInTheDocument();
    // 1487 rendered one flip digit per numeral
    const hero = document.querySelector('.player-hero')!;
    expect(within(hero as HTMLElement).getByText('4')).toBeInTheDocument();
    expect(screen.getByText('+34 THIS MONTH')).toHaveClass('positive');
  });

  it('hides the monthly delta when unrated and shows a negative month in red', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      totals: { ...playerStatsFull.totals, monthlyEloDelta: -12 },
    });
    renderStats();
    expect(await screen.findByText('−12 THIS MONTH')).toHaveClass('negative');
  });

  it('renders three sparkline panels with their reference captions', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    expect(await screen.findByText('MATCHPOINTS — LAST 10 TOURNAMENTS')).toBeInTheDocument();
    expect(screen.getByText('Ø 57%')).toBeInTheDocument();
    expect(screen.getByText('- - field average 50%')).toBeInTheDocument();
    expect(screen.getByText('RATING BY TOURNAMENT')).toBeInTheDocument();
    expect(screen.getByText('PEAK 1502')).toBeInTheDocument();
    expect(screen.getByText('- - start 1200')).toBeInTheDocument();
    expect(screen.getByText('BID ACCURACY')).toBeInTheDocument();
  });

  it('shows the toll log with the window total baked into the heading', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    // count is a function of "now" vs. the fixture's dates, so assert the
    // shape rather than a specific number (see DayGrid's windowing doc).
    expect(await screen.findByText(/TOLL LOG — \d+ TOLLS? THIS SEASON/)).toBeInTheDocument();
  });

  it('puts the toll log first, keeps the bidding charts together, and hoists contracts right under bidding', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    await screen.findByText('TOURNAMENTS');
    const headings = Array.from(document.querySelectorAll('.chart-panel-head .label-caps, .perf-panel-heading')).map(
      (el) => el.textContent ?? '',
    );
    const index = (prefix: string) => headings.findIndex((h) => h.startsWith(prefix));
    expect(index('TOLL LOG')).toBe(0);
    // toll log no longer sits between the two bidding sections
    expect(index('BID ACCURACY') + 1).toBe(index('BIDDING —'));
    // contracts hoisted to right under the two bidding sections
    expect(index('BIDDING —') + 1).toBe(index('CONTRACTS —'));
  });

  it('renders the toll log on a house profile too — nothing here is Elo-specific', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      user: { ...playerStatsFull.user, kind: 'ai' },
    });
    renderStats();
    expect(await screen.findByText(/TOLL LOG —/)).toBeInTheDocument();
  });

  it('notes the last-played date when the display window has no activity but the player has history', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      dailyBoards: [{ date: '2020-01-15', count: 3 }],
    });
    renderStats();
    expect(await screen.findByText('TOLL LOG — 0 TOLLS THIS SEASON')).toBeInTheDocument();
    expect(screen.getByText(/Quiet lately — the last toll paid was/)).toBeInTheDocument();
  });

  it('shows four graded-call rows including the ✗ row', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    expect(await screen.findByText('BIDDING — 214 CALLS GRADED')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /of 3 stars/ })).toHaveLength(4);
    expect(screen.getByText('✗')).toBeInTheDocument();
    // 137/214 → 64%
    expect(screen.getByText('64%')).toBeInTheDocument();
  });

  it('unfolds the bid-type ledger on tap, ranked best to worst, and folds it back', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const toggle = await screen.findByRole('button', { name: /bidding ledger/i });
    expect(screen.queryByText('★★ OR BETTER — BY BID TYPE')).not.toBeInTheDocument();

    await userEvent.click(toggle);
    const ledger = screen.getByText('★★ OR BETTER — BY BID TYPE').closest('.stats-bidtypes')!;
    // rows keep the server's best-to-worst order
    const labels = [...ledger.querySelectorAll('.stats-bidtype-label')].map((el) => el.textContent);
    expect(labels).toEqual(['OPENINGS', 'PASSES', 'RESPONSES', 'REBIDS', 'DOUBLES', 'OVERCALLS']);
    // 40/41 → 98%, with its sample size alongside
    expect(within(ledger as HTMLElement).getByText('98%')).toBeInTheDocument();
    expect(within(ledger as HTMLElement).getByText('41 calls')).toBeInTheDocument();
    // the weakest line is called out for practice
    expect(within(ledger as HTMLElement).getByText(/overcalls are the line to sharpen next/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /fold the ledger away/i }));
    expect(screen.queryByText('★★ OR BETTER — BY BID TYPE')).not.toBeInTheDocument();
  });

  it('keeps the bidding panel inert when there is no bid-type data', async () => {
    apiMock.playerStats.mockResolvedValue({ ...playerStatsFull, bidTypes: [], conventions: [] });
    renderStats();
    await screen.findByText('BIDDING — 214 CALLS GRADED');
    expect(screen.queryByText(/ledger by bid type/i)).not.toBeInTheDocument();
  });

  it('shows a convention tab alongside bid type and switches between them', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    await userEvent.click(await screen.findByText(/Tap for the bidding ledger/));
    expect(screen.getByRole('tab', { name: 'BID TYPE' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'CONVENTION' }));
    expect(screen.getByText('STAYMAN')).toBeInTheDocument();
    expect(screen.getByText('89%')).toBeInTheDocument(); // 8/9
    expect(screen.queryByText('OPENINGS')).not.toBeInTheDocument();
    expect(screen.getByText(/jacoby transfers could use a refresher/)).toBeInTheDocument();
  });

  it('omits the convention tab when the player has no graded conventions', async () => {
    apiMock.playerStats.mockResolvedValue({ ...playerStatsFull, conventions: [] });
    renderStats();
    await userEvent.click(await screen.findByText(/Tap for the ledger by bid type/));
    expect(screen.queryByRole('tab', { name: 'CONVENTION' })).not.toBeInTheDocument();
    expect(screen.getByText('★★ OR BETTER — BY BID TYPE')).toBeInTheDocument();
  });

  it('computes declaring/defending tiles from the play record', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const tiles = (await screen.findByText('TOURNAMENTS')).closest('.stats-tiles') as HTMLElement;
    const declaring = within(tiles).getByText('DECLARING').closest('.stat-tile')!;
    expect(within(declaring as HTMLElement).getByText('61%')).toBeInTheDocument();
    expect(within(declaring as HTMLElement).getByText('88 boards')).toBeInTheDocument();
    const defending = within(tiles).getByText('DEFENDING').closest('.stat-tile')!;
    expect(within(defending as HTMLElement).getByText('52%')).toBeInTheDocument();
    expect(screen.getByText('TOURNAMENTS')).toBeInTheDocument();
    expect(screen.getByText(/better than 72% of 54 rated players/)).toBeInTheDocument();
  });

  it('orders the tile grid so best and toughest crossing land together on the bottom row', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const tiles = (await screen.findByText('TOURNAMENTS')).closest('.stats-tiles') as HTMLElement;
    const labels = Array.from(tiles.querySelectorAll('.stat-tile-label')).map((el) => el.textContent);
    expect(labels).toEqual([
      'DECLARING',
      'DEFENDING',
      'TOURNAMENTS',
      'BOARDS',
      'RATED',
      'AVG SCORE',
      'BEST CROSSING',
      'TOUGHEST CROSSING',
    ]);
    // RATED moved up one row and left one column; best/toughest are now the
    // final row (indices 6 and 7 of an 8-tile, 2-column grid) — horizontal
    // together on the bottom.
    expect(labels.indexOf('RATED')).toBe(4);
    expect(labels.indexOf('BEST CROSSING')).toBe(6);
    expect(labels.indexOf('TOUGHEST CROSSING')).toBe(7);
  });

  it('shows the best and toughest crossing tiles, each linking to that tournament', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const best = (await screen.findByText('BEST CROSSING')).closest('.stat-tile')!;
    expect(within(best as HTMLElement).getByText('74%')).toBeInTheDocument();
    expect(within(best as HTMLElement).getByText('Tournament #9')).toBeInTheDocument();
    expect(best).toHaveAttribute('href', '/t/9');
    const worst = screen.getByText('TOUGHEST CROSSING').closest('.stat-tile')!;
    expect(within(worst as HTMLElement).getByText('31%')).toBeInTheDocument();
    expect(within(worst as HTMLElement).getByText('Tournament #4')).toBeInTheDocument();
    expect(worst).toHaveAttribute('href', '/t/4');
  });

  it('falls back gracefully — no link — when personal-best data is absent', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      totals: { ...playerStatsFull.totals, bestPct: null, worstPct: null },
    });
    renderStats();
    const best = (await screen.findByText('BEST CROSSING')).closest('.stat-tile')!;
    expect(within(best as HTMLElement).getByText('—')).toBeInTheDocument();
    expect(within(best as HTMLElement).getByText('no crossings yet')).toBeInTheDocument();
    expect(best.tagName).toBe('DIV');
  });

  it('renders the contract mix panel with tier rows, doubled tally, and strain split', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    expect(await screen.findByText('CONTRACTS — 88 DECLARED')).toBeInTheDocument();
    // partscore: 38/51 -> 75%
    const partscore = screen.getByText('PARTSCORE').closest('.stats-contract-row')!;
    expect(within(partscore as HTMLElement).getByText('75%')).toBeInTheDocument();
    expect(within(partscore as HTMLElement).getByText('51 boards')).toBeInTheDocument();
    // doubled: 5/9 -> 56%
    const doubled = screen.getByText('DOUBLED').closest('.stats-contract-row')!;
    expect(within(doubled as HTMLElement).getByText('56%')).toBeInTheDocument();
    expect(within(doubled as HTMLElement).getByText('9 boards')).toBeInTheDocument();
    // strains: 21/45/22 of 88 -> 24%/51%/25%
    expect(screen.getByText('NOTRUMP 24% · MAJOR 51% · MINOR 25%')).toBeInTheDocument();
    expect(screen.getByText('Redoubled crossings count as doubled too.')).toBeInTheDocument();
  });

  it('shows an em-dash for an untouched contract tier', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      contractMix: { ...playerStatsFull.contractMix, slam: { boards: 0, made: 0 } },
    });
    renderStats();
    const slam = (await screen.findByText('SLAM')).closest('.stats-contract-row')!;
    expect(within(slam as HTMLElement).getByText('—')).toBeInTheDocument();
    expect(within(slam as HTMLElement).getByText('0 boards')).toBeInTheDocument();
  });

  it('hides the contracts panel when the player has never declared', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      totals: { ...playerStatsFull.totals, declarer: { boards: 0, made: 0 } },
      contractMix: {
        partscore: { boards: 0, made: 0 },
        game: { boards: 0, made: 0 },
        slam: { boards: 0, made: 0 },
        doubled: { boards: 0, made: 0 },
        strains: { notrump: 0, major: 0, minor: 0 },
      },
    });
    renderStats();
    await screen.findByText('TOURNAMENTS');
    expect(screen.queryByText(/^CONTRACTS —/)).not.toBeInTheDocument();
  });

  it('renders the declaring trick-delta stem plot, bucketed and averaged', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    expect(await screen.findByText('TRICKS TAKEN — 88 CONTRACTS')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    // 20/88 -> 23%
    expect(screen.getByText('23%')).toBeInTheDocument();
    expect(screen.getByText(/\+2: 23% — 20 boards/)).toBeInTheDocument();
    expect(screen.getByText('Ø +0.3')).toBeInTheDocument();
    expect(screen.getByText(/mark of an honest auction/)).toBeInTheDocument();
  });

  it('hides the trick-delta panel when the player has no declaring boards', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      trickDelta: playerStatsEmpty.trickDelta,
    });
    renderStats();
    await screen.findByText('TOURNAMENTS');
    expect(screen.queryByText(/TRICKS TAKEN —/)).not.toBeInTheDocument();
  });

  it('renders the rivalries panel with handle, record, and a HOUSE tag on an AI rival', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const panel = (await screen.findByText('RIVALRIES')).closest('.stats-rivals') as HTMLElement;
    // The Novice: ai, 6 shared, 4-2 ahead
    const novice = within(panel).getByText('The Novice').closest('.stats-rival-row')!;
    expect(within(novice as HTMLElement).getByText('HOUSE')).toBeInTheDocument();
    expect(within(novice as HTMLElement).getByText('4-2')).toBeInTheDocument();
    expect(within(novice as HTMLElement).getByText('Crossed paths 6 times — ahead 4-2.')).toBeInTheDocument();
    // Marge: human, 5 shared, 2-2-1 tied
    const marge = within(panel).getByText('Marge').closest('.stats-rival-row')!;
    expect(within(marge as HTMLElement).queryByText('HOUSE')).not.toBeInTheDocument();
    expect(within(marge as HTMLElement).getByText('2-2-1')).toBeInTheDocument();
    expect(
      within(marge as HTMLElement).getByText('Crossed paths 5 times — dead even 2-2 (1 tied).'),
    ).toBeInTheDocument();
    // Dev: human, 4 shared, 1-3 behind
    const dev = within(panel).getByText('Dev').closest('.stats-rival-row')!;
    expect(within(dev as HTMLElement).getByText('1-3')).toBeInTheDocument();
    expect(within(dev as HTMLElement).getByText('Crossed paths 4 times — behind 1-3.')).toBeInTheDocument();
    // links to the rival's own profile
    expect(dev).toHaveAttribute('href', '/players/51');
  });

  it('hides the rivalries panel when the player has no rivals yet', async () => {
    apiMock.playerStats.mockResolvedValue({ ...playerStatsFull, rivals: [] });
    renderStats();
    await screen.findByText('TOURNAMENTS');
    expect(screen.queryByText('RIVALRIES')).not.toBeInTheDocument();
  });

  it('offers sign-out to the owner only', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    apiMock.logout.mockResolvedValue({ ok: true });
    const { refresh } = renderStats();
    await userEvent.click(await screen.findByRole('button', { name: /sign out/i }));
    expect(apiMock.logout).toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('hides sign-out on another player’s page and shows their identity', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      user: { ...playerStatsFull.user, id: 7, handle: 'Alice' },
    });
    renderStats();
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(/Learning since/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('hides every Elo surface on a house (benchmark AI) profile', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      user: { ...playerStatsFull.user, id: 90, handle: 'The Shark', kind: 'ai' },
      percentiles: { ...playerStatsFull.percentiles, elo: null },
    });
    renderStats();
    expect(await screen.findByText('The Shark')).toBeInTheDocument();
    // scoped to the hero: the RIVALRIES panel also reuses the HOUSE tag, on an unrelated rival row
    const hero = document.querySelector('.player-hero')!;
    expect(within(hero as HTMLElement).getByText('HOUSE')).toBeInTheDocument();
    expect(screen.getByText(/House player/)).toBeInTheDocument();
    // personas never rate: no rating hero, no rating chart, no RATED tile
    expect(screen.queryByText('NICKEL RATING')).not.toBeInTheDocument();
    expect(screen.queryByText('RATING BY TOURNAMENT')).not.toBeInTheDocument();
    expect(screen.queryByText('RATED')).not.toBeInTheDocument();
    // matchpoint surfaces stay — the house competes on the scoresheet
    expect(screen.getByText('MATCHPOINTS — LAST 10 TOURNAMENTS')).toBeInTheDocument();
    // personal-best tiles aren't Elo-specific, so they stay for house profiles too
    expect(screen.getByText('BEST CROSSING')).toBeInTheDocument();
    expect(screen.getByText('TOUGHEST CROSSING')).toBeInTheDocument();
    // nor is the trick-delta stem plot
    expect(screen.getByText('TRICKS TAKEN — 88 CONTRACTS')).toBeInTheDocument();
    // nor the contract mix panel
    expect(screen.getByText('CONTRACTS — 88 DECLARED')).toBeInTheDocument();
    // nor the toll log calendar
    expect(screen.getByText(/TOLL LOG —/)).toBeInTheDocument();
    // nor the rivalries panel
    expect(screen.getByText('RIVALRIES')).toBeInTheDocument();
  });

  it('invites the owner to play their first board when empty', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsEmpty);
    renderStats();
    const cta = await screen.findByRole('link', { name: /play your first board/i });
    expect(cta).toHaveAttribute('href', '/');
  });

  it('shows a not-found error for a missing player', async () => {
    apiMock.playerStats.mockRejectedValue(new Error('404'));
    renderStats();
    expect(await screen.findByText('Player not found.')).toBeInTheDocument();
  });
});
