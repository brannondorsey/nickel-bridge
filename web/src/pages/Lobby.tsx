import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMe } from '../App';
import { TournamentInfo, api } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { Loading } from '../components/ds/Loading';
import { MedalBar } from '../components/ds/MedalBar';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { RatingTile } from '../components/ds/RatingTile';
import { TicketStub } from '../components/ds/TicketStub';
import { ordinal, shortDate, timeGreeting, tournamentNo } from '../format';

const tourneyNo = (t: TournamentInfo) => tournamentNo(t.number, t.id);

/**
 * How long after finishing a crossing the rating tile still reads "in the last
 * crossing" — the window in which the swing you just earned is what you came
 * back to the front door to see.
 */
const FRESH_CROSSING_S = 60 * 60;

/**
 * Which of the tile's two readings Home is showing, and with what number.
 *
 * The rating moves for two different reasons and the tile names which one:
 * your own last crossing ("▲12 in the last crossing") or the evergreen replay
 * restating history around you while you were away ("▼7 since your last
 * crossing" — see eloDrift in server/src/tournaments.ts).
 *
 * The crossing reading wins for an hour after you finish one, because that is
 * the figure you came back for. After that it KEEPS winning until drift is
 * actually non-zero: drift is 0 on any quiet week, and a tile that fell silent
 * an hour after every crossing would spend most of its life blank on the one
 * screen a player opens daily. So the hand-off is an event — somebody else's
 * play moving your rating — rather than a stopwatch.
 *
 * Note the two figures are complements, never a sum: stampCrossingBaseline
 * folds a crossing's own swing into the drift baseline the moment it ends, so
 * whichever is showing, the other is either zero or already spent.
 *
 * `delta` null means there is nothing to report — a rare resting state (a
 * crossing that moved the rating exactly nowhere, or one that has yet to rate
 * anybody) where the line falls back to reading NICKEL RATING.
 */
export function ratingReading(
  user: { eloDrift: number | null; lastCrossing: { delta: number; finishedAt: number } | null },
  nowSec: number,
): { delta: number | null; caption: string } {
  const drift = user.eloDrift ?? 0;
  const last = user.lastCrossing;
  const fresh = last !== null && nowSec - last.finishedAt < FRESH_CROSSING_S;
  return fresh || drift === 0
    ? { delta: last && last.delta !== 0 ? last.delta : null, caption: 'in the last crossing' }
    : { delta: drift, caption: 'since your last crossing' };
}

/**
 * Home ("the bridge is open"): one live crossing at a time. The current
 * tournament is the toll gate — KEEP GOING when one is unfinished, PLAY THE
 * TOLL to be seated at a table otherwise — with every finished crossing
 * receipted below under TOLLS PAID.
 */
