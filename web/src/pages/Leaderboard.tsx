import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useMe } from '../App';

interface Row {
  id: number;
  name: string;
  picture: string | null;
  elo: number;
  rated_tournaments: number;
  played_tournaments: number;
}

export default function Leaderboard() {
  const { me } = useMe();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    api.leaderboard().then((r) => setRows(r.leaderboard));
  }, []);

  if (!rows) return <div className="spin" />;

  return (
    <div className="leader">
      <div className="hero">
        <h1>Rankings</h1>
        <p>Elo ratings from head-to-head tournament results. Everyone starts at 1200.</p>
      </div>
      <div className="card-box">
        <ol>
          {rows.map((r, i) => (
            <li key={r.id}>
              <span className="rankno">{i + 1}</span>
              <span className="lname">
                {r.id === me?.user?.id ? 'You' : r.name}
                <div className="lmeta">
                  {r.played_tournaments} tournament{r.played_tournaments === 1 ? '' : 's'} · {r.rated_tournaments} rated
                </div>
              </span>
              <span className="lelo">{r.elo}</span>
            </li>
          ))}
        </ol>
      </div>
      <p style={{ textAlign: 'center' }}>
        <Link to="/">Back to lobby</Link>
      </p>
    </div>
  );
}
