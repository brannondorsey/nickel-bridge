import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AnalysisMoment,
  AnalysisPly,
  AnalysisView,
  BoardView,
  RANK_CHARS,
  SEAT_SHORT,
  SUIT_SYMBOLS,
  api,
  callDisplay,
  cardRank,
  cardSuit,
  displaySort,
  suitClass,
} from '../api';
import { Button } from '../components/ds/Button';
import { InkStamp } from '../components/ds/InkStamp';
import { Loading } from '../components/ds/Loading';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { PrefSwitch } from '../components/ds/PrefSwitch';
import { ScreenHeader } from '../components/ds/AppHeader';
import { StarGrade } from '../components/ds/StarGrade';
import { CallText } from '../components/game/CallText';
import { GlossaryProse } from '../components/game/GlossaryProse';
import { HandFan } from '../components/game/HandFan';
import { motionOK, trickWinner } from '../components/game/playAnim';
import { TrickArea } from '../components/game/TrickArea';
import { signedScore } from '../format';
import { buildReplayViews, firstPlyOfTrick, trickOfPly } from '../replay/replayViews';
import { useReplay } from '../replay/useReplay';

/**
 * Analyze — "The Second Crossing": walking a finished board back, without
 * lying about it. Two lenses over one board (a URL search param, not a
 * stored preference — a reading position, and it makes a moment shareable):
 *
 *   THE OVERVIEW (default) — the WHERE IT TURNED moments ledger (play AND
 *   bid moments — the ledger is the only bidding surface; the Result's own
 *   YOUR BIDDING table already covers the call-by-call recap, so it is not
 *   repeated here) plus THE CARDS WERE WORTH (par with the field as its
 *   reality check). THE PLAY — the full replay of the play over the real
 *   board UI, all hands open, under the audit ribbon; reduced motion renders
 *   it as a static trick-by-trick list instead (a legitimate reading, not a
 *   fallback).
 *
 * All verdicts arrive pre-computed from GET .../analysis (the Compare
 * precedent — this screen re-derives no statistics), and stage 4 (par + the
 * counterfactual auctions) is only requested by the lens that shows it, so
 * a play-lens open never pays for the DD table. MP figures render HERE and
 * nowhere else in the app — as +N opportunity in the positive ink, never a
 * −penalty.
 */

type Lens = 'overview' | 'play';

const LENS_OPTIONS: { value: Lens; label: string }[] = [
  { value: 'overview', label: 'THE OVERVIEW' },
  { value: 'play', label: 'THE PLAY' },
];

/** ?lens= values accepted from the URL — the original three-lens shape's
 *  'crossing' and 'auction' both land on the overview, so shared links from
 *  the first preview keep working */
function lensFromParam(raw: string | null): Lens {
  return raw === 'play' ? 'play' : 'overview';
}

/**
 * +38 MP, tabular, aria-hidden (the row's accessible name carries the
 * reading). The sign is a PLUS on purpose: a moment is matchpoints that were
 * there for the taking — an opportunity, not a penalty — so the figure wears
 * the positive ink (`--positive`, which the colourblind palette leaves
 * alone; the + sign carries the direction on its own, colour only
 * reinforces). Excused moments mute it: set aside, not on offer.
 */
function MpGain({ gain, muted = false }: { gain: number; muted?: boolean }) {
  return (
    <span className={`num moment-gain${muted ? ' muted' : ''}`} aria-hidden="true">
      +{Math.round(gain)} MP
    </span>
  );
}

function cardLabel(card: number): string {
  return `${RANK_CHARS[cardRank(card)]}${SUIT_SYMBOLS[cardSuit(card)]}`;
}

function CardText({ card }: { card: number }) {
  return (
    <b className="num">
      {RANK_CHARS[cardRank(card)]}
      <span className={suitClass(cardSuit(card))}>{SUIT_SYMBOLS[cardSuit(card)]}</span>
    </b>
  );
}

