import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMe } from '../App';
import {
  AnalysisMoment,
  AnalysisPly,
  AnalysisView,
  BoardView,
  RANK_CHARS,
  RehearsalSummary,
  SEAT_SHORT,
  SUIT_SYMBOLS,
  TrickCard,
  api,
  callDisplay,
  cardRank,
  cardSuit,
  displaySort,
  suitClass,
  suitDisplayOrder,
  foilForDisplay,
  trumpForDisplay,
} from '../api';
import { Button } from '../components/ds/Button';
import { InkStamp } from '../components/ds/InkStamp';
import { Loading } from '../components/ds/Loading';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { PrefSwitch } from '../components/ds/PrefSwitch';
import { ScreenHeader } from '../components/ds/AppHeader';
import { StarGrade } from '../components/ds/StarGrade';
import { CallText } from '../components/game/CallText';
import { ContractLabel } from '../components/game/ContractLabel';
import { GlossaryProse } from '../components/game/GlossaryProse';
import { HandFan } from '../components/game/HandFan';
import { motionOK, trickWinner } from '../components/game/playAnim';
import { TrickArea } from '../components/game/TrickArea';
import { signedScore, tournamentNo } from '../format';
import { buildReplayViews, firstPlyOfTrick, plyOfSeatInTrick } from '../replay/replayViews';
import { useReplay } from '../replay/useReplay';
import { railLayout } from './analyzeRail';

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
 * reinforces).
 */
