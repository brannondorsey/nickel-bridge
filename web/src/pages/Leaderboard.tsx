import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMe } from '../App';
import { api } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { BridgeMark } from '../components/ds/BridgeMark';
import { Loading } from '../components/ds/Loading';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';

interface Row {
  id: number;
  handle: string;
  picture: string | null;
  elo: number;
  rated_tournaments: number;
  played_tournaments: number;
  movement: number | null;
}

/** Rank movement since the previous rated tournament — glyph + color, never color alone. */
function Movement({ value }: { value: number | null }) {
  if (!value) return <span className="rank-move quiet">—</span>;
  if (value > 0) return <span className="rank-move positive">▲{value}</span>;
  return <span className="rank-move negative">▼{-value}</span>;
}

/** Rankings ("The field"): the all-time Elo ladder, one perforated row per player. */
export default function Leaderboard() {
  const { me } = useMe();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .leaderboard()
      .then((r) => setRows(r.leaderboard))
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load rankings'));
  }, []);

  return (
    <div className="rankings">
      <AppHeader context="RANKINGS" />
      {error ? <div className="notice-error">{error}</div> : null}
      {rows === null ? (
        error ? null : (
          <Loading />
        )
      ) : (
        <>
          <div className="rank-head">
            <div className="rank-title">The field</div>
            <div className="label-caps num">
              ALL-TIME · {rows.length} {rows.length === 1 ? 'PLAYER' : 'PLAYERS'}
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="empty-note">No one has crossed yet — rankings appear after the first tournament.</div>
          ) : (
            <PerforatedPanel className="rank-panel">
              {rows.map((r, i) => {
                const you = r.id === me?.user?.id;
                return (
                  <Link key={r.id} to={`/players/${r.id}`} className={`rank-row num ${you ? 'rank-row-you' : ''}`}>
                    <b className="rank-no">{i + 1}</b>
                    <span className="rank-name">
                      {r.handle}
                      {you ? ' — you' : ''}
                    </span>
                    <b className="rank-elo">{r.elo}</b>
                    <Movement value={r.movement} />
                  </Link>
                );
              })}
            </PerforatedPanel>
          )}
          <div className="rank-foot">
            <BridgeMark width={34} />
            <div className="rank-foot-text">
              Elo from head-to-head tournament results, re-ranked live as results come in.{' '}
              <span className="rank-foot-quiet">Everyone starts at 1200.</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