export default function Analyze() {
  const { tid, no } = useParams();
  const navigate = useNavigate();
  const tournamentId = Number(tid);
  const boardNo = Number(no);
  const [params, setParams] = useSearchParams();
  const lens = lensFromParam(params.get('lens'));
  const wantPar = lens === 'overview';

  const [board, setBoard] = useState<BoardView | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .board(tournamentId, boardNo)
      .then((b) => alive && setBoard(b))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [tournamentId, boardNo]);

  // The analysis, computed server-side on first open and cached. Refetched
  // with par=1 when a lens that shows it is opened and the cached payload
  // doesn't carry it yet — the backfill updates the same cache row.
  const parLoadedRef = useRef(false);
  useEffect(() => {
    if (analysis && (!wantPar || analysis.par || parLoadedRef.current)) return;
    let alive = true;
    if (wantPar) parLoadedRef.current = true;
    api
      .analysis(tournamentId, boardNo, wantPar)
      .then((a) => alive && setAnalysis(a))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [tournamentId, boardNo, wantPar, analysis]);

  const setLens = (l: Lens) => {
    const next = new URLSearchParams(params);
    next.set('lens', l);
    next.delete('trick');
    setParams(next, { replace: true });
  };
  // Jump into the replay AT the human decision itself, not the top of its
  // trick — the reader tapped a moment, so the moment is what should be on
  // the table. The replay lands it as ONE step: the played card glides into
  // the trick while the engine's pick stays highlighted in the hand.
  const openPlayAt = (ply: number) => {
    const next = new URLSearchParams(params);
    next.set('lens', 'play');
    next.set('ply', String(ply));
    next.delete('trick');
    setParams(next);
  };

  if (error) {
    return (
      <div className="board-page analyze-page">
        <div className="notice-error">{error}</div>
        <div className="board-actions">
          <Button variant="secondary" to={`/t/${tournamentId}/b/${boardNo}`}>
            Back to the board
          </Button>
        </div>
      </div>
    );
  }
  if (!board || !analysis || board.state !== 'done') {
    return (
      <div className="board-page analyze-page">
        <Loading />
      </div>
    );
  }

  const r = board.result;
  const sub = r
    ? `${r.contractLabel} · ${signedScore(r.scoreNS)}${analysis.actualPct !== null ? ` · ${Math.round(analysis.actualPct)}%` : ''}`
    : undefined;

  return (
    <div className="board-page analyze-page">
      <ScreenHeader title={`CROSSING ${tournamentId} — BOARD ${boardNo}`} caption={sub} onBack={() => navigate(`/t/${tournamentId}/b/${boardNo}`)} />
      <div className="analyze-lens">
        <PrefSwitch label="Lens" value={lens} options={LENS_OPTIONS} onChange={setLens} />
      </div>

      {lens === 'overview' ? <WhereItTurned analysis={analysis} onOpenPlay={openPlayAt} /> : null}
      {lens === 'overview' ? <ParPanel board={board} analysis={analysis} /> : null}
      {lens === 'play' ? (
        analysis.contract && board.playHistory?.length ? (
          <PlayLens
            board={board}
            analysis={analysis}
            initialPly={params.get('ply') !== null ? Number(params.get('ply')) || 0 : null}
            initialTrick={Number(params.get('trick') ?? '1') || 1}
          />
        ) : (
          <div className="perf-panel analyze-panel">
            <p className="analyze-finding">A passed-out board has no play to walk. The auction lens still applies.</p>
          </div>
        )
      ) : null}

      <div className="board-actions">
        <Button variant="secondary" to={`/t/${tournamentId}/b/${boardNo}`}>
          Back to the board
        </Button>
      </div>
    </div>
  );
}

/**
 * ① WHERE IT TURNED — the moments ledger. A list of links, not a slider: the
 * moments are discrete and few. Each row's accessible name carries the whole
 * reading; the visual cost figure is aria-hidden so nothing announces twice.
 * Cost direction is carried by sign and position, never by colour alone.
 */
