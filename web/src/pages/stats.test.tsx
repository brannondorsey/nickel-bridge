import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shortDate } from '../format';
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

  // The x axis is time — stats.ts orders every series by when this player
  // finished the crossing, never by tournament id — so its left end names the
  // date the line starts on. The ordinal it used to print ("10 tournaments
  // ago") described the old id ordering, and the count is already in the panel
  // heading and the LOOKBACK switch.
  it('captions each chart with the first point’s date rather than a tournament count', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    await screen.findByText('MATCHPOINTS — LAST 10 TOURNAMENTS');
    // Scoped to the three tournament-history charts (.chart-panel) — Card
    // Counting's own trend sparkline also renders a .sparkline-captions
    // element, but its points are quiz-ordinal, not tournament dates.
    const starts = Array.from(document.querySelectorAll('.chart-panel .sparkline-captions')).map(
      (el) => el.firstElementChild?.textContent ?? '',
    );
    expect(starts).toEqual([
      shortDate(playerStatsFull.pctSeries[0].finishedAt!),
      shortDate(playerStatsFull.eloSeries[0].finishedAt!),
      shortDate(playerStatsFull.accuracySeries[0].finishedAt!),
    ]);
    expect(document.body.textContent).not.toContain('tournaments ago');
  });

  describe('lookback window', () => {
    const longHistory = (n: number) => ({
      ...playerStatsFull,
      pctSeries: Array.from({ length: n }, (_, i) => ({
        tournamentId: i + 1,
        tournamentName: `Tournament #${i + 1}`,
        finishedAt: 1_780_000_000 + i * 86_400,
        pct: 50,
        boards: 4,
        fieldSize: 8,
      })),
    });
    const switchGroup = () => screen.getByRole('group', { name: 'Lookback window' });

    beforeEach(() => localStorage.clear());

    // The switch earns its place only once a window says something ALL doesn't.
    // The stock fixture has exactly 10 tournaments, so 10 is not yet distinct.
    it('stays hidden until a window would show something ALL does not', async () => {
      apiMock.playerStats.mockResolvedValue(playerStatsFull);
      renderStats();
      expect(await screen.findByText('MATCHPOINTS — LAST 10 TOURNAMENTS')).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Lookback window' })).not.toBeInTheDocument();
    });

    it('offers only the windows shorter than the history, plus ALL', async () => {
      apiMock.playerStats.mockResolvedValue(longHistory(40));
      renderStats();
      await screen.findByText('MATCHPOINTS — LAST 25 TOURNAMENTS');
      // 100 is longer than the 40 tournaments on file, so it would redraw ALL
      expect(within(switchGroup()).getAllByRole('button').map((b) => b.textContent)).toEqual(['10', '25', 'ALL']);
    });

    it('defaults to 25 and keeps the most recent crossings', async () => {
      apiMock.playerStats.mockResolvedValue(longHistory(40));
      renderStats();
      expect(await screen.findByText('MATCHPOINTS — LAST 25 TOURNAMENTS')).toBeInTheDocument();
      expect(within(switchGroup()).getByRole('button', { name: '25' })).toHaveAttribute('aria-pressed', 'true');
      // the tail, not the head — #40 is the latest point the scrubber reports
      expect(screen.getByRole('slider', { name: 'Matchpoints by tournament' })).toHaveAttribute(
        'aria-valuetext',
        expect.stringContaining('Tournament #40'),
      );
    });

    it('widens to the whole history on ALL and remembers the choice', async () => {
      apiMock.playerStats.mockResolvedValue(longHistory(40));
      const { unmount } = renderStats();
      await screen.findByText('MATCHPOINTS — LAST 25 TOURNAMENTS');
      await userEvent.click(within(switchGroup()).getByRole('button', { name: 'ALL' }));
      expect(screen.getByText('MATCHPOINTS — LAST 40 TOURNAMENTS')).toBeInTheDocument();

      unmount();
      renderStats();
      expect(await screen.findByText('MATCHPOINTS — LAST 40 TOURNAMENTS')).toBeInTheDocument();
    });

    // A stored 100 is meaningless on a 40-tournament history; it must not clamp
    // to a number the switch isn't offering.
    it('falls back to ALL when the stored window outgrew the history', async () => {
      localStorage.setItem('nb:lookback', '100');
      apiMock.playerStats.mockResolvedValue(longHistory(40));
      renderStats();
      expect(await screen.findByText('MATCHPOINTS — LAST 40 TOURNAMENTS')).toBeInTheDocument();
      expect(within(switchGroup()).getByRole('button', { name: 'ALL' })).toHaveAttribute('aria-pressed', 'true');
    });

    // The switch swaps a shorter series into the same Sparkline instance, so a
    // selection made against the longer one is out of range on the next render.
    // Unclamped that throws, and with no error boundary the whole page blanks.
    it('survives narrowing the window after a point is selected', async () => {
      apiMock.playerStats.mockResolvedValue(longHistory(40));
      renderStats();
      await screen.findByText('MATCHPOINTS — LAST 25 TOURNAMENTS');
      screen.getByRole('slider', { name: 'Matchpoints by tournament' }).focus(); // index 24 of 25
      await userEvent.click(within(switchGroup()).getByRole('button', { name: '10' }));

      expect(screen.getByText('MATCHPOINTS — LAST 10 TOURNAMENTS')).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: 'Matchpoints by tournament' })).toHaveAttribute('aria-valuenow', '9');
    });

    it('discloses the Elo replay only on a career-length rating chart', async () => {
      const restated = /can restate this line/;
      apiMock.playerStats.mockResolvedValue({
        ...longHistory(40),
        eloSeries: Array.from({ length: 40 }, (_, i) => ({
          tournamentId: i + 1,
          tournamentName: `Tournament #${i + 1}`,
          finishedAt: 1_780_000_000 + i * 86_400,
          elo: 1200 + i,
        })),
      });
      renderStats();
      await screen.findByText('MATCHPOINTS — LAST 25 TOURNAMENTS');
      expect(screen.queryByText(restated)).not.toBeInTheDocument();
      await userEvent.click(within(switchGroup()).getByRole('button', { name: 'ALL' }));
      expect(screen.getByText(restated)).toBeInTheDocument();
    });
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
    expect(index('BIDDING —') + 1).toBe(index('CONTRACTS MADE —'));
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
    // 137/214 → 64% — scoped to the grade rows, since Card Counting's own
    // medium-tier figure (also in the fixture) happens to round to the same
    // 64% elsewhere on the page.
    const grades = document.querySelector<HTMLElement>('.stats-grades');
    expect(grades).not.toBeNull();
    expect(within(grades!).getByText('64%')).toBeInTheDocument();
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
    // the weakest line is called out for practice (split across a glossary
    // link for "overcalls", so match the note's full text content directly)
    expect(ledger.querySelector('.stats-bidtypes-note')?.textContent).toMatch(/overcalls are the line to sharpen next/);

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
    // split across a glossary link for "Jacoby transfers"
    expect(document.querySelector('.stats-bidtypes-note')?.textContent).toMatch(/jacoby transfers could use a refresher/i);
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
    expect(within(declaring as HTMLElement).getByText('54 of 88 made')).toBeInTheDocument();
    const defending = within(tiles).getByText('DEFENDING').closest('.stat-tile')!;
    expect(within(defending as HTMLElement).getByText('52%')).toBeInTheDocument();
    expect(within(defending as HTMLElement).getByText('66 of 126 set')).toBeInTheDocument();
    expect(screen.getByText('TOURNAMENTS')).toBeInTheDocument();
    expect(screen.getByText(/better than 72% of 54 rated players/)).toBeInTheDocument();
  });

  it('orders the tile grid so the two personal-best tiles land together on the bottom row', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const tiles = (await screen.findByText('TOURNAMENTS')).closest('.stats-tiles') as HTMLElement;
    const labels = Array.from(tiles.querySelectorAll('.stat-tile-label')).map((el) => el.textContent);
    expect(labels).toEqual([
      'DECLARING',
      'DEFENDING',
      'TOURNAMENTS',
      'BOARDS',
      'STREAK',
      'AVG SCORE',
      'BEST CROSSING',
      'TOPS',
    ]);
    // STREAK sits one row up and one column left; the best-crossing/tops pair
    // is the final row (indices 6 and 7 of an 8-tile, 2-column grid) —
    // horizontal together on the bottom, best tournament beside best boards.
    expect(labels.indexOf('STREAK')).toBe(4);
    expect(labels.indexOf('BEST CROSSING')).toBe(6);
    expect(labels.indexOf('TOPS')).toBe(7);
  });

  it('shows the best crossing tile, linking to that tournament', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const best = (await screen.findByText('BEST CROSSING')).closest('.stat-tile')!;
    expect(within(best as HTMLElement).getByText('74%')).toBeInTheDocument();
    expect(within(best as HTMLElement).getByText('Tournament #9')).toBeInTheDocument();
    expect(best).toHaveAttribute('href', '/t/9');
  });

  it('counts tops as a rate over completed boards, linking to the most recent one', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const tops = (await screen.findByText('TOPS')).closest('.stat-tile')!;
    expect(within(tops as HTMLElement).getByText('31')).toBeInTheDocument();
    // 31 tops in 214 boards
    expect(within(tops as HTMLElement).getByText('1 in 7 boards')).toBeInTheDocument();
    expect(tops).toHaveAttribute('href', '/t/12/b/3');
  });

  it('prints the raw tally instead of a 1-in-N rate while the sample is tiny', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      totals: { ...playerStatsFull.totals, boardsCompleted: 4, tops: { count: 3, latest: { tournamentId: 2, boardNo: 4 } } },
    });
    renderStats();
    const tops = (await screen.findByText('TOPS')).closest('.stat-tile')!;
    // "1 in 1 boards" would round its way into claiming a clean sweep
    expect(within(tops as HTMLElement).getByText('3 of 4 boards')).toBeInTheDocument();
  });

  it('falls back gracefully — no link — when personal-best data is absent', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      totals: { ...playerStatsFull.totals, bestPct: null, tops: { count: 0, latest: null } },
    });
    renderStats();
    const best = (await screen.findByText('BEST CROSSING')).closest('.stat-tile')!;
    expect(within(best as HTMLElement).getByText('—')).toBeInTheDocument();
    expect(within(best as HTMLElement).getByText('no crossings yet')).toBeInTheDocument();
    expect(best.tagName).toBe('DIV');
    const tops = screen.getByText('TOPS').closest('.stat-tile')!;
    expect(within(tops as HTMLElement).getByText('0')).toBeInTheDocument();
    expect(within(tops as HTMLElement).getByText('no tops yet')).toBeInTheDocument();
    expect(tops.tagName).toBe('DIV');
  });

  it('renders the contract mix panel with tier rows, doubled tally, and strain split', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    expect(await screen.findByText('CONTRACTS MADE — 88 DECLARED')).toBeInTheDocument();
    // partscore: 38/51 -> 75%
    const partscore = screen.getByText('PARTSCORE').closest('.stats-contract-row')!;
    expect(within(partscore as HTMLElement).getByText('75%')).toBeInTheDocument();
    expect(within(partscore as HTMLElement).getByText('51 boards')).toBeInTheDocument();
    // doubled: 5/9 -> 56%
    const doubled = screen.getByText('DOUBLED').closest('.stats-contract-row')!;
    expect(within(doubled as HTMLElement).getByText('56%')).toBeInTheDocument();
    expect(within(doubled as HTMLElement).getByText('9 boards')).toBeInTheDocument();
    // strains: 21/45/22 of 88 -> 24%/51%/25% (NOTRUMP/MAJOR/MINOR are each
    // glossary links, so match the line's full text content directly)
    expect(document.querySelector('.stats-contracts-strains')?.textContent).toBe(
      'AS DECLARERNOTRUMP 24% · MAJOR 51% · MINOR 25%',
    );
    // "doubled" is a glossary link, splitting it from the trailing "too."
    expect(document.querySelector('.stats-contracts-note')?.textContent).toBe(
      'Redoubled crossings count as doubled too.',
    );
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
    expect(screen.queryByText(/^CONTRACTS MADE —/)).not.toBeInTheDocument();
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
    // "auction" is a glossary link, splitting it from the preceding text
    expect(document.querySelector('.stats-trickdelta-note')?.textContent).toMatch(/mark of an honest auction/);
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
    // The row carries two destinations now (profile, and Compare where both
    // records are thick enough), so the profile link is the NAME rather than
    // the whole row — a nested <a> would be invalid and the browser drops it.
    expect(within(dev as HTMLElement).getByText('Dev')).toHaveAttribute('href', '/players/51');
  });

  /**
   * Compare is offered from a rivalry row only when BOTH records clear
   * COMPARE_MIN_BOARDS — below that every measure on the comparison is set
   * aside, so the link would lead somewhere that has to apologise. The fixture
   * gives Marge 48 boards and Dev 7, either side of the floor.
   */
  it('offers Compare on rivalry rows only where both records are thick enough', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    const panel = (await screen.findByText('RIVALRIES')).closest('.stats-rivals') as HTMLElement;

    const marge = within(panel).getByText('Marge').closest('.stats-rival-row') as HTMLElement;
    expect(within(marge).getByText('COMPARE →')).toHaveAttribute('href', '/compare/50');

    const dev = within(panel).getByText('Dev').closest('.stats-rival-row') as HTMLElement;
    expect(within(dev).queryByText('COMPARE →')).not.toBeInTheDocument();
  });

  it('hides the rivalries panel when the player has no rivals yet', async () => {
    apiMock.playerStats.mockResolvedValue({ ...playerStatsFull, rivals: [] });
    renderStats();
    await screen.findByText('TOURNAMENTS');
    expect(screen.queryByText('RIVALRIES')).not.toBeInTheDocument();
  });

  // Sign-out and the appearance switch moved to the settings gate
  // (pages/Settings.tsx, settings.test.tsx); this page is the ledger now, so
  // neither belongs on it — on your own profile or anyone else's.
  it('carries no sign-out or appearance control on any profile', async () => {
    apiMock.playerStats.mockResolvedValue(playerStatsFull);
    renderStats();
    await screen.findByText('TOURNAMENTS');
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.queryByText('APPEARANCE')).not.toBeInTheDocument();
  });

  it('shows another player’s identity', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      user: { ...playerStatsFull.user, id: 7, handle: 'Alice' },
    });
    renderStats();
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(/Playing since/)).toBeInTheDocument();
  });

  it('never links the TOPS tile on another player’s page — the board URL is viewer-scoped', async () => {
    apiMock.playerStats.mockResolvedValue({
      ...playerStatsFull,
      user: { ...playerStatsFull.user, id: 7, handle: 'Alice' },
    });
    renderStats();
    // GET /t/:tid/b/:no serves the VIEWER's board of that number and creates
    // one if absent, so following Alice's top would deal the viewer into her
    // tournament. The count still shows; only the link is withheld.
    const tops = (await screen.findByText('TOPS')).closest('.stat-tile')!;
    expect(within(tops as HTMLElement).getByText('31')).toBeInTheDocument();
    expect(tops.tagName).toBe('DIV');
    // BEST CROSSING points at a tournament, which is viewer-agnostic — still linked
    expect(screen.getByText('BEST CROSSING').closest('.stat-tile')).toHaveAttribute('href', '/t/9');
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
    // personas never rate: no rating hero, no rating chart
    expect(screen.queryByText('NICKEL RATING')).not.toBeInTheDocument();
    expect(screen.queryByText('RATING BY TOURNAMENT')).not.toBeInTheDocument();
    // streak isn't Elo-specific, so it stays for house profiles too
    expect(screen.getByText('STREAK')).toBeInTheDocument();
    // matchpoint surfaces stay — the house competes on the scoresheet
    expect(screen.getByText('MATCHPOINTS — LAST 10 TOURNAMENTS')).toBeInTheDocument();
    // personal-best tiles aren't Elo-specific, so they stay for house profiles too
    expect(screen.getByText('BEST CROSSING')).toBeInTheDocument();
    expect(screen.getByText('TOPS')).toBeInTheDocument();
    // nor is the trick-delta stem plot
    expect(screen.getByText('TRICKS TAKEN — 88 CONTRACTS')).toBeInTheDocument();
    // nor the contract mix panel
    expect(screen.getByText('CONTRACTS MADE — 88 DECLARED')).toBeInTheDocument();
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
