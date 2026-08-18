import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMe } from '../App';
import { BidTypeKey, CardCountingStats, COMPARE_MIN_BOARDS_FALLBACK, ConventionKey, PlayerStats, QuestionType, Rival, api } from '../api';
import { AppHeader } from '../components/ds/AppHeader';
import { Button } from '../components/ds/Button';
import { DayGrid, dateToUnix, sumInWindow } from '../components/ds/DayGrid';
import { FlipDigits } from '../components/ds/FlipDigits';
import { Loading } from '../components/ds/Loading';
import { MedalGlyphs } from '../components/ds/MedalGlyphs';
import { PctBar } from '../components/ds/PctBar';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { Sparkline } from '../components/ds/Sparkline';
import { StemChart } from '../components/ds/StemChart';
import { StarGrade } from '../components/ds/StarGrade';
import { GlossaryProse } from '../components/game/GlossaryProse';
import { useGlossary } from '../glossary/GlossaryContext';
import { shortDate, shortDateUTC } from '../format';

/**
 * The lookback window for the three sparkline panels — how many tournaments
 * back they plot.
 *
 * The server sends every series unbounded (stats.ts's
 * pctSeries/eloSeries/accuracySeries) and `fieldPercentiles()` already sweeps
 * every standard tournament site-wide through the same memoized
 * `getStandings`, so a player's own tournaments are a subset of a pass that
 * runs on every profile load: a longer window costs no query, no matchpointing
 * and (at 100 tournaments, ~7.5KB gzipped) no payload worth counting. The old
 * ceiling was the chart's tap layer — one invisible button per point across a
 * ~326px plot, an untappable 3px target at 100 — and Sparkline's scrubber
 * removed it, which is what makes a window switch possible at all.
 *
 * What's left is legibility: past roughly 150 points the line reads as texture
 * rather than a shape, and the vertical scale spans a whole career so recent
 * movement flattens. So the *default* stays deliberately short and the reader
 * opts into more. 25 keeps the panels answering "how am I doing lately", which
 * is the question they're placed on the page to answer.
 */
const DEFAULT_LOOKBACK = 25;

/**
 * The windows the switch can offer, shortest first. A window is only offered
 * once it's a genuinely distinct choice — see `offeredWindows` — so a player
 * with 12 crossings is never shown a "100" that would draw the same chart as
 * ALL. `all` is always the last option when any window qualifies.
 */
const CHART_WINDOWS = [10, 25, 100] as const;

type Lookback = (typeof CHART_WINDOWS)[number] | 'all';

const LOOKBACK_KEY = 'nb:lookback';

/**
 * Which fixed windows are worth showing for a history of `longest` tournaments.
 *
 * Strictly less than, not `<=`: a 25 window over a 25-tournament history plots
 * exactly what ALL plots, and a button that redraws the same chart is a button
 * that does nothing. This also means the switch itself stays hidden until the
 * 11th crossing, where "last 10" first says something ALL doesn't — before
 * that the panels behave exactly as they did with no control at all.
 */
function offeredWindows(longest: number): (typeof CHART_WINDOWS)[number][] {
  return CHART_WINDOWS.filter((w) => w < longest);
}

/** Best-effort read; unreadable storage or an unrecognized stamp falls back to the default. */
function readLookback(): Lookback {
  try {
    const v = localStorage.getItem(LOOKBACK_KEY);
    if (v === 'all') return 'all';
    const n = Number(v);
    return (CHART_WINDOWS as readonly number[]).includes(n) ? (n as Lookback) : DEFAULT_LOOKBACK;
  } catch {
    return DEFAULT_LOOKBACK;
  }
}

function storeLookback(v: Lookback) {
  try {
    localStorage.setItem(LOOKBACK_KEY, String(v));
  } catch {
    /* private mode — the preference just doesn't persist */
  }
}

/**
 * Smoothing window for the bid-accuracy trend overlay, as a fraction of the
 * points on screen rather than a fixed count. A trailing mean only reads as a
 * trend while it stays wide relative to the series: the previous
 * `min(5, ceil(n / 2))` was exactly half the points at the 10-tournament
 * lookback, but the cap meant that at 25 a 5-point mean tracks the raw line
 * closely enough to say nothing. Dropping the cap keeps the same shape at any
 * lookback and yields the identical window for every 3 <= n <= 10, where the
 * cap never bound. Floored at 2 so the overlay is never a dashed copy of the
 * line it sits under.
 */
