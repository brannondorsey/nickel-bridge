import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useMe } from '../App';
import { BidTypeKey, PlayerStats, api } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { FlipDigits } from '../components/ds/FlipDigits';
import { Loading } from '../components/ds/Loading';
import { PctBar } from '../components/ds/PctBar';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { Sparkline } from '../components/ds/Sparkline';
import { StarGrade } from '../components/ds/StarGrade';
import { shortDate } from '../format';
import { applyThemePref, readThemePref, storeThemePref, type ThemePref } from '../theme';

const THEME_OPTIONS: { pref: ThemePref; label: string }[] = [
  { pref: 'day', label: 'DAY' },
  { pref: 'night', label: 'NIGHT' },
  { pref: 'adaptive', label: 'ADAPT' },
  { pref: 'system', label: 'SYSTEM' },
];

/** Day/Night/Adaptive/System segmented switch — the runtime override on top of the OS default. */
function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>(() => readThemePref());
  return (
    <div className="theme-switch" role="group" aria-label="Appearance">
      {THEME_OPTIONS.map((o) => (
        <button
          key={o.pref}
          type="button"
          className={o.pref === pref ? 'active' : ''}
          aria-pressed={o.pref === pref}
          onClick={() => {
            setPref(o.pref);
            storeThemePref(o.pref);
            applyThemePref(o.pref);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const GRADE_ROWS = [
  { stars: 3, key: 'excellent' },
  { stars: 2, key: 'good' },
  { stars: 1, key: 'fair' },
  { stars: 0, key: 'poor' },
] as const;

/** Display names for the auction-role buckets, in the server's ranked order. */
const BID_TYPE_LABELS: Record<BidTypeKey, string> = {
  opening: 'OPENINGS',
  response: 'RESPONSES',
  rebid: 'REBIDS',
  overcall: 'OVERCALLS',
  double: 'DOUBLES',
  pass: 'PASSES',
};

/** Bordered chart panel: tracked-caps heading, right-aligned key figure. */
function ChartPanel({ heading, figure, children }: { heading: string; figure?: string; children: ReactNode }) {
  return (
    <div className="chart-panel">
      <div className="chart-panel-head">
        <span className="label-caps">{heading}</span>
        {figure ? <b className="chart-panel-figure num">{figure}</b> : null}
      </div>
      {children}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat-tile">
      <div className="label-caps stat-tile-label">{label}</div>
      <div className="stat-tile-value num">{value}</div>
      <div className="stat-tile-sub num">{sub}</div>
    </div>
  );
}

/** Stats: the turnstile rating hero, trend sparklines, and the bidding/play record. */
export default function Player() {
  const { id } = useParams();
  const { me, refresh } = useMe();
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [error, setError] = useState('');
  const [bidLedgerOpen, setBidLedgerOpen] = useState(false);

  useEffect(() => {
    setStats(null);
    setError('');
    setBidLedgerOpen(false);
    api
      .playerStats(Number(id))
      .then(setStats)
      .catch(() => setError('Player not found.'));
  }, [id]);

  if (error) {
    return (
      <div className="stats-page">
        <AppHeader context="STATS" />
        <div className="notice-error">{error}</div>
        <div className="stats-footer">
          <Button variant="secondary" to="/leaderboard">
            Back to the rankings
          </Button>
        </div>
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="stats-page">
        <AppHeader context="STATS" />
        <Loading />
      </div>
    );
  }

  const isMe = stats.user.id === me?.user?.id;
  // Benchmark house personas are never Elo-rated (their scores count in
  // matchpoints but not in ratings), so every Elo surface — the rating hero,
  // the rating chart, the RATED tile — is hidden on their profiles.
  const house = stats.user.kind === 'ai';
  const t = stats.totals;
  const gradedCalls = GRADE_ROWS.reduce((s, g) => s + t.gradeCounts[g.key], 0);
  const gradePct = (n: number) => (gradedCalls ? Math.round((n / gradedCalls) * 100) : 0);
  const since = new Date(stats.user.createdAt * 1000).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const last10 = <T,>(xs: T[]) => xs.slice(-10);
  const pctPoints = last10(stats.pctSeries).map((p) => ({
    label: p.tournamentName,
    caption: p.finishedAt ? shortDate(p.finishedAt) : undefined,
    value: p.pct,
  }));
  const eloPoints = last10(stats.eloSeries).map((p) => ({
    label: p.tournamentName,
    caption: p.finishedAt ? shortDate(p.finishedAt) : undefined,
    value: p.elo,
  }));
  const accPoints = last10(stats.accuracySeries.filter((p) => p.accuracy !== null)).map((p) => ({
    label: p.tournamentName,
    caption: p.finishedAt ? shortDate(p.finishedAt) : undefined,
    value: p.accuracy!,
  }));
  const ago = (n: number) => (n > 1 ? `${n} tournaments ago` : '');

  const declaring = t.declarer.boards ? Math.round((t.declarer.made / t.declarer.boards) * 100) : null;
  const defending = t.defense.boards ? Math.round((t.defense.beat / t.defense.boards) * 100) : null;

  const percentileRows = [
    { label: 'Elo', pct: stats.percentiles.elo, of: `${stats.percentiles.ratedPlayers} rated players` },
    { label: 'Score', pct: stats.percentiles.avgPct, of: `${stats.percentiles.activePlayers} players` },
    { label: 'Bidding', pct: stats.percentiles.bidAccuracy, of: `${stats.percentiles.activePlayers} players` },
  ].filter((r) => r.pct !== null) as { label: string; pct: number; of: string }[];

  return (
    <div className="stats-page">
      <AppHeader context="STATS" />

      <div className="player-hero stats-hero">
        {!isMe ? (
          <div className="stats-who">
            {stats.user.picture ? (
              <img className="stats-avatar" src={stats.user.picture} alt="" referrerPolicy="no-referrer" />
            ) : (
              <div className="stats-avatar stats-avatar-fallback">
                {stats.user.handle ? [...stats.user.handle][0].toUpperCase() : ''}
              </div>
            )}
            <div>
              <div className="stats-handle">
                {stats.user.handle}
                {house ? <span className="house-tag">HOUSE</span> : null}
              </div>
              <div className="stats-since">
                {house ? 'House player — a fixed skill level, in the field of every crossing' : `Learning since ${since}`}
              </div>
            </div>
          </div>
        ) : null}
        {!house ? (
          <>
            <FlipDigits value={t.currentElo} size={46} />
            <div className="stats-rating-line">
              <span className="label-caps stats-rating-label">NICKEL RATING</span>
              {t.monthlyEloDelta !== null ? (
                <span className={`stats-delta num ${t.monthlyEloDelta >= 0 ? 'positive' : 'negative'}`}>
                  {t.monthlyEloDelta >= 0 ? '+' : '−'}
                  {Math.abs(t.monthlyEloDelta)} THIS MONTH
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {t.boardsCompleted === 0 ? (
        <>
          <div className="empty-note">
            {isMe ? 'No boards played yet — the first crossing sets your rating.' : 'No completed boards yet.'}
          </div>
          {isMe ? (
            <div className="stats-footer">
              <Button to="/" className="stats-first-board">
                PLAY YOUR FIRST BOARD →
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <ChartPanel
            heading={`MATCHPOINTS — LAST ${pctPoints.length} TOURNAMENT${pctPoints.length === 1 ? '' : 'S'}`}
            figure={t.avgPct !== null ? `Ø ${t.avgPct}%` : undefined}
          >
            <Sparkline
              points={pctPoints}
              refValue={50}
              refLabel="field average 50%"
              leftCaption={ago(pctPoints.length)}
              format={(v) => `${Math.round(v)}%`}
            />
          </ChartPanel>

          {!house ? (
            <ChartPanel heading="RATING BY TOURNAMENT" figure={`PEAK ${t.peakElo}`}>
              <Sparkline points={eloPoints} refValue={1200} refLabel="start 1200" leftCaption={ago(eloPoints.length)} />
            </ChartPanel>
          ) : null}

          <ChartPanel
            heading="BID ACCURACY"
            figure={t.avgBidAccuracy !== null ? `Ø ${t.avgBidAccuracy}%` : undefined}
          >
            <Sparkline
              points={accPoints}
              trendWindow={Math.min(5, Math.ceil(accPoints.length / 2))}
              leftCaption={ago(accPoints.length)}
              rightCaption="latest · - - trend"
              format={(v) => `${Math.round(v)}%`}
            />
          </ChartPanel>

          <PerforatedPanel heading={`BIDDING — ${gradedCalls} CALLS GRADED`} className="stats-bidding num">
            <button
              type="button"
              className="stats-bidding-toggle"
              aria-expanded={bidLedgerOpen}
              disabled={stats.bidTypes.length === 0}
              onClick={() => setBidLedgerOpen((o) => !o)}
            >
              <div className="stats-grades">
                {GRADE_ROWS.map((g) => (
                  <div key={g.key} className="stats-grade-row">
                    <StarGrade stars={g.stars} />
                    <PctBar pct={gradePct(t.gradeCounts[g.key])} />
                    <b>{gradePct(t.gradeCounts[g.key])}%</b>
                  </div>
                ))}
              </div>
              {stats.bidTypes.length > 0 ? (
                <div className="stats-bidding-hint">
                  {bidLedgerOpen ? 'Fold the ledger away ▴' : 'Tap for the ledger by bid type ▾'}
                </div>
              ) : null}
            </button>
            {bidLedgerOpen && stats.bidTypes.length > 0 ? (
              <div className="stats-bidtypes">
                <div className="label-caps stats-bidtypes-head">★★ OR BETTER — BY BID TYPE</div>
                {stats.bidTypes.map((b) => {
                  const pct = Math.round((b.satisfactory / b.total) * 100);
                  return (
                    <div key={b.category} className="stats-bidtype-row">
                      <span className="label-caps stats-bidtype-label">{BID_TYPE_LABELS[b.category]}</span>
                      <PctBar pct={pct} />
                      <b>{pct}%</b>
                      <span className="stats-bidtype-count">
                        {b.total} call{b.total === 1 ? '' : 's'}
                      </span>
                    </div>
                  );
                })}
                <div className="stats-bidtypes-note">
                  Ranked by your share of ★★-or-better calls
                  {stats.bidTypes.length >= 2
                    ? ` — ${BID_TYPE_LABELS[stats.bidTypes[stats.bidTypes.length - 1].category].toLowerCase()} are the line to sharpen next.`
                    : '.'}
                </div>
              </div>
            ) : null}
          </PerforatedPanel>

          <div className="stats-tiles">
            <Tile
              label="DECLARING"
              value={declaring !== null ? `${declaring}%` : '—'}
              sub={`${t.declarer.boards} boards`}
            />
            <Tile
              label="DEFENDING"
              value={defending !== null ? `${defending}%` : '—'}
              sub={`${t.defense.boards} boards`}
            />
            <Tile label="TOURNAMENTS" value={String(t.tournamentsPlayed)} sub={`${t.tournamentsCompleted} completed`} />
            <Tile label="BOARDS" value={String(t.boardsCompleted)} sub={`${t.passedOut} passed out`} />
            <Tile label="AVG SCORE" value={t.avgPct !== null ? `${t.avgPct}%` : '—'} sub="50% = field average" />
            {!house ? <Tile label="RATED" value={String(t.ratedTournaments)} sub="head-to-head" /> : null}
          </div>

          {percentileRows.length > 0 ? (
            <PerforatedPanel heading="VERSUS THE FIELD" className="stats-versus num">
              {percentileRows.map((r) => (
                <div key={r.label} className="stats-versus-row">
                  <span className="stats-versus-label">{r.label}</span>
                  <PctBar pct={r.pct} />
                  <span className="stats-versus-note">
                    better than {r.pct}% of {r.of}
                  </span>
                </div>
              ))}
            </PerforatedPanel>
          ) : null}
        </>
      )}

      {isMe ? (
        <PerforatedPanel heading="APPEARANCE" className="stats-appearance">
          <ThemeSwitch />
        </PerforatedPanel>
      ) : null}

      {isMe ? (
        <div className="stats-footer">
          <Button
            variant="secondary"
            onClick={async () => {
              await api.logout();
              refresh();
            }}
          >
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}