function MpGain({ gain }: { gain: number }) {
  return (
    <span className="num moment-gain" aria-hidden="true">
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
  // Every "Play From Here" attempt on this board, newest first — feeds the
  // per-moment rail, the board-wide YOUR REHEARSALS list, and THE CARDS WERE
  // WORTH's third stub. Fetched alongside board/analysis rather than lazily,
  // since all three surfaces can render as soon as the overview does.
  const [rehearsals, setRehearsals] = useState<RehearsalSummary[]>([]);

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

  useEffect(() => {
    let alive = true;
    api
      .rehearsals(tournamentId, boardNo)
      .then((r) => alive && setRehearsals(r.rehearsals))
      .catch(() => {
        // Non-fatal: a rehearsal-history hiccup shouldn't block the rest of
        // the overview from rendering — the surfaces below just stay empty.
      });
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
  // the trick and the engine's pick lights up in the hand as it lands.
  const openPlayAt = (ply: number) => {
    const next = new URLSearchParams(params);
    next.set('lens', 'play');
    next.set('ply', String(ply));
    next.delete('trick');
    setParams(next);
  };
  // "Play From Here" — branch the real board at `ply` into a live rehearsal
  // (a real, ordinary, hidden-hand board of its own — never Analyze's own
  // all-hands-open replay). No confirmation step: straight into the new
  // board, the same way the two ordinary board actions below never confirm.
  const startRehearsal = (ply: number) => {
    api
      .rehearse(tournamentId, boardNo, ply)
      .then((r) => navigate(`/t/${r.tournamentId}/b/${r.boardNo}`))
      .catch((e) => setError((e as Error).message));
  };
  // Explicit discard for an attempt the player doesn't want kept — the
  // escape hatch beside startRehearsal's own same-ply resume (a second tap
  // on the same moment reopens whichever attempt is still in progress there
  // rather than piling up another). Optimistic: the stub disappears on tap,
  // and only reconciles from the server if the delete actually failed.
  const discardRehearsalAttempt = (rehearsalTournamentId: number) => {
    setRehearsals((prev) => prev.filter((rh) => rh.tournamentId !== rehearsalTournamentId));
    api.discardRehearsal(tournamentId, boardNo, rehearsalTournamentId).catch(() => {
      api
        .rehearsals(tournamentId, boardNo)
        .then((r) => setRehearsals(r.rehearsals))
        .catch(() => {});
    });
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
      <ScreenHeader title={`CROSSING ${tournamentNo(board.tournamentNumber, board.tournamentId)} — BOARD ${boardNo}`} caption={sub} onBack={() => navigate(`/t/${tournamentId}/b/${boardNo}`)} />
      <div className="analyze-lens">
        <PrefSwitch label="Lens" value={lens} options={LENS_OPTIONS} onChange={setLens} />
      </div>

      {lens === 'overview' ? <CardsWorthPanel board={board} analysis={analysis} rehearsals={rehearsals} /> : null}
      {lens === 'overview' ? (
        <WhereItTurned
          analysis={analysis}
          onOpenPlay={openPlayAt}
          onRehearse={startRehearsal}
          onDiscardRehearsal={discardRehearsalAttempt}
          rehearsals={rehearsals}
          actualScoreNS={r?.scoreNS ?? null}
        />
      ) : null}
      {lens === 'overview' ? <YourRehearsals rehearsals={rehearsals} onDiscard={discardRehearsalAttempt} /> : null}
      {lens === 'play' ? (
        analysis.contract && board.playHistory?.length ? (
          <PlayLens
            board={board}
            analysis={analysis}
            initialPly={params.get('ply') !== null ? Number(params.get('ply')) || 0 : null}
            initialTrick={Number(params.get('trick') ?? '1') || 1}
            onRehearse={startRehearsal}
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
 * ② WHERE IT TURNED — the moments ledger. A list of links, not a slider: the
 * moments are discrete and few. Each row's accessible name carries the whole
 * reading; the visual cost figure is aria-hidden so nothing announces twice.
 * Cost direction is carried by sign and position, never by colour alone.
 */
function WhereItTurned({
  analysis,
  onOpenPlay,
  onRehearse,
  onDiscardRehearsal,
  rehearsals,
  actualScoreNS,
}: {
  analysis: AnalysisView;
  onOpenPlay: (ply: number) => void;
  /** launches a "Play From Here" rehearsal at `ply` — only ever wired to play
   *  moments below (the auction never branches, only card play does) */
  onRehearse: (ply: number) => void;
  onDiscardRehearsal: (rehearsalTournamentId: number) => void;
  rehearsals: RehearsalSummary[];
  /** what your real table scored on this board — the one thing a rehearsal
   *  stub's score is measured against; null on a board with no result row */
  actualScoreNS: number | null;
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
              onRehearse={m.kind === 'play' ? () => onRehearse(m.ply!) : null}
              onDiscardRehearsal={onDiscardRehearsal}
              rehearsals={m.kind === 'play' ? rehearsals.filter((rh) => rh.branchPly === m.ply) : []}
              actualScoreNS={actualScoreNS}
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
  if (ply?.sampled) {
    return `The engine, from your seat, plays ${cardLabel(ply.sampled.bestCard)} — worth ${Math.round(ply.cfPct ?? 0)}% instead of ${Math.round(analysis.actualPct ?? 0)}%.`;
  }
  return 'The better card was there to be found.';
}

function MomentRow({
  moment: m,
  analysis,
  onOpen,
  onRehearse,
  onDiscardRehearsal,
  rehearsals,
  actualScoreNS,
}: {
  moment: AnalysisMoment;
  analysis: AnalysisView;
  /** null = a finding with nowhere to go (bid moments — the auction has no replay) */
  onOpen: (() => void) | null;
  /** null = no branch point here either (bid moments again — see onOpen) */
  onRehearse: (() => void) | null;
  onDiscardRehearsal: (rehearsalTournamentId: number) => void;
  /** past attempts branched from exactly this moment's ply — always [] on a bid moment */
  rehearsals: RehearsalSummary[];
  /** your real table's score, for colouring each stub — see RehearsalRail */
  actualScoreNS: number | null;
}) {
  const aside = momentAside(m, analysis);
  const name =
    m.kind === 'play'
      ? `Trick ${m.trick}, ${m.grade} of 3 stars, ${Math.round(m.mpCost)} more matchpoints were there. ${aside}`
      : `Your bid — ${Math.round(m.mpCost)} more matchpoints were there. ${aside}`;
  const body = (
    <>
      <span className="moment-main" aria-hidden={onOpen ? 'true' : undefined}>
        <b className="moment-where num">{m.kind === 'play' ? `Trick ${m.trick}` : <>Your <CallText call={m.call!} /></>}</b>
        {m.kind === 'play' ? <StarGrade stars={m.grade ?? 0} /> : null}
        <MpGain gain={m.mpCost} />
        {onOpen ? <span className="moment-chev">›</span> : null}
      </span>
      <span className="moment-aside" aria-hidden={onOpen ? 'true' : undefined}>
        <GlossaryProse text={aside} />
      </span>
    </>
  );
  // A bid moment is a finding, not a door — its whole reading is already on
  // the row, and the auction never branches, so it stays exactly as before:
  // a plain, non-interactive row.
  if (!onOpen) return <div className="moment-row moment-row-static">{body}</div>;
  // A play moment gets TWO actions, not one: WATCH IT opens the read-only
  // replay at this decision (the row's own accessible name carries the whole
  // reading, unchanged from before), and PLAY FROM HERE branches it live.
  // Two buttons can't nest, so the row is now a wrapper rather than the
  // button itself.
  return (
    <div className="moment-row">
      <button type="button" className="moment-row-open" onClick={onOpen} aria-label={name}>
        {body}
      </button>
      {onRehearse ? (
        <Button variant="secondary" className="moment-row-rehearse" onClick={onRehearse}>
          PLAY FROM HERE →
        </Button>
      ) : null}
      <RehearsalRail rehearsals={rehearsals} onDiscard={onDiscardRehearsal} actualScoreNS={actualScoreNS} />
    </div>
  );
}

/** Did this finished attempt beat the table you actually sat? true = better,
 *  false = worse, null = an exact tie, still in progress, or no real result
 *  to measure against. Deliberately the SAME comparison the field rail's
 *  rehearsal dots make (analyzeRail.ts's `better`) — a rehearsal exists to
 *  answer "better than what actually happened", not "better than par" — so
 *  the two surfaces can never disagree about a line's colour. */
function rehearsalBeatsTable(rh: RehearsalSummary, actualScoreNS: number | null): boolean | null {
  if (rh.state !== 'done' || rh.scoreNS === null || actualScoreNS === null) return null;
  return rh.scoreNS === actualScoreNS ? null : rh.scoreNS > actualScoreNS;
}

/** Past attempts branched from one specific moment — a small ticket-stub
 *  rail, tappable to reopen (resumes if still in progress, per the reload-
 *  survival guarantee; shows its adjusted receipt if done). Renders nothing
 *  when there are none yet — the row's own PLAY FROM HERE button is already
 *  the "start one" affordance, so this never needs an empty-state stub.
 *
 *  A finished stub's score is inked green when the line beat your real table
 *  and red when it fell short — the same colouring, from the same comparison,
 *  the field rail's rehearsal dots already carry. Colour is never the only
 *  carrier of that reading: the stub's accessible name says it in words, so
 *  the verdict survives a screen reader and the colourblind suit palette
 *  alike (--positive/--negative are outside that palette's swap by design). */
function RehearsalRail({
  rehearsals,
  onDiscard,
  actualScoreNS,
}: {
  rehearsals: RehearsalSummary[];
  onDiscard: (rehearsalTournamentId: number) => void;
  actualScoreNS: number | null;
}) {
  if (!rehearsals.length) return null;
  return (
    <div className="rehearsal-rail">
      {rehearsals.map((rh) => {
        const beat = rehearsalBeatsTable(rh, actualScoreNS);
        const done = rh.state === 'done' && rh.scoreNS !== null;
        return (
        // A <button> can't nest inside the <a> react-router's Link renders,
        // so the stub and its discard control are siblings in a small wrap
        // rather than one interactive element holding another.
        <div key={rh.tournamentId} className="rehearsal-stub-wrap">
          <Link
            to={`/t/${rh.tournamentId}/b/${rh.boardNo}`}
            className="rehearsal-stub"
            aria-label={
              done
                ? `Rehearsal, scored ${signedScore(rh.scoreNS!)}${
                    beat === true ? ' — beat your table' : beat === false ? ' — fell short of your table' : ' — tied your table'
                  }`
                : 'Rehearsal in progress'
            }
          >
            <span className="rehearsal-stub-label" aria-hidden="true">
              {rh.state === 'done' ? 'TRIED' : 'IN PROGRESS'}
            </span>
            <b
              className={`rehearsal-stub-score num${beat === true ? ' positive' : beat === false ? ' negative' : ''}`}
              aria-hidden="true"
            >
              {done ? signedScore(rh.scoreNS!) : '···'}
            </b>
          </Link>
          <button
            type="button"
            className="rehearsal-stub-discard"
            aria-label="Discard this rehearsal attempt"
            onClick={() => onDiscard(rh.tournamentId)}
          >
            ✕
          </button>
        </div>
        );
      })}
    </div>
  );
}

/**
 * Every rehearsal attempt on this board, from any moment — the board-wide
 * companion to the per-moment RehearsalRail above: that one says "try again
 * right here," this says "everything I've tried on this board." Newest
 * first (the server's own order), uncapped — nothing here truncates,
 * matching "no cap, just scroll." Renders nothing until at least one attempt
 * exists, the same restraint TOURNEY hints and other empty widgets follow
 * elsewhere in the app.
 */
function YourRehearsals({
  rehearsals,
  onDiscard,
}: {
  rehearsals: RehearsalSummary[];
  onDiscard: (rehearsalTournamentId: number) => void;
}) {
  if (!rehearsals.length) return null;
  return (
    <PerforatedPanel heading="YOUR REHEARSALS" className="analyze-rehearsals">
      {rehearsals.map((rh) => (
        // Same button-can't-nest-in-a constraint as RehearsalRail above.
        <div key={rh.tournamentId} className="rehearsal-ledger-row-wrap">
          <Link to={`/t/${rh.tournamentId}/b/${rh.boardNo}`} className="rehearsal-ledger-row">
            {/* Sentence case, not the tracked caps this app uses for labels:
                these are ledger ENTRIES — a list of things that happened,
                read like the score cell beside them ("1NT by W −1 · +50"),
                which was already mixed case. The panel heading above still
                carries the caps; a row is not a heading. */}
            <span className="rehearsal-ledger-from num">From trick {Math.floor(rh.branchPly / 4) + 1}</span>
            <span className="rehearsal-ledger-score num">
              {rh.state === 'done' && rh.scoreNS !== null ? `${rh.contractLabel ?? ''} · ${signedScore(rh.scoreNS)}` : 'In progress'}
            </span>
            <span className="rehearsal-ledger-chev">›</span>
          </Link>
          <button
            type="button"
            className="rehearsal-ledger-discard"
            aria-label="Discard this rehearsal attempt"
            onClick={() => onDiscard(rh.tournamentId)}
          >
            ✕
          </button>
        </div>
      ))}
    </PerforatedPanel>
  );
}

/**
 * "3D*-EW-1" (a DealerPar contract string, straight from DDS) → the app's own
 * contract-label vocabulary ("3♦X by E–W −1"). Par names a SIDE rather than a
 * seat, so the label says N–S/E–W where contractLabel would say a chair; an
 * unrecognised string passes through untouched rather than being guessed at.
 */
function parContractLabel(raw: string): string {
  // a pass-out par (a dead-flat deal where any contract by either side goes
  // down) carries a non-contract token in this field — give it the app's own
  // label rather than whatever DDS spells "nobody should bid" as
  if (raw.trim() === '' || /^pass/i.test(raw.trim())) return 'Passed out';
  // the declarer group is a SIDE (NS/EW) or, when only one hand can make it,
  // a single SEAT (N/E/S/W) — DDS emits both ("3D*-EW-1", "3N-W+2", "6N-N")
  const m = /^(\d)([SHDCN])(\*{0,2})-(NS|EW|N|E|S|W)([+-]\d+)?$/.exec(raw.trim());
  if (!m) return raw;
  const strain = ({ S: '♠', H: '♥', D: '♦', C: '♣', N: 'NT' } as Record<string, string>)[m[2]];
  const dbl = m[3] === '*' ? 'X' : m[3] === '**' ? 'XX' : '';
  const side = ({ NS: 'N–S', EW: 'E–W' } as Record<string, string>)[m[4]] ?? m[4];
  const n = m[5] ? Number(m[5]) : 0;
  const result = n === 0 ? '=' : n > 0 ? `+${n}` : `−${-n}`;
  return `${m[1]}${strain}${dbl} by ${side} ${result}`;
}

/**
 * ① THE CARDS WERE WORTH — "The Receipt and the Rail" (proposal D from the
 * concept board, owner-chosen): par and your table as PAIRED RECEIPTS — the
 * two numbers that need sentences — over the field as dots on ONE RAIL with
 * par as the dashed gate, the one relationship words state badly. It leads
 * the overview: "was this board winnable, and how did I do against the
 * field" is the framing for the moments ledger below it. The par stub wears
 * the sealed treatment (a receipt for a crossing nobody made); the rail's
 * geometry lives in analyzeRail.ts. (The Result's own YOUR BIDDING table
 * covers the call-by-call recap; the ledger's bid moments carry the
 * counterfactual auctions, so neither is repeated here.)
 */
function CardsWorthPanel({
  board,
  analysis,
  rehearsals,
}: {
  board: BoardView;
  analysis: AnalysisView;
  rehearsals: RehearsalSummary[];
}) {
  const par = analysis.par;
  const r = board.result;
  const field = r?.field ?? [];
  // "Best" = highest scoreNS among finished attempts — unambiguous here
  // specifically because the human is always N-S, so scoreNS is already
  // signed from their own side; no seat-flip logic needed.
  const done = rehearsals.filter((rh) => rh.state === 'done' && rh.scoreNS !== null);
  const best = done.length ? done.reduce((a, b) => (b.scoreNS! > a.scoreNS! ? b : a)) : null;
  return (
    <PerforatedPanel heading="THE CARDS WERE WORTH" className="analyze-par">
      {par && r ? (
        <>
          <div className="worth-stubs">
            <div className="worth-stub sealed">
              <InkStamp rotate={-6} color="var(--muted)" className="worth-stamp">
                PAR
              </InkStamp>
              <span className="worth-stub-label">OMNISCIENCE FOUND</span>
              <b className="worth-contract num">
                <GlossaryProse text={par.parContracts.map(parContractLabel).join(' · ')} />
              </b>
              <b className="worth-score num">{signedScore(par.parScore)}</b>
              <span className="worth-aside">to your side, all hands face up</span>
            </div>
            <div className="worth-stub">
              <span className="worth-stub-label">YOUR TABLE</span>
              <b className="worth-contract num">
                <GlossaryProse text={r.contractLabel} />
              </b>
              <b className="worth-score num">{signedScore(r.scoreNS)}</b>
              <span className="worth-aside">
                {analysis.actualPct !== null
                  ? `${Math.round(analysis.actualPct)}% of the field's matchpoints`
                  : 'the only table so far'}
              </span>
            </div>
            {best ? (
              <div className="worth-stub worth-stub-rehearsal">
                <span className="worth-stub-label">YOUR BEST REHEARSAL</span>
                <b className="worth-contract num">{best.contractLabel ?? '—'}</b>
                <b className="worth-score num">{signedScore(best.scoreNS!)}</b>
                <span className="worth-aside">
                  {rehearsals.length === 1 ? '1 line tried' : `${rehearsals.length} lines tried`} · {signedScore(best.scoreNS! - r.scoreNS)} vs your
                  table
                </span>
              </div>
            ) : null}
          </div>
          {field.length > 1 || done.length > 0 ? <WorthRail field={field} parScore={par.parScore} rehearsals={done} /> : null}
          <p className="analyze-finding">
            <GlossaryProse
              text={
                r.scoreNS > par.parScore
                  ? "Your table did better than perfect bidding allows for either side — nobody bids with the cards face up, so beating par happens about as often as missing it."
                  : 'Nobody bids with the cards face up — par is the yardstick for this board, not a target anyone missed.'
              }
            />
          </p>
        </>
      ) : (
        <p className="analyze-finding">Weighing the cards…</p>
      )}
    </PerforatedPanel>
  );
}

/**
 * The field on one rail, par as the dashed gate, your own rehearsal attempts
 * plotted as small dots on that SAME line, right alongside the real players
 * — geometry from analyzeRail.ts. A dot is green when that line beat your
 * real table and red when it fell short (`--positive`/`--negative`, the
 * app's one bidirectional pair — see AdjustedReceipt's identical framing for
 * a single rehearsal's own delta). Smaller than a field dot and unlabelled
 * (nothing here fights the field dots' alternating up/down contract-label
 * bands) — the caption underneath is what carries the reading, the colour
 * carries the direction. The caption names only the colours actually on
 * screen (and disappears entirely if every attempt tied your table), rather
 * than explaining a red or green dot that isn't there.
 */
function WorthRail({
  field,
  parScore,
  rehearsals,
}: {
  field: NonNullable<BoardView['result']>['field'];
  parScore: number;
  rehearsals: RehearsalSummary[];
}) {
  const layout = railLayout(
    field.map((f) => ({ score: f.scoreNS, contract: f.contract, you: f.isMe })),
    parScore,
    rehearsals.map((rh) => rh.scoreNS!),
  );
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  // The legend names only the colours actually on screen — a board where
  // every rehearsal tied your table has no green or red dot to explain, and
  // one where every attempt landed on the same side of it has no reason to
  // mention the other.
  const hasBetter = layout.rehearsalDots.some((d) => d.better === true);
  const hasWorse = layout.rehearsalDots.some((d) => d.better === false);
  return (
    <>
      <span className="worth-rail-label">
        THE FIELD — {field.length} {field.length === 1 ? 'TABLE' : 'TABLES'}
      </span>
      <div className="worth-rail num">
        <div className="worth-axis" aria-hidden="true" />
        <div className="worth-gate" style={{ left: pct(layout.gate) }} aria-hidden="true" />
        <span className="worth-gatelab" style={{ left: pct(layout.gate) }}>
          PAR
        </span>
        {layout.dots.map((d) => (
          <Fragment key={d.score}>
            <span className={`worth-dot${d.you ? ' you' : ''}`} style={{ left: pct(d.x) }} aria-hidden="true" />
            <span className={`worth-dotlab${d.up ? ' up' : ''}`} style={{ left: pct(d.x) }}>
              {d.you ? <b>YOU </b> : null}
              {signedScore(d.score)}
              <small>
                {d.contracts.length > 1 ? `${d.count} tables` : `${d.contracts[0]}${d.count > 1 ? ` ×${d.count}` : ''}`}
              </small>
            </span>
          </Fragment>
        ))}
        {layout.rehearsalDots.map((d) => (
          <span
            key={`r${d.score}`}
            className={`worth-rehearsal-dot${d.better === true ? ' positive' : d.better === false ? ' negative' : ''}`}
            style={{ left: pct(d.x) }}
            aria-hidden="true"
          />
        ))}
      </div>
      {layout.omittedTables > 0 ? (
        <p className="worth-rail-note">
          {layout.omittedTables} more {layout.omittedTables === 1 ? 'table' : 'tables'} between the results shown.
        </p>
      ) : null}
      {hasBetter || hasWorse ? (
        <p className="worth-rail-note worth-rehearsal-note">
          {rehearsals.length === 1 ? 'Your rehearsal' : `Your ${rehearsals.length} rehearsals`} marked on the rail —{' '}
          {hasBetter ? (
            <>
              <span className="positive">green</span> beat your table
            </>
          ) : null}
          {hasBetter && hasWorse ? ', ' : null}
          {hasWorse ? (
            <>
              <span className="negative">red</span> fell short
            </>
          ) : null}
          .
        </p>
      ) : null}
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
function PlayLens({
  board,
  analysis,
  initialPly,
  initialTrick,
  onRehearse,
}: {
  board: BoardView;
  analysis: AnalysisView;
  initialPly: number | null;
  initialTrick: number;
  onRehearse: (ply: number) => void;
}) {
  const views = useMemo(() => buildReplayViews(board), [board]);
  // The reduced-motion static list has no scrub position to branch from —
  // PLAY FROM HERE stays reachable from the moments ledger either way.
  if (!motionOK()) return <StaticPlayList board={board} analysis={analysis} />;
  return (
    <ReplayLens
      board={board}
      analysis={analysis}
      views={views}
      initialPly={initialPly ?? firstPlyOfTrick(initialTrick)}
      onRehearse={onRehearse}
    />
  );
}

function ReplayLens({
  board,
  analysis,
  views,
  initialPly,
  onRehearse,
}: {
  board: BoardView;
  analysis: AnalysisView;
  views: BoardView[];
  initialPly: number;
  onRehearse: (ply: number) => void;
}) {
  const replay = useReplay();
  // The reader's own "Trump placement" applies here too, so a board reads
  // the way they played it. Statically, with no Draw: this lens is entered
  // on a finished board and scrubbed, so there is never a ♠♥♦♣ frame on
  // screen for the hand to have moved from — and re-sorting on every step
  // would be a motion that says nothing about the play being reviewed.
  const { me } = useMe();
  // Trump-left is the default, so only an explicit 'suit' opts out of it —
  // the same fallback Board.tsx reads the preference through.
  const trump = trumpForDisplay(board.contract, me?.user?.trumpPlacement === 'suit' ? 'suit' : 'left');
  // The reader's own "Foil trumps" applies here too — a review of a board is
  // still a board, and a hand that glitters in play looking plain in Analyze
  // would read as a different deck rather than as a different screen.
  const foil = foilForDisplay(board.contract, me?.user?.foilTrumps);
  const totalPlies = views.length - 1;
  const flat = useMemo(() => board.playHistory?.flat() ?? [], [board]);
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
  // "what should have happened" and "what did". The cut-to view it glides
  // FROM narrates nothing about the decision (see captionFor) — the moment
  // gets one reading, on arrival, rather than one either side of the glide.
  // A non-graded target is a plain cut, same as the pips.
  // Only JUDGED decisions are moments. Stage 3's sampled verdict exists for
  // exactly the plies that cleared the matchpoint floor (or the trick gate in
  // a single field); the sub-floor candidates — a double-dummy trick that
  // moved no matchpoints worth naming — stay in `plies` for the annotations
  // but are not stops on the moment pager and never collapse a landing.
  const momentPlies = useMemo(() => analysis.plies.filter((v) => v.sampled !== null), [analysis]);

  const landAt = (target: number) => {
    const p = Math.max(0, Math.min(target, totalPlies));
    const moment = p < totalPlies ? momentPlies.find((v) => v.ply === p) : undefined;
    if (!moment) {
      setCurMoment(null);
      setPly(p);
      replay.cut(views[p]);
      return;
    }
    setCurMoment(p);
    setPly(p + 1);
    replay.cut(views[p]);
    replay.applyTransition(views[p], momentLandingView(views, flat, p), 1);
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
  // The trick ON THE TABLE at the shown position — from the view's own trick
  // fields rather than shownPly arithmetic, because a held moment landing
  // keeps a completed trick up (completedTricks not yet advanced) and the
  // ribbon must name the trick being looked at, not the one after it.
  const trick = Math.min(Math.ceil(totalPlies / 4), (shown.completedTricks ?? 0) + 1);

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
  // The fan shows the hand the human PLAYED (playingSeat — North on a
  // flipped board), so the centre rail shows the seat opposite it. Audit
  // finding: this used to be hardcoded to North with a `dummy !== 0` guard,
  // which dropped dummy North entirely on South-declared boards and, on
  // flipped boards, drew North twice (rail + fan) while dummy South appeared
  // nowhere. Every hand renders exactly once: across rail, W/E rails, fan.
  const playingSeat = board.playingSeat ?? (board.flipped ? 0 : 2);
  const across = (playingSeat + 2) % 4;
  const acrossName = ['NORTH', 'EAST', 'SOUTH', 'WEST'][across];
  const acrossOpen = remainingAt(board, shownPly, across);
  // The engine's card, highlighted where it still sits — the same pre-
  // confirmation `.selected` treatment a live tap uses, so "the card that
  // should have been played" reads in the vocabulary the player already
  // knows. It appears WITH the played card (never before it — the caption
  // that used to light it a beat early is gone) and clears when the replay
  // steps on.
  const highlight = caption.highlight;
  const fanHighlight = highlight !== null && view.hand.includes(highlight) ? highlight : null;
  // Same idea, for the across hand once it renders as a card fan too — the
  // engine's pick marked with the fan's own `.selected` treatment rather
  // than the text rails' `.analyze-hl` bold-underline.
  const acrossHighlight = highlight !== null && acrossOpen.includes(highlight) ? highlight : null;

  // The Compass Fill: each pip is four wedges, one per absolute seat
  // (0=N,1=E,2=S,3=W — never flip-adjusted, same as the WEST/EAST rails
  // above). An ordinary wedge inks only once that seat's card is revealed
  // at the current scrub position — but a MOMENT wedge is lit from the
  // very first render, however far ahead its trick is, and stays lit
  // regardless of where the reader has scrubbed to. This is deliberate,
  // not a spoiler: the board is already finished and scored, and the
  // Overview lens's WHERE IT TURNED ledger already lists every moment
  // up front — the pip strip giving the same "how many, and where in the
  // 13 tricks" view at a glance is consistent with that, not a new leak.
  // Only THAT wedge turns verdigris, never the whole pip, so the compass
  // stays legible. Per-wedge rather than per-pip on purpose: when N-S
  // declares, the human is graded on both declarer's and dummy's plays,
  // so a single trick can carry two moment wedges.
  const wedgeColor = (t: number, seat: number): string => {
    const p = plyOfSeatInTrick(flat, t, seat);
    if (p === null) return 'var(--panel)';
    if (momentPlies.some((v) => v.ply === p)) return 'var(--positive)';
    return p < shownPly ? 'var(--ink)' : 'var(--panel)';
  };

  return (
    <>
      <div className="audit-ribbon" role="status">
        <div className="audit-ribbon-head">
          <span className="label-caps audit-ribbon-who">
            THE AUDIT — TRICK {trick} OF {Math.ceil(totalPlies / 4)}
          </span>
          {caption.gain !== null ? <span className="audit-ribbon-gain num">+{Math.round(caption.gain)} MP</span> : null}
        </div>
        <p>
          {/* `dummy` is skipped here in the linkify.ts sense of "a term the
              matcher reads in the wrong sense for this copy": the ribbon says
              "double dummy" (the perfect-information yardstick) and never
              "dummy" (declarer's exposed partner), so the sheet that opened
              from it explained the wrong thing. Dropping the link also stops
              the punctuation after it orphaning onto the next line — a
              .gloss-link is a <button>, which Blink lays out as an atomic
              inline whatever its `display`, so "(+1 double dummy" / ")" was a
              live break opportunity. */}
          <GlossaryProse text={caption.text} skip={['dummy']} />
        </p>
      </div>

      <div className="analyze-rail played num">
        <span className="analyze-rail-label">PLAYED</span>
        {shownPly > 0 ? (
          <SuitLine cards={playedAt(board, shownPly)} />
        ) : (
          <span className="analyze-suitline analyze-suitline-empty">—</span>
        )}
      </div>
      <div className="analyze-rails num">
        <div className="analyze-rail side">
          <span className="analyze-rail-label">WEST</span>
          <SuitLine cards={remainingAt(board, shownPly, 3)} highlight={highlight} trump={trump} />
        </div>
        <div className="analyze-rail side right">
          <span className="analyze-rail-label">EAST</span>
          <SuitLine cards={remainingAt(board, shownPly, 1)} highlight={highlight} trump={trump} />
        </div>
      </div>
      {/* the across hand, as a real card fan directly above the trick box —
          the same adjacency and the same HandFan/PlayingCard components live
          play uses for a North/South dummy or defending partner. No visible
          label (screen space is tight with a full card fan up here already;
          WEST/EAST/PLAYED above already establish which seat is which) — the
          seat and role still reach assistive tech via aria-label. */}
      <div className="analyze-rail north" aria-label={`${acrossName}${dummy === across ? ' · DUMMY' : ''}`}>
        <div className="board-fan">
          <HandFan cards={acrossOpen} selected={acrossHighlight} trump={trump} foil={foil} />
        </div>
      </div>
      <TrickArea board={view} foil={foil} />
      <div className="board-fan">
        <HandFan cards={view.hand} selected={fanHighlight} trump={trump} foil={foil} />
      </div>

      <div className="replay-dock">
        <div className="replay-pips" role="group" aria-label="Jump to a trick">
          {Array.from({ length: Math.ceil(totalPlies / 4) }, (_, i) => {
            const t = i + 1;
            const cur = trick === t;
            const inTail = analysis.claimedAtPly !== null && firstPlyOfTrick(t) >= analysis.claimedAtPly;
            const pipStyle = {
              '--pip-n': wedgeColor(t, 0),
              '--pip-e': wedgeColor(t, 1),
              '--pip-s': wedgeColor(t, 2),
              '--pip-w': wedgeColor(t, 3),
            } as CSSProperties;
            return (
              <button
                key={t}
                type="button"
                className={`replay-pip${cur ? ' cur' : ''}${inTail ? ' tail' : ''}`}
                style={pipStyle}
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
          <Button variant="secondary" onClick={next} disabled={ply >= totalPlies}>
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
        {/* Standing action, usable at whatever ply the reader has scrubbed
            to — not only the flagged moments above. Branches at `anchor`,
            not raw `ply`: a moment landing leaves `ply` one card PAST the
            decision (the played card is already animated into the trick —
            see the anchor comment above), so redeciding at `ply` would lock
            in exactly the card the moment flagged instead of offering it up.
            This is the same anchor PREV/NEXT MOMENT already use, and it's
            what keeps this button agreeing with the moment row's own
            PLAY FROM HERE (which always uses the true m.ply). Disabled past
            the claim boundary too: from there the server already played
            both sides, true-DD, so there is nothing left to redecide
            (createRehearsal rejects this server-side regardless — this is a
            UX courtesy, not the only guard). */}
        <div className="replay-dock-row replay-dock-rehearse">
          <Button
            onClick={() => onRehearse(anchor)}
            disabled={anchor >= totalPlies || (analysis.claimedAtPly !== null && anchor >= analysis.claimedAtPly)}
          >
            PLAY FROM HERE →
          </Button>
        </div>
      </div>
    </>
  );
}

/**
 * The view a collapsed moment landing stages to. When the moment's card
 * COMPLETES a trick, the ordinary next view has already collected it — all
 * four cards would sweep off the table the instant the played card landed,
 * taking the moment with them (audit finding, reported from the preview). So
 * the landing HOLDS the finished trick on the table: hands and counts from
 * the post-play view, trick fields from before the collect. shownPly
 * arithmetic is unaffected (completedTricks·4 + a full trick's 4 = the same
 * ply), and stepping on simply cuts past the collect — the take-up animation
 * is skipped, not deferred.
 */
function momentLandingView(views: BoardView[], flat: TrickCard[], p: number): BoardView {
  const next = views[p + 1];
  if ((p + 1) % 4 !== 0) return next;
  const prev = views[p];
  return {
    ...next,
    currentTrick: [...(prev.currentTrick ?? []), flat[p]],
    completedTricks: prev.completedTricks,
    declarerTricks: prev.declarerTricks,
    defenderTricks: prev.defenderTricks,
    lastTrick: prev.lastTrick,
  };
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
function SuitLine({
  cards,
  highlight = null,
  trump = null,
}: {
  cards: number[];
  highlight?: number | null;
  /** suit to list first ("Trump placement"), so the rails agree with the fans beside them */
  trump?: number | null;
}) {
  const bySuit: number[][] = [[], [], [], []];
  for (const c of cards) bySuit[cardSuit(c)].push(c);
  return (
    <span className="analyze-suitline">
      {suitDisplayOrder(trump).map((s) =>
        bySuit[s].length ? (
          <span key={s} className="analyze-suitgroup">
            <span className={suitClass(s)}>{SUIT_SYMBOLS[s]}</span>
            {bySuit[s].map((c) => (
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
  /** the engine's card, to highlight in whichever hand still holds it */
  highlight: number | null;
}

/**
 * The ribbon's reading for the position after `ply` cards — always a reading
 * of the card just PLAYED, never of the decision about to be made. A graded
 * decision therefore gets exactly ONE beat: the card lands in the trick and
 * the engine's pick lights up in the hand at the same instant.
 *
 * It used to get two. The pending beat ("The turn is here: South to play, and
 * the engine, from your seat, plays 5♣") was the original moment landing —
 * the reader was put back in the chair with the choice still open, and
 * NEXT CARD showed what actually happened. The round-three collapse then
 * staged the played card's glide immediately, which is what a moment jump
 * still does, but the pending caption stayed: the same finding was narrated
 * once before the card and once after, with the engine's pick highlighted
 * through both, so a moment jump flashed reading one and walking the play
 * with NEXT/BACK spent two presses on one finding. Two captions for one
 * decision is a stutter, not a build-up — the interesting comparison is the
 * played card and the engine's card side by side, which only the second beat
 * shows. So the position before a graded decision now reads exactly like any
 * other position: the card that just landed, and nothing about the one
 * coming.
 *
 * `analysis.plies` never carries an excused candidate — the server drops
 * those before this ever sees them (see server/src/analyze.ts) — so every
 * `sampled` verdict reached below is a genuine, chargeable fault.
 */
function captionFor(analysis: AnalysisView, board: BoardView, ply: number): RibbonCaption {
  const flat = board.playHistory?.flat() ?? [];
  const seatNames = ['North', 'East', 'South', 'West'];

  if (ply === 0) {
    // a laydown claimed before the first decision has no moments to promise —
    // the whole play is server-fast-played tail, and the intro says so
    if (analysis.claimedAtPly === 0) {
      return {
        text: 'Settled before the first card — the engine could already claim every remaining trick, so the whole play was fast-played for both sides. Nothing here was yours to decide.',
        gain: null,
        highlight: null,
      };
    }
    const leader = flat[0] ? SEAT_SHORT[flat[0].seat] : '';
    return {
      text: `The opening lead is ${leader}'s. Step through the play — the audit marks the moments worth more.`,
      gain: null,
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
      highlight: null,
    };
  }
  const verdict = analysis.plies.find((p) => p.ply === j);
  const mark = ddMark(analysis, j);
  const seatName = seatNames[played.seat];
  if (verdict?.sampled) {
    // the pct pair the pending caption used to carry, folded into the one
    // beat that outlived it: the play lens is reachable by deep link (?ply=)
    // and by the pager, so the overview ledger's own aside — the only other
    // place this reading exists — can't be assumed to have been read
    const pct =
      verdict.cfPct !== null && analysis.actualPct !== null
        ? ` — worth ${Math.round(verdict.cfPct)}% instead of ${Math.round(analysis.actualPct)}%`
        : '';
    return {
      text: `${seatName} played ${cardLabel(played.card)} — the moment turned here (${mark ?? ''} double dummy). The engine, from your seat, plays ${cardLabel(verdict.sampled.bestCard)}${pct}.`,
      gain: verdict.mpCost,
      // the engine's pick marked in the hand while the played card sits in
      // the trick — the two cards side by side ARE the finding, and this is
      // the only beat that shows them
      highlight: verdict.sampled.bestCard,
    };
  }
  if (verdict) {
    // A stage-1 candidate the audit left unjudged: a double-dummy trick
    // slipped, but the matchpoints barely noticed — nothing is charged and
    // there is no engine pick to show. The mpCost here is measured against
    // TODAY'S field (the serve-time refresh), while the floor selection ran
    // against the field at first open — so a shifted field can push an
    // unjudged cost over the floor, and that drift is captioned honestly.
    const n = verdict.mpCost === null ? 0 : Math.round(verdict.mpCost);
    const moved =
      n <= 0
        ? `no matchpoints moved: the field scores this board the same either way`
        : n < analysis.momentFloor
          ? `only ${n} matchpoints moved — under the audit's floor, so it goes unjudged`
          : `${n} matchpoints now ride on it — the field has shifted since the audit ran, and this card sat under its floor then`;
    return {
      text: `${seatName} played ${cardLabel(played.card)} — a double-dummy trick slipped here, but ${moved}.`,
      gain: null,
      highlight: null,
    };
  }
  // Reaching here means there is no analysis entry for this card at all — a
  // robot's play, a forced card, or (per the stage-3 doc comment above) a
  // human decision that DID cost a double-dummy trick but was excused for
  // it. Whatever raw DD swing shows is therefore always uncharged, not just
  // on defence — an unlabelled "(−1 double dummy)" on the human's own
  // declaring seat would read as an unexplained accusation.
  const markNote = mark && mark !== '=' ? ` (${mark} double dummy — uncharged)` : '';
  return { text: `${seatName} played ${cardLabel(played.card)}${markNote}.`, gain: null, highlight: null };
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
                <StarGrade stars={verdict!.sampled!.grade} />
                {verdict!.mpCost !== null ? <MpGain gain={verdict!.mpCost} /> : null}
                <span className="moment-aside">
                  <GlossaryProse text={`The engine, from your seat, plays ${cardLabel(verdict!.sampled!.bestCard)}.`} />
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
