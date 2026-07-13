import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TournamentInfo, api } from '../api';
import { useMe } from '../App';

export default function Lobby() {
  const { me } = useMe();
  const navigate = useNavigate();
  const [tournaments, setTournaments] = useState<TournamentInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.tournaments().then((r) => setTournaments(r.tournaments));
  }, []);

  const play = async () => {
    setBusy(true);
    try {
      const { tournamentId, boardNo } = await api.play();
      navigate(`/t/${tournamentId}/b/${boardNo}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lobby">
      <div className="hero">
        <h1>Hi, {me?.user?.handle}</h1>
        <p>
          Four deals, robot partner &amp; opponents. Same deals as your friends — best matchpoint percentage wins.
        </p>
      </div>
      <button className="btn btn-primary" onClick={play} disabled={busy}>
        {busy ? 'Finding a table…' : 'Play'}
      </button>

      <div className="card-box">
        <h2>My tournaments</h2>
        {tournaments === null ? (
          <div className="spin" />
        ) : tournaments.length === 0 ? (
          <div className="tmeta">Nothing yet — hit Play to start your first tournament.</div>
        ) : (
          tournaments.map((t) => {
            const meRow = t.standings.find((s) => s.userId === me?.user?.id);
            const field = t.standings.filter((s) => s.complete).length;
            return (
              <Link key={t.id} to={`/t/${t.id}`} className="trow">
                <div>
                  <div className="tname">{t.name}</div>
                  <div className="tmeta">
                    {t.myDone}/4 boards
                    {meRow?.totalPct != null ? ` · ${meRow.totalPct}%` : ''}
                    {meRow?.rank ? ` · #${meRow.rank} of ${field}` : ''}
                  </div>
                </div>
                <span className="badge open">{(t.myDone ?? 0) < 4 ? 'continue' : 'live'}</span>
              </Link>
            );
          })
        )}
      </div>

      <Link to="/leaderboard" className="btn btn-secondary">
        Overall rankings
      </Link>
    </div>
  );
}