const trendWindow = (n: number) => Math.max(2, Math.ceil(n / 2));

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

/**
 * A manual glossary link for a standalone ledger/tile key (as opposed to free
 * prose): used where GlossaryProse's auto-matching wouldn't fire — either the
 * term is `linkify: false` sitewide because it's too common a word in prose
 * ("pass", "game"), or the display text is a different word form than the
 * term itself ("Declaring" vs. the "Declarer" term) — but the key here is a
 * short, deliberate label rather than a sentence, so linking it doesn't
 * create prose noise.
 */
function GlossLabel({ text, slug }: { text: string; slug: string }) {
  const { openTerm } = useGlossary();
  return (
    <button type="button" className="gloss-link" onClick={() => openTerm(slug)}>
      {text}
    </button>
  );
}

/** BID_TYPE_LABELS[category] as a glossary link. */
function BidTypeLabel({ category }: { category: BidTypeKey }) {
  const label = BID_TYPE_LABELS[category];
  if (category === 'pass') return <GlossLabel text={label} slug="pass" />;
  return <GlossaryProse text={label} />;
}

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

/** Display names for Pop-Up Quiz's question types — mirrors server/src/compare.ts's QUESTION_TYPE_LABELS. */
const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  'suit-count': 'SUIT LENGTH',
  'opponent-length': 'OPPONENT LENGTH',
  void: 'VOIDS',
  'trump-count': 'TRUMP COUNT',
  'honor-location': 'HONOR LOCATION',
  'suit-exhaustion': 'SUIT EXHAUSTION',
  'running-total': 'RUNNING TOTAL',
};

const CONTRACT_TIER_ROWS = [
  { key: 'partscore', label: 'PARTSCORE' },
  { key: 'game', label: 'GAME' },
  { key: 'slam', label: 'SLAM' },
] as const;

/** Axis ticks for the trick-delta stem plot, keyed by clamped bucket value. */
const TRICK_DELTA_TICKS: Record<number, string> = {
  [-3]: '−3',
  [-2]: '−2',
  [-1]: '−1',
  [0]: 'MADE',
  [1]: '+1',
  [2]: '+2',
  [3]: '+3',
};

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

/**
 * Sub-line for the TOPS tile. "1 in 7 boards" is the reading worth printing,
 * but it only stays true once the ratio rounds to 2 or more — 3 tops in 4
 * boards would round to "1 in 1" and read as a clean sweep. Below that, and
 * for the cold-start case, print the plain tally.
 */
