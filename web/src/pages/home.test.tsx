import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  meFixture,
  meFreshCrosser,
  tournamentComplete,
  tournamentCompleteWithHouse,
  tournamentInProgress,
} from '../test/fixtures';
import { apiMock, renderWithMe } from '../test/utils';
import Lobby from './Lobby';
import type { Me } from '../api';

/** meFixture with the rating fields overridden — the tile's whole input. */
const withRating = (me: Me, over: Partial<NonNullable<Me['user']>>): Me => ({
  ...me,
  user: { ...me.user!, ...over },
});

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  get api() {
    return apiMock;
  },
}));

describe('Home', () => {
  it('shows the loading treatment while tournaments load', () => {
    apiMock.tournaments.mockReturnValue(new Promise(() => {}));
    renderWithMe(<Lobby />, { me: meFixture });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('opens the current crossing', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentInProgress, tournamentComplete] });
    renderWithMe(<Lobby />, { me: meFixture });
    // in-progress tournament → KEEP GOING with the stable e2e hook
    const cta = await screen.findByRole('link', { name: /keep going/i });
    expect(cta).toHaveAttribute('href', '/t/12');
    expect(cta.className).toContain('home-cta');
    expect(screen.getByText(/Board 2 of 4 in progress/)).toBeInTheDocument();
  });

  it('leads with the rating tile, and its drift as the ladder\'s own arrow', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentComplete] });
    renderWithMe(<Lobby />, { me: meFixture });
    expect(await screen.findByText('NICKEL RATING')).toBeInTheDocument();
    // the hero number is per-digit (FlipDigits), so it is read off the tile
    expect(document.querySelector('.home-rating .flipdigits')).toHaveTextContent('1487');
    // ▲, not "+4 SINCE YOUR LAST CROSSING" — glyph AND colour, matching
    // Leaderboard.tsx's Movement, with the period explained by the sheet
    const delta = screen.getByText('▲4');
    expect(delta).toHaveClass('positive');
    expect(screen.queryByText(/SINCE YOUR LAST CROSSING/)).not.toBeInTheDocument();
    // ...in place of the greeting, not beside it
    expect(screen.queryByText(/Good (morning|afternoon|evening), Margaret/)).not.toBeInTheDocument();
    expect(screen.queryByText('The bridge is open.')).not.toBeInTheDocument();
  });

  it('inks a slide while you were away with the down arrow', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentComplete] });
    renderWithMe(<Lobby />, { me: withRating(meFixture, { eloDrift: -7 }) });
    const delta = await screen.findByText('▼7');
    expect(delta).toHaveClass('negative');
  });

  // Zero is the ordinary answer on a quiet week, and an arrow reading zero is
  // a claim about nothing on a screen opened daily. Stats decides this the
  // other way for "+0 THIS MONTH" — see RatingTile.
  it('says nothing at all when nothing moved while you were away', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentComplete] });
    renderWithMe(<Lobby />, { me: withRating(meFixture, { eloDrift: 0 }) });
    expect(await screen.findByText('NICKEL RATING')).toBeInTheDocument();
    expect(document.querySelector('.rating-tile-delta')).toBeNull();
  });

  it('shows no delta before any crossing has finished', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentComplete] });
    renderWithMe(<Lobby />, { me: withRating(meFixture, { eloDrift: null }) });
    expect(await screen.findByText('NICKEL RATING')).toBeInTheDocument();
    expect(document.querySelector('.rating-tile-delta')).toBeNull();
  });

  // ELO_INITIAL is a starting value, not an achievement — a crossing only rates
  // you once a second human finishes the same field, so a player can have
  // crossings behind them and still be carrying 1200. The greeting holds until
  // there is a rating that was actually earned.
  it('keeps the greeting until a crossing has actually rated you', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentComplete] });
    renderWithMe(<Lobby />, { me: withRating(meFixture, { ratedTournaments: 0, eloDrift: null }) });
    expect(await screen.findByText(/Good (morning|afternoon|evening), Margaret/)).toBeInTheDocument();
    expect(screen.getByText('The bridge is open.')).toBeInTheDocument();
    expect(screen.queryByText('NICKEL RATING')).not.toBeInTheDocument();
  });

  // The arrow is the figure most likely to prompt "why did that move without
  // me?", so BOTH it and the label open the term that answers it — a door on
  // the label alone would put the explanation beside the one number that
  // doesn't need it.
  it('opens the rating-drift term from the label AND from the arrow', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentComplete] });
    renderWithMe(<Lobby />, { me: meFixture });
    expect(await screen.findByRole('button', { name: 'NICKEL RATING' })).toHaveClass('rating-tile-explain');
    expect(screen.getByRole('button', { name: '▲4' })).toHaveClass('rating-tile-explain');
  });

  // Nothing to explain without a rating, and nothing to click either.
  it('leaves the tile as plain text when there is no term to open', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentComplete] });
    renderWithMe(<Lobby />, { me: withRating(meFixture, { ratedTournaments: 0 }) });
    await screen.findByText('The bridge is open.');
    expect(screen.queryByRole('button', { name: 'NICKEL RATING' })).not.toBeInTheDocument();
  });

  it('lists finished crossings under TOLLS PAID with date, field, pct and rank', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentInProgress, tournamentComplete] });
    renderWithMe(<Lobby />, { me: meFixture });
    const row = (await screen.findByText('61%')).closest('a')!;
    // the row is ADDRESSED by id and NAMED by the display number — the two
    // differ in the fixture, so a regression to the id would show up here
    expect(row).toHaveAttribute('href', '/t/11');
    expect(within(row).getByText('8')).toHaveClass('tolls-no');
    expect(within(row).getByText(/· 3 players/)).toBeInTheDocument();
    expect(within(row).getByText('2ND')).toHaveClass('quiet');
  });

  it('counts house (benchmark AI) rows as players and ranks around them', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentCompleteWithHouse] });
    renderWithMe(<Lobby />, { me: meFixture });
    // 3 humans + 1 house row → "4 players", matching Tournament.tsx's full count
    const row = (await screen.findByText('61%')).closest('a')!;
    expect(within(row).getByText(/· 4 players/)).toBeInTheDocument();
    // The Shark's rank 2 pushes Margaret to 3rd
    expect(within(row).getByText('3RD')).toBeInTheDocument();
  });

  it('marks a win in the positive color', async () => {
    const won = {
      ...tournamentComplete,
      standings: tournamentComplete.standings.map((s) =>
        s.userId === 1 ? { ...s, rank: 1, totalPct: 71 } : { ...s, rank: 2 },
      ),
    };
    apiMock.tournaments.mockResolvedValue({ tournaments: [won] });
    renderWithMe(<Lobby />, { me: meFixture });
    expect(await screen.findByText('1ST')).toHaveClass('positive');
  });

  it('offers PLAY THE TOLL with a busy state when nothing is in progress', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentComplete] });
    let seat!: (v: { tournamentId: number; boardNo: number }) => void;
    apiMock.play.mockReturnValue(new Promise((resolve) => (seat = resolve)));
    renderWithMe(<Lobby />, { me: meFixture });
    const cta = await screen.findByRole('button', { name: /play the toll/i });
    expect(cta.className).toContain('home-cta');
    await userEvent.click(cta);
    expect(screen.getByRole('button', { name: /finding a table…/i })).toBeDisabled();
    seat({ tournamentId: 13, boardNo: 1 });
    await vi.waitFor(() => expect(apiMock.play).toHaveBeenCalled());
  });

  it('shows the empty state before any toll is paid', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [tournamentInProgress] });
    renderWithMe(<Lobby />, { me: meFixture });
    expect(await screen.findByText(/No tolls paid yet/)).toBeInTheDocument();
  });

  it('surfaces a load failure in the error treatment', async () => {
    apiMock.tournaments.mockRejectedValue(new Error('offline'));
    renderWithMe(<Lobby />, { me: meFixture });
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });

  // The club medal tier's copy names "the rankings" because 4 completed
  // tournaments is also this deployment's leaderboard quota — but DEMO=1
  // relaxes that quota to 1, so by the club tier a demo player has already
  // joined. me.provisionalMin (server/src/tournaments.ts's provisionalMin())
  // is how the widget knows which is true here; see MedalBar.tsx. boards: 1
  // clears the widget's own first-board gate below — meFreshCrosser's boards:
  // 0 would otherwise hide the widget entirely and these copy assertions
  // would never see it.
  it('names "the rankings" for the club tier when this deployment\'s quota matches it', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [] });
    renderWithMe(<Lobby />, {
      me: { ...meFreshCrosser, provisionalMin: 4, user: { ...meFreshCrosser.user!, boards: 1 } },
    });
    expect(await screen.findByText(/join the/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'rankings' })).toHaveAttribute('href', '/leaderboard');
  });

  it('names the medal instead, for the club tier, when this deployment\'s quota does not match it (demo)', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [] });
    renderWithMe(<Lobby />, {
      me: { ...meFreshCrosser, provisionalMin: 1, user: { ...meFreshCrosser.user!, boards: 1 } },
    });
    expect(await screen.findByText(/earn the/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'rankings' })).not.toBeInTheDocument();
  });

  // The widget itself is held back until the player has actually finished a
  // board — a fresh account's 0%-toward-club bar has nothing to show yet.
  it('hides the medal widget entirely before the first board is completed', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [] });
    renderWithMe(<Lobby />, { me: meFreshCrosser }); // boards: 0
    await screen.findByText('The bridge is open.'); // wait past the loading state
    expect(document.querySelector('.medal-bar')).toBeNull();
  });

  it('shows the medal widget once the first board is on the books', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [] });
    renderWithMe(<Lobby />, {
      me: { ...meFreshCrosser, user: { ...meFreshCrosser.user!, boards: 1 } },
    });
    expect(await screen.findByText(/more tournaments to/)).toBeInTheDocument();
    expect(document.querySelector('.medal-bar')).not.toBeNull();
  });

  // The fill's growing edge caps with a solid line (matching TrickArea's
  // trick-meter), but only once there's actually a filled portion to cap —
  // otherwise a fresh 0% bar would show a stray line at its left edge.
  it('shows no capped edge on a fresh 0% bar', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [] });
    renderWithMe(<Lobby />, {
      me: { ...meFreshCrosser, user: { ...meFreshCrosser.user!, boards: 1 } }, // medals.pct: 0
    });
    await screen.findByText(/more tournaments to/);
    expect(document.querySelector('.medal-bar-fill')).not.toHaveClass('capped');
  });

  it('caps the growing edge once the bar has an actual fill', async () => {
    apiMock.tournaments.mockResolvedValue({ tournaments: [] });
    renderWithMe(<Lobby />, { me: meFixture }); // medals.pct: 48
    await screen.findByText(/more tournaments to/);
    expect(document.querySelector('.medal-bar-fill')).toHaveClass('capped');
  });
});
