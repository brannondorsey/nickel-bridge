import { useEffect, useMemo, useRef, useState } from 'react';
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
import { GRADE_STARS, GRADE_TEXT } from '../components/game/GradeToast';
import { motionOK, trickWinner } from '../components/game/playAnim';
import { TrickArea } from '../components/game/TrickArea';
import { signedScore } from '../format';
import { buildReplayViews, firstPlyOfTrick, trickOfPly } from '../replay/replayViews';
import { useReplay } from '../replay/useReplay';

/**
 * Analyze — "The Second Crossing": walking a finished board back, without
 * lying about it. Three lenses over one board (a URL search param, not a
 * stored preference — a reading position, and it makes a moment shareable):
 *
 *   THE CROSSING (default) — the WHERE IT TURNED moments ledger + the
 *   deepened auction. THE AUCTION — the auction alone. THE PLAY — the full
 *   replay of the play over the real board UI, all hands open, under the
 *   audit ribbon; reduced motion renders it as a static trick-by-trick list
 *   instead (a legitimate reading, not a fallback).
 *
 * All verdicts arrive pre-computed from GET .../analysis (the Compare
 * precedent — this screen re-derives no statistics), and stage 4 (par + the
 * counterfactual auctions) is only requested by the lenses that show it, so
 * a play-lens open never pays for the DD table. MP figures render HERE and
 * nowhere else in the app.
 */

type Lens = 'crossing' | 'auction' | 'play';

const LENS_OPTIONS: { value: Lens; label: string }[] = [
  { value: 'crossing', label: 'THE CROSSING' },
  { value: 'auction', label: 'THE AUCTION' },
  { value: 'play', label: 'THE PLAY' },
];

