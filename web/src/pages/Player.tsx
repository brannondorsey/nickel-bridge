import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMe } from '../App';
import { BidTypeKey, ConventionKey, PlayerStats, Rival, RuffCounts, SUIT_SYMBOLS, api, suitClass } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { DayGrid, dateToUnix, sumInWindow } from '../components/ds/DayGrid';
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

/** Display names for the tracked-convention buckets. */
const CONVENTION_LABELS: Record<ConventionKey, string> = {
  stayman: 'STAYMAN',
  jacobyTransfer: 'JACOBY TRANSFERS',
  blackwood: 'BLACKWOOD',
  gerber: 'GERBER',
  weakTwo: 'WEAK TWOS',
  negativeDouble: 'NEGATIVE DOUBLES',
  michaels: 'MICHAELS',
};

const CONTRACT_TIER_ROWS = [
  { key: 'partscore', label: 'PARTSCORE' },
  { key: 'game', label: 'GAME' },
  { key: 'slam', label: 'SLAM' },
] as const;

/** Ruff-side sub-groups, declaring reuses the same wording as the DECLARING/DEFENDING stat tiles. */
const RUFF_SIDE_ROWS = [
  { key: 'declarerDummy', label: 'DECLARING' },
  { key: 'defense', label: 'DEFENDING' },
] as const;

/** Row labels for the plain/over/under-ruff breakdown, precise unabbreviated bridge terms. */
const RUFF_KIND_LABELS: Record<'plain' | 'over' | 'under', string> = {
  plain: 'RUFF',
  over: 'OVER-RUFF',
  under: 'UNDER-RUFF',
};

/** Row labels for the signed trick-delta histogram, keyed by clamped bucket value. */
const TRICK_DELTA_LABELS: Record<number, string> = {
  [-3]: '3+ DOWN',
  [-2]: '2 DOWN',
  [-1]: '1 DOWN',
  [0]: 'MADE EXACTLY',
  [1]: '1 OVER',
  [2]: '2 OVER',
  [3]: '3+ OVER',
};

const SUIT_NAMES = ['SPADES', 'HEARTS', 'DIAMONDS', 'CLUBS']; // ♠♥♦♣ order, matches suit index

const LEAD_STYLE_ROWS: { key: 'topOfSequence' | 'fourthBest' | 'other'; label: string }[] = [
  { key: 'topOfSequence', label: 'TOP OF SEQUENCE' },
  { key: 'fourthBest', label: 'FOURTH BEST' },
  { key: 'other', label: 'OTHER' },
];

/** Toll-bridge-voice takeaway for the trick-delta histogram. */
function trickDeltaNote(avgDelta: number): string {
  if (avgDelta <= -0.5) {
    return 'Falling short of contract more often than clearing it — bid a touch closer to the hand next time.';
  }
  if (avgDelta >= 0.5) {
    return 'Clearing contract more often than falling short — the auction could afford to reach a little further.';
  }
  return 'Tricks made track the bid closely — the mark of an honest auction.';
}