function WhereItTurned({
  analysis,
  onOpenPlay,
}: {
  analysis: AnalysisView;
  onOpenPlay: (ply: number) => void;
}) {
  const { moments, setAside } = analysis;
  return (
    <PerforatedPanel heading="WHERE IT TURNED" className="analyze-moments">
      {analysis.singleField ? (
        <p className="analyze-finding">Only you have played this board. Come back once the field fills — a cost needs a field to be measured against.</p>
      ) : moments.length === 0 ? (
        <p className="analyze-finding">Nothing turned on a single card. The field played it much as you did.</p>
      ) : (
        <>
          {moments.map((m) => (
            <MomentRow
              key={m.kind === 'play' ? `p${m.ply}` : `b${m.callIndex}`}
              moment={m}
              analysis={analysis}
              onOpen={m.kind === 'play' ? () => onOpenPlay(m.ply!) : null}
            />
          ))}
          {setAside > 0 ? (
            <p className="analyze-overflow">
              {setAside === 1 ? 'One more moment' : `${setAside} more moments`} set aside — the {moments.length} above were worth the most.
            </p>
          ) : null}
        </>
      )}
    </PerforatedPanel>
  );
}

/** the aside sentence under a moment row — the copy deck's register, data-filled */
function momentAside(m: AnalysisMoment, analysis: AnalysisView): string {
  if (m.kind === 'bid') {
    const call = analysis.par?.calls.find((c) => c.callIndex === m.callIndex);
    if (call?.cf) {
      return `${callDisplay(call.bestCall)} reaches ${call.cf.contractLabel} — ${signedScore(call.cf.scoreNS)}, and ${Math.round(call.cf.cfPct ?? 0)}% instead of ${Math.round(analysis.actualPct ?? 0)}%. The robots' replies are re-run, not remembered.`;
    }
    return 'The robot bid differently here.';
  }
  const ply = analysis.plies.find((p) => p.ply === m.ply);
  if (m.excused) return 'Nothing to fault here. The winning card was invisible from your seat.';
  if (ply?.sampled) {
    return `The engine, from your seat, plays ${cardLabel(ply.sampled.bestCard)} — worth ${Math.round(ply.cfPct ?? 0)}% instead of ${Math.round(analysis.actualPct ?? 0)}%.`;
  }
  return 'The better card was there to be found.';
}

function MomentRow({
  moment: m,
  analysis,
  onOpen,
}: {
  moment: AnalysisMoment;
  analysis: AnalysisView;
  /** null = a finding with nowhere to go (bid moments — the auction has no replay) */
  onOpen: (() => void) | null;
}) {
  const aside = momentAside(m, analysis);
  const name =
    m.kind === 'play'
      ? `Trick ${m.trick}, ${m.excused ? `excused — ${Math.round(m.mpCost)} matchpoints set aside` : `${m.grade} of 3 stars, ${Math.round(m.mpCost)} more matchpoints were there`}. ${aside}`
      : `Your bid — ${Math.round(m.mpCost)} more matchpoints were there. ${aside}`;
  const body = (
    <>
      <span className="moment-main" aria-hidden={onOpen ? 'true' : undefined}>
        <b className="moment-where num">{m.kind === 'play' ? `Trick ${m.trick}` : <>Your <CallText call={m.call!} /></>}</b>
        {m.kind === 'play' ? (
          m.excused ? (
            <InkStamp rotate={-4}>EXCUSED</InkStamp>
          ) : (
            <StarGrade stars={m.grade ?? 0} />
          )
        ) : null}
        <MpGain gain={m.mpCost} muted={Boolean(m.excused)} />
        {onOpen ? <span className="moment-chev">›</span> : null}
      </span>
      <span className="moment-aside" aria-hidden={onOpen ? 'true' : undefined}>
        <GlossaryProse text={aside} />
      </span>
    </>
  );
  // a play moment opens the replay at its decision; a bid moment is a
  // finding, not a door — its whole reading is already on the row
  return onOpen ? (
    <button type="button" className="moment-row" onClick={onOpen} aria-label={name}>
      {body}
    </button>
  ) : (
    <div className="moment-row moment-row-static">{body}</div>
  );
}

/**
 * ② THE CARDS WERE WORTH — par and the field in ONE panel: the field is the
 * reality check on par, and neither number is allowed to appear alone. (The
 * Result's own YOUR BIDDING table covers the call-by-call recap; the ledger's
 * bid moments carry the counterfactual auctions, so neither is repeated here.)
 */