/** −38 MP, tabular, aria-hidden (the row's accessible name carries the reading) */
function MpCost({ cost, muted = false }: { cost: number; muted?: boolean }) {
  return (
    <span className={`num moment-cost${muted ? ' muted' : ''}`} aria-hidden="true">
      −{Math.round(cost)} MP
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
  const lens = (['crossing', 'auction', 'play'].includes(params.get('lens') ?? '') ? params.get('lens') : 'crossing') as Lens;
  const wantPar = lens !== 'play';

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
  const openPlayAt = (trick: number) => {
    const next = new URLSearchParams(params);
    next.set('lens', 'play');
    next.set('trick', String(trick));
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
      <ScreenHeader title={`THE CROSSING — BOARD ${boardNo}`} caption={sub} onBack={() => navigate(`/t/${tournamentId}/b/${boardNo}`)} />
      <div className="analyze-lens">
        <PrefSwitch label="Lens" value={lens} options={LENS_OPTIONS} onChange={setLens} />
      </div>

      {lens !== 'play' ? <WhereItTurned analysis={analysis} onOpenPlay={openPlayAt} onOpenAuction={() => setLens('auction')} /> : null}
      {lens !== 'play' ? <AuctionLens board={board} analysis={analysis} /> : null}
      {lens === 'play' ? (
        analysis.contract && board.playHistory?.length ? (
          <PlayLens board={board} analysis={analysis} initialTrick={Number(params.get('trick') ?? '1') || 1} />
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
  onOpenAuction,
}: {
  analysis: AnalysisView;
  onOpenPlay: (trick: number) => void;
  onOpenAuction: () => void;
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
              onOpen={() => (m.kind === 'play' ? onOpenPlay(m.trick!) : onOpenAuction())}
            />
          ))}
          {setAside > 0 ? (
            <p className="analyze-overflow">
              {setAside === 1 ? 'One more moment' : `${setAside} more moments`} set aside — the {moments.length} above cost the most.
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
      return `The robot's auction reaches ${call.cf.contractLabel} — ${signedScore(call.cf.scoreNS)}, and ${Math.round(call.cf.cfPct ?? 0)}% instead of ${Math.round(analysis.actualPct ?? 0)}%.`;
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
  onOpen: () => void;
}) {
  const where = m.kind === 'play' ? `TRICK ${m.trick}` : null;
  const aside = momentAside(m, analysis);
  const name =
    m.kind === 'play'
      ? `Trick ${m.trick}, ${m.excused ? 'excused' : `${m.grade} of 3 stars`}, cost ${Math.round(m.mpCost)} matchpoints. ${aside}`
      : `Your bid, cost ${Math.round(m.mpCost)} matchpoints. ${aside}`;
  return (
    <button type="button" className="moment-row" onClick={onOpen} aria-label={name}>
      <span className="moment-main" aria-hidden="true">
        <b className="moment-where num">{where ?? <>YOUR <CallText call={m.call!} /></>}</b>
        {m.kind === 'play' ? (
          m.excused ? (
            <InkStamp rotate={-4}>EXCUSED</InkStamp>
          ) : (
            <StarGrade stars={m.grade ?? 0} />
          )
        ) : null}
        <MpCost cost={m.mpCost} muted={Boolean(m.excused)} />
        <span className="moment-chev">›</span>
      </span>
      <span className="moment-aside" aria-hidden="true">
        <GlossaryProse text={aside} />
      </span>
    </button>
  );
}

/**
 * ② The auction lens — YOUR BIDDING deepened with counterfactual lines, and
 * par + the field in ONE panel: the field is the reality check on par, and
 * neither number is allowed to appear alone.
 */
function AuctionLens({ board, analysis }: { board: BoardView; analysis: AnalysisView }) {
  const par = analysis.par;
  const callFor = (i: number) => par?.calls.find((c) => c.callIndex === i);
  // human calls in call order — bidEvals are exactly the human's calls
  let humanIdx = -1;
  const fieldCounts = new Map<string, number>();
  for (const f of board.result?.field ?? []) {
    const token = f.contract.split(' ')[0];
    fieldCounts.set(token, (fieldCounts.get(token) ?? 0) + 1);
  }
  return (
    <>
      {board.bidEvals.length ? (
        <div className="result-bidding analyze-bidding">
          <div className="label-caps result-bidding-head">YOUR BIDDING</div>
          {board.bidEvals.map((e, i) => {
            humanIdx = board.auction.findIndex((a, j) => j > humanIdx && a.isHuman);
            const ca = callFor(humanIdx);
            return (
              <div key={i}>
                <div className="result-bid-row">
                  <b className="result-bid-call">
                    <CallText call={e.call} />
                  </b>
                  <StarGrade stars={GRADE_STARS[e.grade]} />
                  <span>
                    {GRADE_TEXT[e.grade]}
                    {e.bestCall !== e.call ? (
                      <>
                        {' '}
                        — robot bid <CallText call={e.bestCall} />
                      </>
                    ) : (
                      <> — the robot's choice too</>
                    )}
                  </span>
                </div>
                {ca?.cf ? (
                  <div className="analyze-cf">
                    <GlossaryProse
                      text={`${callDisplay(ca.bestCall)} would have reached ${ca.cf.contractLabel} — ${signedScore(ca.cf.scoreNS)}${
                        ca.cf.cfPct !== null && analysis.actualPct !== null
                          ? `, and ${Math.round(ca.cf.cfPct)}% instead of ${Math.round(analysis.actualPct)}%`
                          : ''
                      }. The robots' replies are re-run, not remembered.`}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

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
    </>
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
function PlayLens({ board, analysis, initialTrick }: { board: BoardView; analysis: AnalysisView; initialTrick: number }) {
  const views = useMemo(() => buildReplayViews(board), [board]);
  if (!motionOK()) return <StaticPlayList board={board} analysis={analysis} />;
  return <ReplayLens board={board} analysis={analysis} views={views} initialTrick={initialTrick} />;
}

function ReplayLens({
  board,
  analysis,
  views,
  initialTrick,
}: {
  board: BoardView;
  analysis: AnalysisView;
  views: BoardView[];
  initialTrick: number;
}) {
  const replay = useReplay({ fastForward: true });
  const totalPlies = views.length - 1;
  const [ply, setPly] = useState(() => Math.min(firstPlyOfTrick(initialTrick), totalPlies));
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    replay.cut(views[ply]);
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
    setPly(p);
    replay.applyTransition(views[ply], views[p], 1);
  };
  const back = () => {
    if (ply <= 0) return;
    const p = ply - 1;
    setPly(p);
    replay.cut(views[p]);
  };
  const jumpTo = (t: number) => {
    const p = Math.min(firstPlyOfTrick(t), totalPlies);
    setPly(p);
    replay.cut(views[p]);
  };

  const caption = captionFor(analysis, board, shownPly);
  const view = shown;
  const dummy = board.dummy;
  const northOpen = dummy !== 0 ? remainingAt(board, shownPly, 0) : null;

  return (
    <>
      <div className="audit-ribbon" role="status">
        <div className="audit-ribbon-head">
          <span className="label-caps audit-ribbon-who">
            THE AUDIT — TRICK {trick} OF {Math.ceil(totalPlies / 4)}
          </span>
          {caption.cost !== null ? <span className="audit-ribbon-cost num">−{Math.round(caption.cost)} MP</span> : null}
          {caption.excused ? <InkStamp rotate={-4} color="var(--accent)">EXCUSED</InkStamp> : null}
        </div>
        <p>
          <GlossaryProse text={caption.text} />
        </p>
      </div>

      {northOpen ? (
        <div className="analyze-rail num">
          <span className="analyze-rail-label">NORTH{dummy === 0 ? ' · DUMMY' : ''}</span>
          <SuitLine cards={northOpen} />
        </div>
      ) : null}
      <div className="analyze-rails num">
        <div className="analyze-rail side">
          <span className="analyze-rail-label">WEST</span>
          <SuitLine cards={remainingAt(board, shownPly, 3)} />
        </div>
        <div className="analyze-rail side right">
          <span className="analyze-rail-label">EAST</span>
          <SuitLine cards={remainingAt(board, shownPly, 1)} />
        </div>
      </div>
      <TrickArea board={view} />
      <div className="board-fan">
        <HandFan cards={displaySort(view.hand)} />
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
      </div>
    </>
  );
}

function remainingAt(board: BoardView, ply: number, seat: number): number[] {
  const flat = board.playHistory?.flat() ?? [];
  const played = new Set(flat.slice(0, ply).map((t) => t.card));
  return displaySort((board.allHands?.[seat] ?? []).filter((c) => !played.has(c)));
}

function SuitLine({ cards }: { cards: number[] }) {
  const bySuit: number[][] = [[], [], [], []];
  for (const c of cards) bySuit[cardSuit(c)].push(c);
  return (
    <span className="analyze-suitline">
      {bySuit.map((suit, s) =>
        suit.length ? (
          <span key={s}>
            <span className={suitClass(s)}>{SUIT_SYMBOLS[s]}</span>
            {suit.map((c) => RANK_CHARS[cardRank(c)]).join('')}{' '}
          </span>
        ) : null,
      )}
    </span>
  );
}

/** the ribbon's reading for the position after `ply` cards */
function captionFor(
  analysis: AnalysisView,
  board: BoardView,
  ply: number,
): { text: string; cost: number | null; excused: boolean } {
  const flat = board.playHistory?.flat() ?? [];
  if (ply === 0) {
    const leader = flat[0] ? SEAT_SHORT[flat[0].seat] : '';
    return { text: `The opening lead is ${leader}'s. Step through the play — the audit marks where it turned.`, cost: null, excused: false };
  }
  const j = ply - 1; // the card just shown
  const played = flat[j];
  const inTail = analysis.claimedAtPly !== null && j >= analysis.claimedAtPly;
  if (inTail) {
    return { text: 'Settled from here — the rest was already yours. These cards were fast-played for both sides.', cost: null, excused: false };
  }
  const verdict = analysis.plies.find((p) => p.ply === j);
  const mark = ddMark(analysis, j);
  const seatName = ['North', 'East', 'South', 'West'][played.seat];
  if (verdict) {
    if (verdict.sampled?.excused) {
      return {
        text: `Nothing to fault here. Only double dummy finds better — the winning card was invisible from your seat.`,
        cost: verdict.mpCost,
        excused: true,
      };
    }
    const better = verdict.sampled ? ` The engine, from your seat, plays ${cardLabel(verdict.sampled.bestCard)}.` : '';
    return {
      text: `${seatName} played ${cardLabel(played.card)} — the contract turned here (${mark ?? ''} double dummy).${better}`,
      cost: verdict.mpCost,
      excused: false,
    };
  }
  const markNote = mark && mark !== '=' ? ` (${mark} double dummy${played.seat % 2 === 1 ? ' — uncharged' : ''})` : '';
  return { text: `${seatName} played ${cardLabel(played.card)}${markNote}.`, cost: null, excused: false };
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
        const rowVerdicts = trick
          .map((tc, i) => ({ tc, verdict: analysis.plies.find((p) => p.ply === basePly + i) }))
          .filter((x) => x.verdict);
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
                {verdict!.mpCost !== null ? <MpCost cost={verdict!.mpCost} muted={Boolean(verdict!.sampled?.excused)} /> : null}
                <span className="moment-aside">
                  <GlossaryProse
                    text={
                      verdict!.sampled?.excused
                        ? 'Nothing to fault here. The winning card was invisible from your seat.'
                        : verdict!.sampled
                          ? `The engine, from your seat, plays ${cardLabel(verdict!.sampled.bestCard)}.`
                          : `Double dummy keeps ${verdict!.cfTricksDeclarer} tricks in reach here.`
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