export default function Lobby() {
  const { me } = useMe();
  const navigate = useNavigate();
  const [tournaments, setTournaments] = useState<TournamentInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .tournaments()
      .then((r) => setTournaments(r.tournaments))
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load tournaments'));
  }, []);

  const play = async () => {
    setBusy(true);
    setError(null);
    try {
      const { tournamentId, boardNo } = await api.play();
      navigate(`/t/${tournamentId}/b/${boardNo}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to find a table');
      setBusy(false);
    }
  };

  // Non-null exactly when there is a rating worth leading with — see the note
  // beside the tile below for why `ratedTournaments` is the test.
  const rated = me?.user && me.user.ratedTournaments > 0 ? me.user : null;
  // Read once per render rather than on a timer: nothing on this screen changes
  // at the hour mark on its own (drift is what hands the caption over, and that
  // arrives with a fresh /api/me), so a ticking clock would buy a re-render
  // that says the same thing.
  const reading = rated ? ratingReading(rated, Math.floor(Date.now() / 1000)) : null;

  const current = tournaments?.find((t) => (t.myDone ?? 0) < 4) ?? null;
  const finished = (tournaments ?? [])
    .filter((t) => t.myDone === 4)
    .sort((a, b) => (b.myLastPlayedAt ?? b.createdAt ?? 0) - (a.myLastPlayedAt ?? a.createdAt ?? 0));

  return (
    <div className="home">
      <AppHeader />
      {error ? <div className="notice-error">{error}</div> : null}
      {tournaments === null ? (
        error ? null : (
          <Loading />
        )
      ) : (
        <>
          {/* The front door leads with the rating once there is one to lead
              with, and with the greeting before that. `ratedTournaments` is
              the test rather than `boards` or the medal rail's tournament
              count: a crossing only rates you once a second human finishes the
              same field, so a player can have several crossings behind them
              and still be carrying ELO_INITIAL — and 1200 presented as a hero
              figure claims an achievement that hasn't happened. The greeting
              is the honest thing to show until it has.

              Note what the tile does NOT do for the not-yet-ranked: it makes
              no promise about the ladder. The medal rail immediately below
              already says "Complete N more tournaments to join the rankings",
              and a second copy of that sentence up here is exactly the
              redundancy that retired the old sealed "TOURNEY ?" hint from this
              screen. */}
          {rated ? (
            <div className="home-rating">
              <RatingTile
                elo={rated.elo}
                // Which figure, and which of the two captions names it, is
                // ratingReading's call — see its note above. A zero says
                // nothing at all rather than drawing an arrow that claims
                // nothing moved, which is also the one state where the line
                // falls back to the NICKEL RATING label (RatingTile's note
                // covers why Stats decides that differently for "+0 THIS
                // MONTH").
                delta={reading!.delta}
                // Lowercase, and IN PLACE of the label rather than beside it:
                // the ticker directly above already says what the number is,
                // where what moved it is the thing a returning player is
                // actually here to read. 'rating-drift' — opened by the delta,
                // and by the label on the days it stands in — is where both
                // periods get explained.
                deltaCaption={reading!.caption}
                explainTerm="rating-drift"
              />
            </div>
          ) : (
            <div className="home-greeting">
              <div className="home-hello">
                Good {timeGreeting(new Date().getHours())}, {me?.user?.handle}
              </div>
              <div className="home-sub">The bridge is open.</div>
            </div>
          )}

          <div className="home-current">
            <div className="home-current-row">
              <TicketStub label="OPEN NOW" value="4 boards" width={132} />
              <div className="home-current-text">
                {current ? (
                  <>
                    {current.name}
                    <br />
                    <span className="home-current-sub num">
                      Board {Math.min((current.myDone ?? 0) + 1, 4)} of 4 in progress — your call
                    </span>
                  </>
                ) : (
                  <>
                    Your next tournament
                    <br />
                    <span className="home-current-sub">
                      Four deals, robot partner &amp; opponents — same deals as your friends.
                    </span>
                  </>
                )}
              </div>
            </div>
            {current ? (
              <Button to={`/t/${current.id}`} className="home-cta">
                KEEP GOING →
              </Button>
            ) : (
              <Button onClick={play} busy={busy} busyLabel="FINDING A TABLE…" className="home-cta">
                PLAY THE TOLL →
              </Button>
            )}
          </div>

          {/* Held back until the first board is actually on the books — a brand-new
              account's 0%-toward-club bar has nothing to show yet, and greeting a
              first-time visitor with a progress rail before they've played a card
              reads as clutter rather than as an incentive. */}
          {me?.user?.medals && me.user.boards > 0 ? (
            <MedalBar progress={me.user.medals} provisionalMin={me.provisionalMin} />
          ) : null}

          <div className="home-tolls">
            <div className="label-caps">TOLLS PAID</div>
            {finished.length === 0 ? (
              <div className="empty-note">No tolls paid yet — your first finished tournament lands here.</div>
            ) : (
              <>
                <PerforatedPanel className="tolls-panel">
                  {finished.map((t) => {
                    const mine = t.standings.find((s) => s.userId === me?.user?.id);
                    const when = t.myLastPlayedAt ?? t.createdAt;
                    // House (benchmark AI) rows count as players — full field
                    // members, matching Tournament.tsx.
                    const players = t.standings.length;
                    return (
                      <Link key={t.id} to={`/t/${t.id}`} className="tolls-row num">
                        <b className="tolls-no">{tourneyNo(t)}</b>
                        <span className="tolls-meta">
                          {when ? shortDate(when) : '—'} · {players} {players === 1 ? 'player' : 'players'}
                        </span>
                        <b className="tolls-pct">{mine?.totalPct != null ? `${mine.totalPct}%` : '—'}</b>
                        <span className={`tolls-rank ${mine?.rank === 1 ? 'positive' : 'quiet'}`}>
                          {mine?.rank ? ordinal(mine.rank) : '—'}
                        </span>
                      </Link>
                    );
                  })}
                </PerforatedPanel>
                <div className="home-tolls-note">Tap a crossing to revisit its boards.</div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