function ParPanel({ board, analysis }: { board: BoardView; analysis: AnalysisView }) {
  const par = analysis.par;
  const fieldCounts = new Map<string, number>();
  for (const f of board.result?.field ?? []) {
    const token = f.contract.split(' ')[0];
    fieldCounts.set(token, (fieldCounts.get(token) ?? 0) + 1);
  }
  return (
    <PerforatedPanel heading="THE CARDS WERE WORTH" className="analyze-par">
      {par ? (
        <>
          <p className="analyze-parline num">
            <b>
              <GlossaryProse text={par.parContracts.join(' · ')} /> — {signedScore(par.parScore)}.
            </b>
          </p>
          <p className="analyze-finding">Par is played with all four hands face up. Nobody bids that way.</p>
          {fieldCounts.size ? (
            <p className="analyze-fieldline num">
              The field here:{' '}
              {[...fieldCounts.entries()].map(([token, n], i) => (
                <span key={token}>
                  {i > 0 ? ' · ' : ''}
                  <GlossaryProse text={token} />
                  {n > 1 ? ` ×${n}` : ''}
                </span>
              ))}
              .
            </p>
          ) : null}
        </>
      ) : (
        <p className="analyze-finding">Weighing the cards…</p>
      )}
    </PerforatedPanel>
  );
}

/** the DD margin mark for the card at flat-play index j, declarer-perspective (RealBridge notation) */
function ddMark(analysis: AnalysisView, j: number): string | null {
  const t = analysis.ddTricks;
  if (!t || j + 1 >= t.length) return null;
  const d = t[j + 1] - t[j];
  if (d === 0) return '=';
  return d > 0 ? `+${d}` : `${d}`;
}

/**
 * ③ THE PLAY — the replay. Forward steps stage the real one-card glide
 * (useReplay + TrickArea's prev-diff animation); BACK A CARD and trick pips
 * cut. The audit ribbon narrates the card the board is currently showing —
 * it follows the replay's own view, so a staged glide finishes before the
 * caption moves on (the tour's lagging-caption move, inherited through the
 * same machinery). Under reduced motion (or no WAAPI) the whole lens is a
 * static trick-by-trick list with the same annotations.
 */
function PlayLens({
  board,
  analysis,
  initialPly,
  initialTrick,
}: {
  board: BoardView;
  analysis: AnalysisView;
  initialPly: number | null;
  initialTrick: number;
}) {
  const views = useMemo(() => buildReplayViews(board), [board]);
  if (!motionOK()) return <StaticPlayList board={board} analysis={analysis} />;
  return (
    <ReplayLens
      board={board}
      analysis={analysis}
      views={views}
      initialPly={initialPly ?? firstPlyOfTrick(initialTrick)}
    />
  );
}

