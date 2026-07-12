import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TournamentInfo, api } from '../api';
import { useMe } from '../App';
import { timeLeft } from './Lobby';

export default function Tournament() {
  const { tid } = useParams();
  const { me } = useMe();
  const [t, setT] = useState<TournamentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .tournament(Number(tid))
      .then(setT)
      .catch((e) => setError(e.message));
  }, [tid]);

  if (error) return <div className="notice">{error}</div>;
  if (!t) return <div className="spin" />;

  const meRow = t.standings.find((s) => s.userId === me?.user?.id);
  const myDone = meRow?.boardsDone ?? 0;

  return (
    <div className="lobby">
      <div className="hero">
        <h1>{t.name}</h1>
        <p>
          {t.status === 'open' ? `Open · ${timeLeft(t.closesAt)} — standings are provisional until it closes.` : 'Final results'}
        </p>
      </div>

      {t.status === 'open' && myDone < 4 ? (
        <Link to={`/t/${t.id}/b/${myDone + 1}`} className="btn btn-primary">
          {myDone === 0 ? 'Play board 1' : `Continue — board ${myDone + 1} of 4`}
        </Link>
      ) : null}

      <div className="card-box">
        <h2>Standings</h2>
        {t.standings.length === 0 ? (
          <div className="tmeta">No completed boards yet.</div>
        ) : (
          <table className="fieldtable">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th className="num">Boards</th>
                <th className="num">Total%</th>
              </tr>
            </thead>
            <tbody>
              {t.standings.map((s, i) => (
                <tr key={s.userId} className={s.userId === me?.user?.id ? 'me' : ''}>
                  <td>{s.complete ? (s.rank ?? i + 1) : '–'}</td>
                  <td>
                    {s.userId === me?.user?.id ? 'You' : s.name}
                    {!s.complete ? <span className="tmeta"> (in progress)</span> : ''}
                  </td>
                  <td className="num">{s.boardsDone}/4</td>
                  <td className="num">
                    {s.totalPct ?? '–'}
                    {s.totalPct != null ? (
                      <div className="pctbar">
                        <i style={{ width: `${s.totalPct}%` }} />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {myDone > 0 ? (
        <div className="card-box">
          <h2>My boards</h2>
          {Array.from({ length: myDone }, (_, i) => i + 1).map((no) => (
            <Link key={no} to={`/t/${t.id}/b/${no}`} className="trow">
              <span className="tname">Board {no}</span>
              <span className="tmeta">review →</span>
            </Link>
          ))}
        </div>
      ) : null}

      <Link to="/" className="btn btn-secondary">
        Lobby
      </Link>
    </div>
  );
}
