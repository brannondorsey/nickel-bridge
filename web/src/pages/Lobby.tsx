import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMe } from '../App';
import { TournamentInfo, api } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { Loading } from '../components/ds/Loading';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { TicketStub } from '../components/ds/TicketStub';
import { BoardTicketRow } from '../components/game/BoardTicketRow';
import { ordinal, shortDate, timeGreeting, tournamentNo } from '../format';

const tourneyNo = (t: TournamentInfo) => tournamentNo(t.name, t.id);

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
          <div className="home-greeting">
            <div className="home-hello">
              Good {timeGreeting(new Date().getHours())}, {me?.user?.handle}
            </div>
            <div className="home-sub">The bridge is open.</div>
          </div>

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

          {current ? (
            <div className="home-gate">
              {/* placement is scored, not sequential — the next tourney's number is unknowable */}
              <BoardTicketRow
                no="?"
                state="sealed"
                counterLabel="TOURNEY"
                main={`Opens when you finish #${tourneyNo(current)} — one crossing at a time`}
              />
            </div>
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
                    return (
                      <Link key={t.id} to={`/t/${t.id}`} className="tolls-row num">
                        <b className="tolls-no">{tourneyNo(t)}</b>
                        <span className="tolls-meta">
                          {when ? shortDate(when) : '—'} · {t.standings.length}{' '}
                          {t.standings.length === 1 ? 'pair' : 'pairs'}
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