/** "Crossed paths 6 times — ahead 4-2." / "...— dead even 3-3." / "...— behind 2-4 (1 tied)." */
function rivalLine(r: Rival): string {
  const { ahead, behind, tied } = r.record;
  const times = `${r.shared} time${r.shared === 1 ? '' : 's'}`;
  const tiedNote = tied ? ` (${tied} tied)` : '';
  if (ahead === behind) return `Crossed paths ${times} — dead even ${ahead}-${behind}${tiedNote}.`;
  const verb = ahead > behind ? 'ahead' : 'behind';
  return `Crossed paths ${times} — ${verb} ${ahead}-${behind}${tiedNote}.`;
}

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
  const [ledgerView, setLedgerView] = useState<'type' | 'convention'>('type');

  useEffect(() => {
    setStats(null);
    setError('');
    setBidLedgerOpen(false);
    setLedgerView('type');
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
    { label: 'Declaring', pct: stats.percentiles.declaring, of: `${stats.percentiles.declaringPlayers} declarers` },
  ].filter((r) => r.pct !== null) as { label: string; pct: number; of: string }[];

  const cm = stats.contractMix;
  const tierPct = (b: { boards: number; made: number }) => (b.boards ? Math.round((b.made / b.boards) * 100) : null);
  const strainTotal = cm.strains.notrump + cm.strains.major + cm.strains.minor;
  const strainPct = (n: number) => (strainTotal ? Math.round((n / strainTotal) * 100) : 0);
  const doubledPct = tierPct(cm.doubled);

  const ruffTotal = (c: RuffCounts) => c.plain + c.over + c.under;
  const totalRuffs = ruffTotal(stats.ruffs.declarerDummy) + ruffTotal(stats.ruffs.defense);
  const holdUpPct = stats.holdUps.opportunities
    ? Math.round((stats.holdUps.taken / stats.holdUps.opportunities) * 100)
    : null;

  const dailyTotal = sumInWindow(stats.dailyBoards);

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

          <PerforatedPanel
            heading={`TOLL LOG — ${dailyTotal} TOLL${dailyTotal === 1 ? '' : 'S'} THIS SEASON`}
            className="stats-daygrid"
          >
            <DayGrid days={stats.dailyBoards} />
            {dailyTotal === 0 && t.boardsCompleted > 0 ? (
              <div className="stats-daygrid-note">
                Quiet lately — the last toll paid was {shortDate(dateToUnix(stats.dailyBoards.at(-1)!.date))}.
              </div>
            ) : null}
          </PerforatedPanel>

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
                  {bidLedgerOpen
                    ? 'Fold the ledger away ▴'
                    : stats.conventions.length > 0
                      ? 'Tap for the bidding ledger ▾'
                      : 'Tap for the ledger by bid type ▾'}
                </div>
              ) : null}
            </button>
            {bidLedgerOpen && stats.bidTypes.length > 0 ? (
              <div className="stats-bidtypes">
                {stats.conventions.length > 0 ? (
                  <div className="stats-ledger-tabs" role="tablist" aria-label="Bidding ledger view">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={ledgerView === 'type'}
                      className={ledgerView === 'type' ? 'active' : ''}
                      onClick={() => setLedgerView('type')}
                    >
                      BID TYPE
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={ledgerView === 'convention'}
                      className={ledgerView === 'convention' ? 'active' : ''}
                      onClick={() => setLedgerView('convention')}
                    >
                      CONVENTION
                    </button>
                  </div>
                ) : null}

                {ledgerView === 'type' || stats.conventions.length === 0 ? (
                  <>
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
                  </>
                ) : (
                  <>
                    <div className="label-caps stats-bidtypes-head">★★ OR BETTER — BY CONVENTION</div>
                    {stats.conventions.map((c) => {
                      const pct = Math.round((c.satisfactory / c.total) * 100);
                      return (
                        <div key={c.family} className="stats-bidtype-row">
                          <span className="label-caps stats-bidtype-label">{CONVENTION_LABELS[c.family]}</span>
                          <PctBar pct={pct} />
                          <b>{pct}%</b>
                          <span className="stats-bidtype-count">
                            {c.total} call{c.total === 1 ? '' : 's'}
                          </span>
                        </div>
                      );
                    })}
                    <div className="stats-bidtypes-note">
                      Named conventions only — natural bids don't count here
                      {stats.conventions.length >= 2
                        ? ` — ${CONVENTION_LABELS[stats.conventions[stats.conventions.length - 1].family].toLowerCase()} could use a refresher.`
                        : '.'}
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </PerforatedPanel>

          {totalRuffs > 0 || holdUpPct !== null ? (
            <PerforatedPanel heading="CARD PLAY" className="stats-cardplay num">
              {totalRuffs > 0 ? (
                <div className="stats-cardplay-section">
                  <div className="label-caps stats-cardplay-head">RUFFS</div>
                  {RUFF_SIDE_ROWS.filter(({ key }) => ruffTotal(stats.ruffs[key]) > 0).map(({ key, label }) => {
                    const counts = stats.ruffs[key];
                    const total = ruffTotal(counts);
                    return (
                      <div key={key} className="stats-ruff-group">
                        <div className="stats-ruff-group-head">
                          <span className="label-caps">{label}</span>
                          <span className="stats-ruff-count">
                            {total} ruff{total === 1 ? '' : 's'}
                          </span>
                        </div>
                        {(['plain', 'over', 'under'] as const).map((kind) => {
                          const pct = Math.round((counts[kind] / total) * 100);
                          return (
                            <div key={kind} className="stats-ruff-row">
                              <span className="label-caps stats-ruff-label">{RUFF_KIND_LABELS[kind]}</span>
                              <PctBar pct={pct} />
                              <b>{pct}%</b>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {holdUpPct !== null ? (
                <div className="stats-cardplay-section">
                  <div className="label-caps stats-cardplay-head">HOLD-UP PLAYS</div>
                  <div className="stats-holdup-row">
                    <PctBar pct={holdUpPct} />
                    <b>{holdUpPct}%</b>
                  </div>
                  <div className="stats-cardplay-note">
                    Ducked {stats.holdUps.taken} of {stats.holdUps.opportunities} chance
                    {stats.holdUps.opportunities === 1 ? '' : 's'} to win a suit's first lead outright — notrump
                    contracts you declared.
                  </div>
                </div>
              ) : null}
            </PerforatedPanel>
          ) : null}

          {stats.openingLeads.boards > 0 ? (
            <PerforatedPanel
              heading={`OPENING LEADS — ${stats.openingLeads.boards} BOARD${stats.openingLeads.boards === 1 ? '' : 'S'} LED`}
              className="stats-leads num"
            >
              <div className="label-caps stats-leads-subhead">BY SUIT</div>
              <div className="stats-leads-rows">
                {stats.openingLeads.suits.map((s) => {
                  const pct = Math.round((s.count / stats.openingLeads.boards) * 100);
                  return (
                    <div key={s.suit} className="stats-leads-row">
                      <span className={`stats-leads-label ${suitClass(s.suit)}`}>
                        {SUIT_SYMBOLS[s.suit]} {SUIT_NAMES[s.suit]}
                      </span>
                      <PctBar pct={pct} />
                      <b>{pct}%</b>
                      <span className="stats-leads-count">{s.count}</span>
                    </div>
                  );
                })}
              </div>

              <div className="label-caps stats-leads-subhead stats-leads-subhead-second">LEAD STYLE</div>
              <div className="stats-leads-rows">
                {LEAD_STYLE_ROWS.map((row) => {
                  const n = stats.openingLeads.style[row.key];
                  const pct = Math.round((n / stats.openingLeads.boards) * 100);
                  return (
                    <div key={row.key} className="stats-leads-row">
                      <span className="stats-leads-label">{row.label}</span>
                      <PctBar pct={pct} />
                      <b>{pct}%</b>
                      <span className="stats-leads-count">{n}</span>
                    </div>
                  );
                })}
              </div>
              <div className="stats-leads-note">
                Top of sequence and fourth best are the textbook leads; "other" covers short suits, middle-up-down,
                and everything else.
              </div>
            </PerforatedPanel>
          ) : null}

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
            <Tile
              label="BEST CROSSING"
              value={t.bestPct ? `${t.bestPct.pct}%` : '—'}
              sub={t.bestPct ? t.bestPct.tournamentName : 'no crossings yet'}
            />
            <Tile
              label="TOUGHEST CROSSING"
              value={t.worstPct ? `${t.worstPct.pct}%` : '—'}
              sub={t.worstPct ? t.worstPct.tournamentName : 'no crossings yet'}
            />
            {!house ? <Tile label="RATED" value={String(t.ratedTournaments)} sub="head-to-head" /> : null}
          </div>

          {t.declarer.boards > 0 ? (
            <PerforatedPanel heading={`CONTRACTS — ${t.declarer.boards} DECLARED`} className="stats-contracts num">
              <div className="stats-contracts-rows">
                {CONTRACT_TIER_ROWS.map(({ key, label }) => {
                  const bucket = cm[key];
                  const pct = tierPct(bucket);
                  return (
                    <div key={key} className="stats-contract-row">
                      <span className="label-caps stats-contract-label">{label}</span>
                      {pct !== null ? <PctBar pct={pct} /> : <span />}
                      <b>{pct !== null ? `${pct}%` : '—'}</b>
                      <span className="stats-contract-count">
                        {bucket.boards} board{bucket.boards === 1 ? '' : 's'}
                      </span>
                    </div>
                  );
                })}
                <div className="stats-contracts-divider" />
                <div className="stats-contract-row">
                  <span className="label-caps stats-contract-label">DOUBLED</span>
                  {doubledPct !== null ? <PctBar pct={doubledPct} /> : <span />}
                  <b>{doubledPct !== null ? `${doubledPct}%` : '—'}</b>
                  <span className="stats-contract-count">
                    {cm.doubled.boards} board{cm.doubled.boards === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
              <div className="stats-contracts-note">Redoubled crossings count as doubled too.</div>
              <div className="stats-contracts-strains">
                <span className="label-caps">AS DECLARER</span>
                <span>
                  NOTRUMP {strainPct(cm.strains.notrump)}% · MAJOR {strainPct(cm.strains.major)}% · MINOR{' '}
                  {strainPct(cm.strains.minor)}%
                </span>
              </div>
            </PerforatedPanel>
          ) : null}

          {stats.trickDelta.avgDelta !== null ? (
            <PerforatedPanel
              heading={`TRICKS TAKEN — ${stats.trickDelta.boards} CONTRACT${stats.trickDelta.boards === 1 ? '' : 'S'} · Ø ${
                stats.trickDelta.avgDelta >= 0 ? '+' : '−'
              }${Math.abs(stats.trickDelta.avgDelta)}`}
              className="stats-trickdelta num"
            >
              <div className="stats-trickdelta-rows">
                {stats.trickDelta.buckets.map((b) => {
                  const pct = Math.round((b.count / stats.trickDelta.boards) * 100);
                  return (
                    <div key={b.delta} className="stats-trickdelta-row">
                      <span className="label-caps stats-trickdelta-label">{TRICK_DELTA_LABELS[b.delta]}</span>
                      <PctBar pct={pct} />
                      <b>{pct}%</b>
                      <span className="stats-trickdelta-count">
                        {b.count} board{b.count === 1 ? '' : 's'}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="stats-trickdelta-note">{trickDeltaNote(stats.trickDelta.avgDelta)}</div>
            </PerforatedPanel>
          ) : null}

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

          {stats.rivals.length > 0 ? (
            <PerforatedPanel heading="RIVALRIES" className="stats-rivals num">
              {stats.rivals.map((r) => (
                <Link key={r.userId} to={`/players/${r.userId}`} className="stats-rival-row">
                  <div className="stats-rival-head">
                    <span className="stats-rival-name">
                      {r.handle}
                      {r.kind === 'ai' ? <span className="house-tag">HOUSE</span> : null}
                    </span>
                    <span className="stats-rival-record">
                      {r.record.ahead}-{r.record.behind}
                      {r.record.tied ? `-${r.record.tied}` : ''}
                    </span>
                  </div>
                  <div className="stats-rival-note">{rivalLine(r)}</div>
                </Link>
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