function topsSub(count: number, boards: number): string {
  if (count === 0) return 'no tops yet';
  const ratio = Math.round(boards / count);
  return ratio >= 2 ? `1 in ${ratio} boards` : `${count} of ${boards} boards`;
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

/**
 * Card Counting — Pop-Up Quiz's stats panel ("A, the full panel" from the
 * design review): headline accuracy + a running-accuracy trend, a per-type
 * breakdown, and the easy/medium/hard tier row the recalibration process
 * needs (see packages/ai/src/quiz.ts's DIFFICULTY_WEIGHTS doc comment).
 * Rendered only when the server sends quizStats — already gated server-side
 * on the player's CURRENT Pop Quizzes setting.
 */
function CardCountingPanel({ stats }: { stats: CardCountingStats }) {
  // The raw trend is one 0/1 per quiz — too noisy to plot directly, so the
  // line is a running (expanding-window) accuracy over the same points,
  // matching how a player would actually read "am I improving".
  let correctSoFar = 0;
  const points = stats.trend.map((t, i) => {
    if (t.correct) correctSoFar++;
    return { label: `Quiz ${i + 1}`, value: Math.round((correctSoFar / (i + 1)) * 100) };
  });
  const direction =
    points.length < 2
      ? 'holding steady'
      : points[points.length - 1].value > points[0].value
        ? 'trending up'
        : points[points.length - 1].value < points[0].value
          ? 'trending down'
          : 'holding steady';

  return (
    <PerforatedPanel heading="CARD COUNTING" className="cc-panel">
      <p className="stat-subtitle">Built from your Pop Quiz answers.</p>
      {stats.totalAnswered > 0 ? (
        <>
          <div className="cc-headline">
            <div className="stat-pct num">{stats.accuracyPct}%</div>
            <div className="cc-trend">
              <Sparkline points={points} label="Card Counting accuracy trend" format={(v) => `${Math.round(v)}%`} />
              <div className="cc-trend-lbl">
                Last {points.length} quiz{points.length === 1 ? '' : 'zes'} · {direction}
              </div>
            </div>
          </div>
          <div className="cc-rows">
            {stats.byType.map((t) => {
              const pct = Math.round((t.correct / t.total) * 100);
              return (
                <div key={t.type} className="cc-row">
                  <span className="label-caps cc-row-lbl">{QUESTION_TYPE_LABELS[t.type]}</span>
                  <PctBar pct={pct} />
                  <span className="cc-row-frac num">
                    {t.correct}/{t.total}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="cc-tier-row">
            {stats.byTier.map((t) => (
              <div key={t.tier} className="cc-tier-cell">
                <div className="cc-tier-pct num">{t.total ? Math.round((t.correct / t.total) * 100) : 0}%</div>
                <div className="label-caps cc-tier-name">{t.tier}</div>
                <div className="cc-tier-n num">{t.total}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="stat-empty">Pop Quizzes is on — nothing to show yet until one fires.</p>
      )}
    </PerforatedPanel>
  );
}

function Tile({ label, value, sub, to }: { label: string; value: string; sub: string; to?: string }) {
  const content = (
    <>
      <div className="label-caps stat-tile-label">{label}</div>
      <div className="stat-tile-value num">{value}</div>
      <div className="stat-tile-sub num">{sub}</div>
    </>
  );
  if (to) {
    return (
      <Link to={to} className="stat-tile">
        {content}
      </Link>
    );
  }
  return <div className="stat-tile">{content}</div>;
}

/** Stats: the turnstile rating hero, trend sparklines, and the bidding/play record. */
export default function Player() {
  const { id } = useParams();
  const { me } = useMe();
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [error, setError] = useState('');
  const [bidLedgerOpen, setBidLedgerOpen] = useState(false);
  const [ledgerView, setLedgerView] = useState<'type' | 'convention'>('type');
  const [lookbackPref, setLookbackPref] = useState<Lookback>(() => readLookback());

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

  // Signed out, a person's record needs an account and the house personas'
  // don't (server/src/app.ts) — and the 401 is deliberately uniform there, so
  // the client genuinely cannot tell "someone you'd need to sign in to see"
  // from "nobody". Say the true thing for both rather than "Player not found",
  // which would be a guess.
  //
  // Explanation only, no CTA: SignInBar is already at the foot of every public
  // screen (App.tsx's wantsSignInBar), and a second PLAY THE TOLL here would
  // be the same ask twice — indistinguishable to a screen reader, and to
  // anything looking one up by name.
  if (error) {
    return (
      <div className="stats-page">
        <AppHeader context="STATS" />
        {me?.user ? (
          <div className="notice-error">{error}</div>
        ) : (
          <div className="stats-gated">
            <p className="stats-gated-note">
              A player's record is for members of the club. The house players keep no secrets, though — read one of
              theirs from the rankings below.
            </p>
          </div>
        )}
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
  // Served, not mirrored: DEMO=1 relaxes the floor, so a hardcoded copy would
  // offer Compare where the server refuses it (or hide it where it wouldn't).
  const compareFloor = me?.compareMinBoards ?? COMPARE_MIN_BOARDS_FALLBACK;
  // Benchmark house personas are never Elo-rated (their scores count in
  // matchpoints but not in ratings), so every Elo surface — the rating hero,
  // the rating chart — is hidden on their profiles.
  const house = stats.user.kind === 'ai';
  const t = stats.totals;
  const gradedCalls = GRADE_ROWS.reduce((s, g) => s + t.gradeCounts[g.key], 0);
  const gradePct = (n: number) => (gradedCalls ? Math.round((n / gradedCalls) * 100) : 0);
  const since = new Date(stats.user.createdAt * 1000).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  // The switch is shared by all three charts, so what it can offer is driven by
  // the longest of them — a window any one chart can use is worth offering.
  const graded = stats.accuracySeries.filter((p) => p.accuracy !== null);
  const windows = offeredWindows(Math.max(stats.pctSeries.length, stats.eloSeries.length, graded.length));
  // A stored preference that this history can't support (or 'all') resolves to
  // ALL rather than silently clamping to a number the switch isn't showing.
  const lookback: Lookback =
    lookbackPref !== 'all' && (windows as number[]).includes(lookbackPref) ? lookbackPref : 'all';
  const recent = <T,>(xs: T[]) => (lookback === 'all' ? xs : xs.slice(-lookback));

  const pctPoints = recent(stats.pctSeries).map((p) => ({
    label: p.tournamentName,
    caption: p.finishedAt ? shortDate(p.finishedAt) : undefined,
    value: p.pct,
  }));
  const eloPoints = recent(stats.eloSeries).map((p) => ({
    label: p.tournamentName,
    caption: p.finishedAt ? shortDate(p.finishedAt) : undefined,
    value: p.elo,
  }));
  const accPoints = recent(graded).map((p) => ({
    label: p.tournamentName,
    caption: p.finishedAt ? shortDate(p.finishedAt) : undefined,
    value: p.accuracy!,
  }));
  /**
   * The left-hand axis caption: where the line starts, as a DATE.
   *
   * It used to read "39 tournaments ago" — an ordinal, which described the axis
   * honestly back when the server handed these series over in tournament-id
   * order. They arrive in play order now (stats.ts's StatPoint), so the axis is
   * time and the caption should say so; the panel headings and the LOOKBACK
   * switch already carry the count. Same "Apr 5" … "this week" shape DayGrid
   * uses at the top of this page, so the two date axes read alike.
   *
   * Falls back to the old ordinal when the first point has no finish time —
   * possible only for a rated crossing with no completed board, which
   * eloParticipants makes unreachable, but a caption is not worth a crash.
   */
  const axisStart = (points: { caption?: string }[]) =>
    points.length > 1 ? (points[0].caption ?? `${points.length} tournaments ago`) : '';

  const declaring = t.declarer.boards ? Math.round((t.declarer.made / t.declarer.boards) * 100) : null;
  const defending = t.defense.boards ? Math.round((t.defense.beat / t.defense.boards) * 100) : null;

  const percentileRows = [
    { label: 'Elo', pct: stats.percentiles.elo, of: `${stats.percentiles.ratedPlayers} rated players` },
    { label: 'Score', pct: stats.percentiles.avgPct, of: `${stats.percentiles.activePlayers} players` },
    { label: 'Bidding', pct: stats.percentiles.bidAccuracy, of: `${stats.percentiles.activePlayers} players` },
    {
      label: 'Declaring',
      slug: 'declarer',
      pct: stats.percentiles.declaring,
      of: `${stats.percentiles.declaringPlayers} declarers`,
    },
  ].filter((r) => r.pct !== null) as { label: string; slug?: string; pct: number; of: string }[];

  const cm = stats.contractMix;
  const tierPct = (b: { boards: number; made: number }) => (b.boards ? Math.round((b.made / b.boards) * 100) : null);
  const strainTotal = cm.strains.notrump + cm.strains.major + cm.strains.minor;
  const strainPct = (n: number) => (strainTotal ? Math.round((n / strainTotal) * 100) : 0);
  const doubledPct = tierPct(cm.doubled);

  const dailyTotal = sumInWindow(stats.dailyBoards);

  return (
    <div className="stats-page">
      <AppHeader context="STATS" />

      <div className="player-hero stats-hero">
        {/* Unconditional (not nested in the !isMe avatar block below, which
            your own profile doesn't render) — earned medals show the same
            way whether you're looking at your own record or someone else's.
            Renders nothing at all if nothing's been earned yet. */}
        <MedalGlyphs earned={t.earnedMedals} mode="earnedOnly" className="profile-medals" />
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
                <GlossaryProse
                  text={
                    house
                      ? 'House player — a fixed skill level, in the field of every crossing'
                      : `Playing since ${since}`
                  }
                />
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
        {/* Compare needs a record on BOTH sides to say anything — below the
            floor every measure is set aside, because at a handful of boards any
            difference between two players is the shuffle rather than the play.
            So the door only appears when both records clear it, rather than
            leading somewhere that has to apologise. Same reasoning as the BEST
            CROSSING tile below: don't render an affordance that bounces. */}
        {!isMe && me?.user && me.user.boards >= compareFloor && t.boardsCompleted >= compareFloor ? (
          <div className="stats-compare-cta">
            <Button variant="secondary" className="stats-compare-btn" to={`/compare/${stats.user.id}`}>
              COMPARE →
            </Button>
          </div>
        ) : null}
      </div>

      {t.boardsCompleted === 0 ? (
        <>
          <div className="empty-note">
            <GlossaryProse
              text={isMe ? 'No boards played yet — the first crossing sets your rating.' : 'No completed boards yet.'}
            />
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
          <PerforatedPanel
            heading={`TOLL LOG — ${dailyTotal} TOLL${dailyTotal === 1 ? '' : 'S'} THIS SEASON`}
            className="stats-daygrid"
          >
            <DayGrid days={stats.dailyBoards} />
            {dailyTotal === 0 && t.boardsCompleted > 0 ? (
              <div className="stats-daygrid-note">
                <GlossaryProse
                  text={`Quiet lately — the last toll paid was ${shortDateUTC(dateToUnix(stats.dailyBoards.at(-1)!.date))}.`}
                />
              </div>
            ) : null}
          </PerforatedPanel>

          {windows.length > 0 ? (
            <div className="lookback-row">
              <span className="label-caps lookback-label">LOOKBACK</span>
              <div className="lookback-switch" role="group" aria-label="Lookback window">
                {[...windows, 'all' as const].map((w) => (
                  <button
                    key={String(w)}
                    type="button"
                    className={w === lookback ? 'active' : ''}
                    aria-pressed={w === lookback}
                    onClick={() => {
                      setLookbackPref(w);
                      storeLookback(w);
                    }}
                  >
                    {w === 'all' ? 'ALL' : w}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <ChartPanel
            heading={`MATCHPOINTS — LAST ${pctPoints.length} TOURNAMENT${pctPoints.length === 1 ? '' : 'S'}`}
            figure={t.avgPct !== null ? `Ø ${t.avgPct}%` : undefined}
          >
            <Sparkline
              points={pctPoints}
              label="Matchpoints by tournament"
              refValue={50}
              refLabel="field average 50%"
              leftCaption={axisStart(pctPoints)}
              format={(v) => `${Math.round(v)}%`}
            />
          </ChartPanel>

          {!house ? (
            <ChartPanel heading="RATING BY TOURNAMENT" figure={`PEAK ${t.peakElo}`}>
              <Sparkline
                points={eloPoints}
                label="Rating by tournament"
                refValue={1200}
                refLabel="start 1200"
                leftCaption={axisStart(eloPoints)}
              />
              {/* Elo is wiped and replayed from every crossing on each scored board
                  (server/src/tournaments.ts), so this line is today's reconstruction
                  rather than a diary. Over a short window that's a wobble nobody
                  notices; drawn as a career arc it reads as a record of what the
                  player saw at the time, so say so — the same disclosure the
                  activity feed makes in its footer. */}
              {lookback === 'all' && eloPoints.length > DEFAULT_LOOKBACK ? (
                <div className="chart-note">
                  <GlossaryProse text="Ratings are replayed from every crossing whenever a board is scored, so an old tournament finishing today can restate this line." />
                </div>
              ) : null}
            </ChartPanel>
          ) : null}

          <ChartPanel
            heading="BID ACCURACY"
            figure={t.avgBidAccuracy !== null ? `Ø ${t.avgBidAccuracy}%` : undefined}
          >
            <Sparkline
              points={accPoints}
              label="Bid accuracy by tournament"
              trendWindow={trendWindow(accPoints.length)}
              leftCaption={axisStart(accPoints)}
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
                          <span className="label-caps stats-bidtype-label">
                            <BidTypeLabel category={b.category} />
                          </span>
                          <PctBar pct={pct} />
                          <b>{pct}%</b>
                          <span className="stats-bidtype-count">
                            {b.total} call{b.total === 1 ? '' : 's'}
                          </span>
                        </div>
                      );
                    })}
                    <div className="stats-bidtypes-note">
                      <GlossaryProse
                        text={`Ranked by your share of ★★-or-better calls${
                          stats.bidTypes.length >= 2
                            ? ` — ${BID_TYPE_LABELS[stats.bidTypes[stats.bidTypes.length - 1].category].toLowerCase()} are the line to sharpen next.`
                            : '.'
                        }`}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="label-caps stats-bidtypes-head">★★ OR BETTER — BY CONVENTION</div>
                    {stats.conventions.map((c) => {
                      const pct = Math.round((c.satisfactory / c.total) * 100);
                      return (
                        <div key={c.family} className="stats-bidtype-row">
                          <span className="label-caps stats-bidtype-label">
                            <GlossaryProse text={CONVENTION_LABELS[c.family]} />
                          </span>
                          <PctBar pct={pct} />
                          <b>{pct}%</b>
                          <span className="stats-bidtype-count">
                            {c.total} call{c.total === 1 ? '' : 's'}
                          </span>
                        </div>
                      );
                    })}
                    <div className="stats-bidtypes-note">
                      <GlossaryProse
                        text={`Named conventions only — natural bids don't count here${
                          stats.conventions.length >= 2
                            ? ` — ${CONVENTION_LABELS[stats.conventions[stats.conventions.length - 1].family].toLowerCase()} could use a refresher.`
                            : '.'
                        }`}
                      />
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </PerforatedPanel>

          {t.declarer.boards > 0 ? (
            <PerforatedPanel heading={`CONTRACTS MADE — ${t.declarer.boards} DECLARED`} className="stats-contracts num">
              <div className="stats-contracts-rows">
                {CONTRACT_TIER_ROWS.map(({ key, label }) => {
                  const bucket = cm[key];
                  const pct = tierPct(bucket);
                  return (
                    <div key={key} className="stats-contract-row">
                      <span className="label-caps stats-contract-label">
                        {key === 'game' ? <GlossLabel text={label} slug="game" /> : <GlossaryProse text={label} />}
                      </span>
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
                  <span className="label-caps stats-contract-label">
                    <GlossaryProse text="DOUBLED" />
                  </span>
                  {doubledPct !== null ? <PctBar pct={doubledPct} /> : <span />}
                  <b>{doubledPct !== null ? `${doubledPct}%` : '—'}</b>
                  <span className="stats-contract-count">
                    {cm.doubled.boards} board{cm.doubled.boards === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
              <div className="stats-contracts-note">
                <GlossaryProse text="Redoubled crossings count as doubled too." />
              </div>
              <div className="stats-contracts-strains">
                <span className="label-caps">
                  <GlossaryProse text="AS DECLARER" />
                </span>
                <span>
                  <GlossaryProse
                    text={`NOTRUMP ${strainPct(cm.strains.notrump)}% · MAJOR ${strainPct(cm.strains.major)}% · MINOR ${strainPct(cm.strains.minor)}%`}
                  />
                </span>
              </div>
            </PerforatedPanel>
          ) : null}

          {stats.quizStats ? <CardCountingPanel stats={stats.quizStats} /> : null}

          <div className="stats-tiles">
            <Tile
              label="DECLARING"
              value={declaring !== null ? `${declaring}%` : '—'}
              sub={`${t.declarer.made} of ${t.declarer.boards} made`}
            />
            <Tile
              label="DEFENDING"
              value={defending !== null ? `${defending}%` : '—'}
              sub={`${t.defense.beat} of ${t.defense.boards} set`}
            />
            <Tile label="TOURNAMENTS" value={String(t.tournamentsPlayed)} sub={`${t.tournamentsCompleted} completed`} />
            <Tile label="BOARDS" value={String(t.boardsCompleted)} sub={`${t.passedOut} passed out`} />
            <Tile label="STREAK" value={`${t.streakDays} day${t.streakDays === 1 ? '' : 's'}`} sub="longest run" />
            <Tile label="AVG SCORE" value={t.avgPct !== null ? `${t.avgPct}%` : '—'} sub="50% = field average" />
            {/* Points at the tournament, which is viewer-agnostic, so it links
                on anyone's profile — but only for someone who can open it.
                Profiles read without an account now, and /t/:tid needs one:
                without this the tile would sit there looking tappable and
                bounce a visitor back to the landing page. */}
            <Tile
              label="BEST CROSSING"
              value={t.bestPct ? `${t.bestPct.pct}%` : '—'}
              sub={t.bestPct ? t.bestPct.tournamentName : 'no crossings yet'}
              to={me?.user && t.bestPct ? `/t/${t.bestPct.tournamentId}` : undefined}
            />
            {/* Boards where the field was beaten outright — links to the most
                recent one's receipt, so the tile is worth tapping. Own profile
                only (so also never signed out): boards are per-user, and
                GET /t/:tid/b/:no loads the VIEWER's board of that number,
                creating one if absent (app.ts) — so linking someone else's top
                would deal the viewer into a tournament they were never placed
                in. A specific board has no viewer-agnostic URL the way a
                tournament does, so it simply doesn't link. */}
            <Tile
              label="TOPS"
              value={String(t.tops.count)}
              sub={topsSub(t.tops.count, t.boardsCompleted)}
              to={isMe && t.tops.latest ? `/t/${t.tops.latest.tournamentId}/b/${t.tops.latest.boardNo}` : undefined}
            />
          </div>

          {stats.trickDelta.avgDelta !== null ? (
            <PerforatedPanel
              heading={`TRICKS TAKEN — ${stats.trickDelta.boards} CONTRACT${stats.trickDelta.boards === 1 ? '' : 'S'}`}
              className="stats-trickdelta num"
            >
              <StemChart
                points={stats.trickDelta.buckets.map((b) => ({
                  tick: TRICK_DELTA_TICKS[b.delta],
                  pct: Math.round((b.count / stats.trickDelta.boards) * 100),
                  count: b.count,
                }))}
                avgIndex={stats.trickDelta.avgDelta + 3}
                avgLabel={`Ø ${stats.trickDelta.avgDelta >= 0 ? '+' : '−'}${Math.abs(stats.trickDelta.avgDelta)}`}
                leftCaption="short of contract"
                rightCaption="over contract"
              />
              <div className="stats-trickdelta-note">
                <GlossaryProse text={trickDeltaNote(stats.trickDelta.avgDelta)} />
              </div>
            </PerforatedPanel>
          ) : null}

          {percentileRows.length > 0 ? (
            <PerforatedPanel heading="VERSUS THE FIELD" className="stats-versus num">
              {percentileRows.map((r) => (
                <div key={r.label} className="stats-versus-row">
                  <span className="stats-versus-label">
                    {r.slug ? <GlossLabel text={r.label} slug={r.slug} /> : <GlossaryProse text={r.label} />}
                  </span>
                  <PctBar pct={r.pct} />
                  <span className="stats-versus-note">
                    <GlossaryProse text={`better than ${r.pct}% of ${r.of}`} />
                  </span>
                </div>
              ))}
            </PerforatedPanel>
          ) : null}

          {stats.rivals.length > 0 ? (
            <PerforatedPanel heading="RIVALRIES" className="stats-rivals num">
              {/* The row was a single whole-row Link. It can't stay one now
                  that it carries a second destination — a nested <a> is invalid
                  and the browser drops it — so the profile link is the row's
                  heading and Compare sits beside it as its own target. The
                  people you've crossed most are exactly the ones worth
                  comparing against, which is why this is the second door.
                  Only on your OWN profile: these rivals are yours, and the
                  comparison is always viewer-scoped. */}
              {stats.rivals.map((r) => (
                <div key={r.userId} className="stats-rival-row">
                  <div className="stats-rival-head">
                    <Link to={`/players/${r.userId}`} className="stats-rival-name">
                      {r.handle}
                      {r.kind === 'ai' ? <span className="house-tag">HOUSE</span> : null}
                    </Link>
                    <span className="stats-rival-record">
                      {r.record.ahead}-{r.record.behind}
                      {r.record.tied ? `-${r.record.tied}` : ''}
                    </span>
                  </div>
                  <div className="stats-rival-note">{rivalLine(r)}</div>
                  {isMe && me?.user && me.user.boards >= compareFloor && r.boards >= compareFloor ? (
                    <Link to={`/compare/${r.userId}`} className="stats-rival-compare">
                      COMPARE →
                    </Link>
                  ) : null}
                </div>
              ))}
            </PerforatedPanel>
          ) : null}
        </>
      )}

      {/* Appearance and sign-out used to live here, as the only two things on
          your own profile that weren't a record of play. They are on the
          settings gate now (pages/Settings.tsx) with the rest of them — this
          page is the ledger, not the office. */}
    </div>
  );
}
