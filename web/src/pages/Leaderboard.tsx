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

interface LeaderboardData {
  leaderboard: Row[];
  /** the benchmark house personas — beside the ladder, never on it */
  house: { id: number; handle: string; picture: string | null }[];
  provisionalMin: number;
  /** null when nobody is signed in — the ladder reads without an account */
  yourRatedTournaments: number | null;
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
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .leaderboard()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load rankings'));
  }, []);

  const signedIn = Boolean(me?.user);
  const rows = data?.leaderboard ?? null;
  // Signed out there is no "you" to be provisional about, so the note is
  // suppressed rather than shown at 0 of 4 — hence the null check and not a
  // falsy one, since 0 is a real count for a signed-in player who has yet to
  // finish a tournament.
  const stillProvisional = data?.yourRatedTournaments != null && data.yourRatedTournaments < data.provisionalMin;

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
          {stillProvisional ? (
            <div className="rank-provisional-note">
              You'll join the field once you've completed {data!.provisionalMin}{' '}
              {data!.provisionalMin === 1 ? 'crossing' : 'crossings'} — {data!.yourRatedTournaments} of{' '}
              {data!.provisionalMin} so far.
            </div>
          ) : null}
          {rows.length === 0 ? (
            <div className="empty-note">No one has crossed yet — rankings appear after the first tournament.</div>
          ) : (
            <PerforatedPanel className="rank-panel">
              {rows.map((r, i) => {
                const you = r.id === me?.user?.id;
                const content = (
                  <>
                    <b className="rank-no">{i + 1}</b>
                    <span className="rank-name">
                      {r.handle}
                      {you ? ' — you' : ''}
                    </span>
                    <b className="rank-elo">{r.elo}</b>
                    <Movement value={r.movement} />
                  </>
                );
                // Signed out the ladder is readable but the players on it are
                // not: a real person's profile needs an account (server/src/app.ts).
                // Rows stay unlinked rather than leading everyone to the same
                // sign-in wall — an invitation is fine once, twenty of them in a
                // list is a page of dead ends.
                return signedIn ? (
                  <Link key={r.id} to={`/players/${r.id}`} className={`rank-row num ${you ? 'rank-row-you' : ''}`}>
                    {content}
                  </Link>
                ) : (
                  <div key={r.id} className="rank-row num">
                    {content}
                  </div>
                );
              })}
            </PerforatedPanel>
          )}
          {/* The house: not on the ladder (personas never rate, so there is
              nothing to rank them by) but always at the table, and the one
              record a visitor without an account can actually open. */}
          {data?.house.length ? (
            <PerforatedPanel heading="THE HOUSE — ALWAYS AT THE TABLE" className="rank-house">
              {data.house.map((h) => (
                <Link key={h.id} to={`/players/${h.id}`} className="rank-row num rank-row-house">
                  <span className="rank-name">
                    {h.handle}
                    <span className="house-tag">HOUSE</span>
                  </span>
                  <span className="rank-house-cue" aria-hidden="true">
                    →
                  </span>
                </Link>
              ))}
            </PerforatedPanel>
          ) : null}
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
