import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PlayerStats, api } from '../api';
import { useMe } from '../App';
import TrendChart from '../components/TrendChart';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** first-half vs second-half improvement, only meaningful with enough points */
function improvement(values: number[]): number | null {
  if (values.length < 6) return null;
  const half = Math.floor(values.length / 2);
  return Math.round(mean(values.slice(half)) - mean(values.slice(0, half)));
}

const GRADES = [
  { key: 'excellent', label: 'Excellent', color: 'var(--good)' },
  { key: 'good', label: 'Good', color: '#7cb342' },
  { key: 'fair', label: 'Fair', color: 'var(--accent)' },
  { key: 'poor', label: 'Poor', color: 'var(--red)' },
] as const;

export default function Player() {
  const { id } = useParams();
  const { me } = useMe();
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setStats(null);
    setError('');
    api
      .playerStats(Number(id))
      .then(setStats)
      .catch(() => setError('Player not found.'));
  }, [id]);

  if (error) {
    return (
      <div className="lobby">
        <div className="hero">
          <h1>Stats</h1>
          <p>{error}</p>
        </div>
        <p style={{ textAlign: 'center' }}>
          <Link to="/leaderboard">Back to rankings</Link>
        </p>
      </div>
    );
  }
  if (!stats) return <div className="spin" />;

  const isMe = stats.user.id === me?.user?.id;
  const t = stats.totals;
  const bidDelta = improvement(stats.accuracySeries.filter((p) => p.accuracy !== null).map((p) => p.accuracy!));
  const trendWindow = (n: number) => Math.min(5, Math.ceil(n / 2));
  const since = new Date(stats.user.createdAt * 1000).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="lobby player">
      <div className="hero player-hero">
        {stats.user.picture ? (
          <img className="avatar" src={stats.user.picture} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="avatar avatar-fallback">{[...stats.user.handle][0]?.toUpperCase()}</div>
        )}
        <h1>{isMe ? 'Your stats' : stats.user.handle}</h1>
        <p>Learning since {since}</p>
      </div>

      {t.boardsCompleted === 0 ? (
        <div className="card-box empty-stats">
          <p>No completed boards yet.</p>
          {isMe && (
            <Link to="/" className="btn btn-primary">
              Play your first board
            </Link>
          )}
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat">
              <div className="val">{t.currentElo}</div>
              <div className="lbl">Elo</div>
              <div className="sub">peak {t.peakElo}</div>
            </div>
            <div className="stat">
              <div className="val">{t.tournamentsPlayed}</div>
              <div className="lbl">Tournaments</div>
              <div className="sub">{t.tournamentsCompleted} completed</div>
            </div>
            <div className="stat">
              <div className="val">{t.boardsCompleted}</div>
              <div className="lbl">Boards</div>
              <div className="sub">{t.passedOut} passed out</div>
            </div>
            <div className="stat">
              <div className="val">{t.avgPct !== null ? `${t.avgPct}%` : '—'}</div>
              <div className="lbl">Avg score</div>
              <div className="sub">50% = field average</div>
            </div>
            <div className="stat">
              <div className="val">{t.avgBidAccuracy !== null ? `${t.avgBidAccuracy}%` : '—'}</div>
              <div className="lbl">Bid accuracy</div>
              {bidDelta !== null ? (
                <div className={`sub delta ${bidDelta >= 0 ? 'up' : 'down'}`}>
                  {bidDelta >= 0 ? '+' : ''}
                  {bidDelta} since {isMe ? 'you' : 'they'} started
                </div>
              ) : (
                <div className="sub">across all calls</div>
              )}
            </div>
            <div className="stat">
              <div className="val">{t.ratedTournaments}</div>
              <div className="lbl">Rated</div>
              <div className="sub">head-to-head</div>
            </div>
          </div>

          <ComparisonCard stats={stats} isMe={isMe} />

          <ChartCard
            title="Rating"
            caption="Elo after each rated tournament. History re-ranks as friends finish old deals."
            hasData={stats.eloSeries.length > 0}
            chart={
              <TrendChart
                points={stats.eloSeries.map((p) => ({ label: p.tournamentName, value: p.elo, date: p.finishedAt }))}
                refValue={1200}
                refLabel="start"
              />
            }
          />
          <ChartCard
            title="Bidding accuracy"
            caption="Average bid grade per tournament — the gold dashed line is the running trend."
            hasData={stats.accuracySeries.some((p) => p.accuracy !== null)}
            chart={
              <TrendChart
                points={stats.accuracySeries
                  .filter((p) => p.accuracy !== null)
                  .map((p) => ({ label: p.tournamentName, value: p.accuracy!, date: p.finishedAt }))}
                yDomain={[0, 100]}
                trendWindow={trendWindow(stats.accuracySeries.length)}
                format={(v) => `${Math.round(v)}%`}
              />
            }
          />
          <ChartCard
            title="Tournament scores"
            caption="Matchpoint average per tournament. Scores keep moving as friends play the same deals."
            hasData={stats.pctSeries.length > 0}
            chart={
              <TrendChart
                points={stats.pctSeries.map((p) => ({ label: p.tournamentName, value: p.pct, date: p.finishedAt }))}
                yDomain={[0, 100]}
                refValue={50}
                refLabel="field avg"
                format={(v) => `${Math.round(v)}%`}
              />
            }
          />

          <div className="card-box">
            <h2>Bid grades</h2>
            <div className="grade-dist">
              {GRADES.map((g) => {
                const n = t.gradeCounts[g.key];
                const total = GRADES.reduce((s, x) => s + t.gradeCounts[x.key], 0);
                return (
                  <div className="grade-row" key={g.key}>
                    <span className="grade-label">{g.label}</span>
                    <div className="pctbar">
                      <i style={{ width: `${total ? (n / total) * 100 : 0}%`, background: g.color }} />
                    </div>
                    <span className="grade-count">{n}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card-box">
            <h2>Card play record</h2>
            <p className="record-line">
              Made <b>{t.declarer.made}</b> of <b>{t.declarer.boards}</b> contracts declaring · beat{' '}
              <b>{t.defense.beat}</b> of <b>{t.defense.boards}</b> defending
              {t.passedOut > 0 ? ` · ${t.passedOut} passed out` : ''}
            </p>
          </div>
        </>
      )}

      <p style={{ textAlign: 'center' }}>
        <Link to="/leaderboard">Rankings</Link> · <Link to="/">Lobby</Link>
      </p>
    </div>
  );
}

function ChartCard({
  title,
  caption,
  hasData,
  chart,
}: {
  title: string;
  caption: string;
  hasData: boolean;
  chart: JSX.Element;
}) {
  return (
    <div className="card-box">
      <h2>{title}</h2>
      {hasData ? (
        <>
          {chart}
          <p className="chart-caption">{caption}</p>
        </>
      ) : (
        <p className="chart-caption">Play more tournaments to see a trend here.</p>
      )}
    </div>
  );
}

/** "better than N% of players" bars, one per metric with data */
function ComparisonCard({ stats, isMe }: { stats: PlayerStats; isMe: boolean }) {
  const p = stats.percentiles;
  const rows = [
    { label: 'Elo', pct: p.elo, of: `${p.ratedPlayers} rated players` },
    { label: 'Score', pct: p.avgPct, of: `${p.activePlayers} players` },
    { label: 'Bidding', pct: p.bidAccuracy, of: `${p.activePlayers} players` },
  ].filter((r) => r.pct !== null);
  if (!rows.length) return null;
  return (
    <div className="card-box">
      <h2>Versus the field</h2>
      <div className="grade-dist">
        {rows.map((r) => (
          <div className="grade-row" key={r.label}>
            <span className="grade-label">{r.label}</span>
            <div className="pctbar">
              <i style={{ width: `${r.pct}%` }} />
            </div>
            <span className="grade-count wide">
              better than {r.pct}% of {r.of}
            </span>
          </div>
        ))}
      </div>
      {!isMe && <p className="chart-caption">Percentiles compare against every player in the club.</p>}
    </div>
  );
}