function ReplayLens({
  board,
  analysis,
  views,
  initialPly,
}: {
  board: BoardView;
  analysis: AnalysisView;
  views: BoardView[];
  initialPly: number;
}) {
  const replay = useReplay({ fastForward: true });
  const totalPlies = views.length - 1;
  const [ply, setPly] = useState(() => Math.max(0, Math.min(initialPly, totalPlies)));
  // The graded decision the replay is currently sitting ON (a collapsed
  // moment landing leaves `ply` one past the decision — the played card is
  // already in the trick — so the pager needs its own anchor to know which
  // moment "here" is). Cleared by any manual step or pip jump.
  const [curMoment, setCurMoment] = useState<number | null>(null);

  // A moment lands as ONE step: cut to the decision, then immediately stage
  // the played card's glide into the trick — so the card that was played
  // (animated in) and the engine's pick (highlighted where it still sits in
  // the hand) are on screen at the same time, with no NEXT press between
  // "what should have happened" and "what did". A non-graded target is a
  // plain cut, same as the pips.
  // Only JUDGED decisions are moments. Stage 3's sampled verdict exists for
  // exactly the plies that cleared the matchpoint floor (or the trick gate in
  // a single field); the sub-floor candidates — a double-dummy trick that
  // moved no matchpoints worth naming — stay in `plies` for the annotations
  // but are not stops on the moment pager and never collapse a landing.
  const momentPlies = useMemo(() => analysis.plies.filter((v) => v.sampled !== null), [analysis]);

  const landAt = (target: number) => {
    const p = Math.max(0, Math.min(target, totalPlies));
    const graded = p < totalPlies && momentPlies.some((v) => v.ply === p);
    if (!graded) {
      setCurMoment(null);
      setPly(p);
      replay.cut(views[p]);
      return;
    }
    setCurMoment(p);
    setPly(p + 1);
    replay.cut(views[p]);
    replay.applyTransition(views[p], views[p + 1], 1);
  };

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    landAt(ply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The caption follows what is ON SCREEN: the replay's own view, which lags
  // the ply during a staged glide. Derived from the view's own play count
  // rather than identity in `views` — the staged intermediate steps are
  // fresh lockedView objects stagePlaySteps builds, so an indexOf fallback
  // to `ply` would jump the caption (and its cost stamp) to the destination
  // card before it visually lands.
  const shown = replay.view ?? views[ply];
  const shownPly = Math.min(totalPlies, (shown.completedTricks ?? 0) * 4 + (shown.currentTrick?.length ?? 0));
  // the trick in progress (or about to start) at the shown position — the
  // ribbon's label and the current pip agree on this one number
  const trick = trickOfPly(shownPly >= totalPlies ? totalPlies - 1 : shownPly, totalPlies);

  const next = () => {
    if (ply >= totalPlies) return;
    const p = ply + 1;
    setCurMoment(null);
    setPly(p);
    replay.applyTransition(views[ply], views[p], 1);
  };
  const back = () => {
    if (ply <= 0) return;
    const p = ply - 1;
    setCurMoment(null);
    setPly(p);
    replay.cut(views[p]);
  };
  const jumpTo = (t: number) => {
    const p = Math.min(firstPlyOfTrick(t), totalPlies);
    setCurMoment(null);
    setPly(p);
    replay.cut(views[p]);
  };
  // the graded human decisions either side of the moment being read (the
  // collapsed landing leaves ply one PAST the decision, so the pager anchors
  // on curMoment — otherwise PREV would forever re-land the moment on screen)
  const anchor = curMoment ?? ply;
  const nextMomentPly = momentPlies.find((v) => v.ply > anchor)?.ply ?? null;
  const prevMomentPly = [...momentPlies].reverse().find((v) => v.ply < anchor)?.ply ?? null;

  const caption = captionFor(analysis, board, shownPly);
  const view = shown;
  const dummy = board.dummy;
  const northOpen = dummy !== 0 ? remainingAt(board, shownPly, 0) : null;
  // The engine's card, highlighted where it still sits — the same pre-
  // confirmation `.selected` treatment a live tap uses, so "the card that
  // should have been played" reads in the vocabulary the player already
  // knows. It holds through the played card's landing (the collapsed moment
  // shows both at once) and clears when the replay steps on.
  const highlight = caption.highlight;
  const fanHighlight = highlight !== null && view.hand.includes(highlight) ? highlight : null;

  return (
    <>
      <div className="audit-ribbon" role="status">
        <div className="audit-ribbon-head">
          <span className="label-caps audit-ribbon-who">
            THE AUDIT — TRICK {trick} OF {Math.ceil(totalPlies / 4)}
          </span>
          {caption.gain !== null ? <span className="audit-ribbon-gain num">+{Math.round(caption.gain)} MP</span> : null}
          {caption.excused ? <InkStamp rotate={-4} color="var(--accent)">EXCUSED</InkStamp> : null}
        </div>
        <p>
          <GlossaryProse text={caption.text} />
        </p>
      </div>

      {northOpen ? (
        <div className="analyze-rail north num">
          <span className="analyze-rail-label">NORTH{dummy === 0 ? ' · DUMMY' : ''}</span>
          <SuitLine cards={northOpen} highlight={highlight} />
        </div>
      ) : null}
      <div className="analyze-rails num">
        <div className="analyze-rail side">
          <span className="analyze-rail-label">WEST</span>
          <SuitLine cards={remainingAt(board, shownPly, 3)} highlight={highlight} />
        </div>
        <div className="analyze-rail side right">
          <span className="analyze-rail-label">EAST</span>
          <SuitLine cards={remainingAt(board, shownPly, 1)} highlight={highlight} />
        </div>
      </div>
      <div className="analyze-rail played num">
        <span className="analyze-rail-label">PLAYED</span>
        {shownPly > 0 ? (
          <SuitLine cards={playedAt(board, shownPly)} />
        ) : (
          <span className="analyze-suitline analyze-suitline-empty">—</span>
        )}
      </div>
      <TrickArea board={view} />
      <div className="board-fan">
        <HandFan cards={displaySort(view.hand)} selected={fanHighlight} />
      </div>

      <div className="replay-dock">
        <div className="replay-pips" role="group" aria-label="Jump to a trick">
          {Array.from({ length: Math.ceil(totalPlies / 4) }, (_, i) => {
            const t = i + 1;
            const done = shownPly >= t * 4;
            const cur = trick === t;
            const inTail = analysis.claimedAtPly !== null && firstPlyOfTrick(t) >= analysis.claimedAtPly;
            return (
              <button
                key={t}
                type="button"
                className={`replay-pip${done ? ' done' : ''}${cur ? ' cur' : ''}${inTail ? ' tail' : ''}`}
                aria-label={`Trick ${t}`}
                aria-current={cur ? 'step' : undefined}
                onClick={() => jumpTo(t)}
              />
            );
          })}
        </div>
        <div className="replay-dock-row">
          <Button variant="secondary" onClick={back} disabled={ply <= 0}>
            ‹ BACK A CARD
          </Button>
          <Button onClick={next} disabled={ply >= totalPlies}>
            NEXT CARD →
          </Button>
        </div>
        <div className="replay-dock-row replay-dock-moment">
          <Button variant="secondary" onClick={() => prevMomentPly !== null && landAt(prevMomentPly)} disabled={prevMomentPly === null}>
            ‹ PREV MOMENT
          </Button>
          <Button variant="secondary" onClick={() => nextMomentPly !== null && landAt(nextMomentPly)} disabled={nextMomentPly === null}>
            NEXT MOMENT ›
          </Button>
        </div>
      </div>
    </>
  );
}

function remainingAt(board: BoardView, ply: number, seat: number): number[] {
  const flat = board.playHistory?.flat() ?? [];
  const played = new Set(flat.slice(0, ply).map((t) => t.card));
  return displaySort((board.allHands?.[seat] ?? []).filter((c) => !played.has(c)));
}

/** every card off the hands after `ply` plays — the PLAYED rail's accumulator,
 *  the exact complement of the four remainingAt lines */
function playedAt(board: BoardView, ply: number): number[] {
  const flat = board.playHistory?.flat() ?? [];
  return displaySort(flat.slice(0, ply).map((t) => t.card));
}

/** A hand as one horizontal line of suit groups, wearing the dummy rail's
 *  kerning (thin-space rank separation + its letter-spacing) so the open
 *  hands here read like the exposed hand does on the live board. Each suit
 *  group refuses to break internally; whether the LINE may wrap between
 *  groups is the container's decision (the side rails never do, the PLAYED
 *  rail must — 52 cards fit no single line). */
function SuitLine({ cards, highlight = null }: { cards: number[]; highlight?: number | null }) {
  const bySuit: number[][] = [[], [], [], []];
  for (const c of cards) bySuit[cardSuit(c)].push(c);
  return (
    <span className="analyze-suitline">
      {bySuit.map((suit, s) =>
        suit.length ? (
          <span key={s} className="analyze-suitgroup">
            <span className={suitClass(s)}>{SUIT_SYMBOLS[s]}</span>
            {suit.map((c) => (
              <Fragment key={c}>
                {'\u2009'}
                {c === highlight ? <b className="analyze-hl">{RANK_CHARS[cardRank(c)]}</b> : RANK_CHARS[cardRank(c)]}
              </Fragment>
            ))}
          </span>
        ) : null,
      )}
    </span>
  );
}

interface RibbonCaption {
  text: string;
  /** matchpoints that were there for the taking at this moment (opportunity framing) */
  gain: number | null;
  excused: boolean;
  /** the engine's card, to highlight in whichever hand still holds it */
  highlight: number | null;
}

/**
 * The ribbon's reading for the position after `ply` cards. A PENDING graded
 * decision (the next card to play is one the audit graded) takes precedence
 * over describing the card just played — a moment jump lands exactly here,
 * with the decision still on the table and the engine's pick highlighted in
 * the hand; NEXT CARD then shows what actually happened.
 */
function captionFor(analysis: AnalysisView, board: BoardView, ply: number): RibbonCaption {
  const flat = board.playHistory?.flat() ?? [];
  const seatNames = ['North', 'East', 'South', 'West'];

  // a PENDING caption only fires for a JUDGED decision (stage 3 ran) — a
  // sub-floor candidate has no engine pick to point at and nothing to charge
  const pending = analysis.plies.find((p) => p.ply === ply && p.sampled !== null);
  if (pending?.sampled && !(analysis.claimedAtPly !== null && ply >= analysis.claimedAtPly)) {
    if (pending.sampled.excused) {
      return {
        text: `The turn is here, and there is nothing to find: the engine plays the same ${cardLabel(pending.card)} from your seat — only double dummy sees better.`,
        gain: pending.mpCost,
        excused: true,
        highlight: pending.card,
      };
    }
    const pct =
      pending.cfPct !== null && analysis.actualPct !== null
        ? ` — worth ${Math.round(pending.cfPct)}% instead of ${Math.round(analysis.actualPct)}%`
        : '';
    return {
      text: `The turn is here: ${seatNames[flat[ply]?.seat ?? 2]} to play, and the engine, from your seat, plays ${cardLabel(pending.sampled.bestCard)}${pct}.`,
      gain: pending.mpCost,
      excused: false,
      highlight: pending.sampled.bestCard,
    };
  }

  if (ply === 0) {
    const leader = flat[0] ? SEAT_SHORT[flat[0].seat] : '';
    return {
      text: `The opening lead is ${leader}'s. Step through the play — the audit marks the moments worth more.`,
      gain: null,
      excused: false,
      highlight: null,
    };
  }
  const j = ply - 1; // the card just shown
  const played = flat[j];
  const inTail = analysis.claimedAtPly !== null && j >= analysis.claimedAtPly;
  if (inTail) {
    return {
      text: 'Settled from here — the rest was already yours. These cards were fast-played for both sides.',
      gain: null,
      excused: false,
      highlight: null,
    };
  }
  const verdict = analysis.plies.find((p) => p.ply === j);
  const mark = ddMark(analysis, j);
  const seatName = seatNames[played.seat];
  if (verdict?.sampled) {
    if (verdict.sampled.excused) {
      return {
        text: `Nothing to fault here. Only double dummy finds better — the winning card was invisible from your seat.`,
        gain: verdict.mpCost,
        excused: true,
        highlight: null,
      };
    }
    // the trick loss in words, side-relative (ddLoss is tricks YOUR side gave
    // up) — the raw declarer-perspective +1/−1 notation read backwards on
    // defence, where "+1" meant a trick handed to declarer
    const lost = verdict.ddLoss === 1 ? 'a trick went begging, double dummy' : `${verdict.ddLoss} tricks went begging, double dummy`;
    return {
      text: `${seatName} played ${cardLabel(played.card)} — the moment turned here: ${lost}. The engine, from your seat, plays ${cardLabel(verdict.sampled.bestCard)}.`,
      gain: verdict.mpCost,
      excused: false,
      // the engine's pick stays marked in the hand while the played card sits
      // in the trick — a collapsed moment landing shows both at once
      highlight: verdict.sampled.bestCard,
    };
  }
  if (verdict) {
    // a stage-1 candidate under the audit's floor: a double-dummy trick
    // slipped, but the matchpoints barely noticed — nothing was judged, so
    // nothing is charged and there is no engine pick to show
    const moved =
      verdict.mpCost !== null && Math.round(verdict.mpCost) > 0
        ? `only ${Math.round(verdict.mpCost)} matchpoints moved — under the audit's floor, so it goes unjudged`
        : `no matchpoints moved: the field scores this board the same either way`;
    return {
      text: `${seatName} played ${cardLabel(played.card)} — a double-dummy trick slipped here, but ${moved}.`,
      gain: null,
      excused: false,
      highlight: null,
    };
  }
  const markNote = mark && mark !== '=' ? ` (${mark} double dummy${played.seat % 2 === 1 ? ' — uncharged' : ''})` : '';
  return { text: `${seatName} played ${cardLabel(played.card)}${markNote}.`, gain: null, excused: false, highlight: null };
}

/**
 * ④ The reduced-motion reading: every trick as a printed row, winner
 * underlined, the DD margin in RealBridge notation, the moments expanded in
 * place. The same annotations as the replay, none of the motion — a
 * legitimate way to read it, not a degraded one.
 */
function StaticPlayList({ board, analysis }: { board: BoardView; analysis: AnalysisView }) {
  const tricks = board.playHistory ?? [];
  const strain = board.contract?.strain ?? 4;
  return (
    <PerforatedPanel heading="TRICK BY TRICK — = HOLDS THE CONTRACT · −1 DROPS A TRICK" className="analyze-tricks">
      {tricks.map((trick, ti) => {
        const basePly = ti * 4;
        const winner = trickWinner(trick, strain);
        // judged decisions only — a sub-floor candidate keeps its dd mark in
        // the margin column but expands no verdict row (nothing was judged)
        const rowVerdicts = trick
          .map((tc, i) => ({ tc, verdict: analysis.plies.find((p) => p.ply === basePly + i) }))
          .filter((x) => x.verdict?.sampled);
        const marks = trick
          .map((_, i) => ddMark(analysis, basePly + i))
          .filter((m): m is string => m !== null && m !== '=');
        const inTail = analysis.claimedAtPly !== null && basePly >= analysis.claimedAtPly;
        return (
          <div key={ti} className={`analyze-trickrow${rowVerdicts.length ? ' turned' : ''}`}>
            <div className="analyze-trickrow-main num">
              <b className="analyze-trickno">{ti + 1}</b>
              <span className="analyze-trickcards">
                {trick.map((tc) => (
                  <span key={tc.card} className={`analyze-tc${tc.seat === winner ? ' win' : ''}`}>
                    <small>{SEAT_SHORT[tc.seat]}</small>
                    <CardText card={tc.card} />
                  </span>
                ))}
              </span>
              <span className={`analyze-ddmark${marks.length ? (marks[0].startsWith('-') ? ' drop' : ' back') : ''}`}>
                {inTail ? '·' : marks.length ? marks.join(' ') : '='}
              </span>
            </div>
            {rowVerdicts.map(({ verdict }) => (
              <div key={verdict!.ply} className="analyze-trick-verdict">
                {verdict!.sampled?.excused ? (
                  <InkStamp rotate={-4} color="var(--accent)">EXCUSED</InkStamp>
                ) : verdict!.sampled ? (
                  <StarGrade stars={verdict!.sampled.grade} />
                ) : null}
                {verdict!.mpCost !== null ? <MpGain gain={verdict!.mpCost} muted={Boolean(verdict!.sampled?.excused)} /> : null}
                <span className="moment-aside">
                  <GlossaryProse
                    text={
                      verdict!.sampled!.excused
                        ? 'Nothing to fault here. The winning card was invisible from your seat.'
                        : `The engine, from your seat, plays ${cardLabel(verdict!.sampled!.bestCard)}.`
                    }
                  />
                </span>
              </div>
            ))}
            {inTail && basePly === analysis.claimedAtPly ? (
              <div className="analyze-trick-verdict">
                <span className="moment-aside">Settled from here — the rest was already yours.</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </PerforatedPanel>
  );
}
