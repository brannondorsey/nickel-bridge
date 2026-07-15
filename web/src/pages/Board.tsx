import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AuctionEntry,
  BidEval,
  BoardView,
  RANK_CHARS,
  SEAT_SHORT,
  SUIT_SYMBOLS,
  api,
  cardRank,
  cardSuit,
  displaySort,
  suitClass,
} from '../api';
import { Button } from '../components/ds/Button';
import { Chip } from '../components/ds/Chip';
import { FlipDigits } from '../components/ds/FlipDigits';
import { HcpBadge } from '../components/ds/HcpBadge';
import { InkStamp } from '../components/ds/InkStamp';
import { Loading } from '../components/ds/Loading';
import { PctBar } from '../components/ds/PctBar';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { StarGrade } from '../components/ds/StarGrade';
import { TicketStub } from '../components/ds/TicketStub';
import { Toast } from '../components/ds/Toast';
import { AuctionGrid } from '../components/game/AuctionGrid';
import { BidBox } from '../components/game/BidBox';
import { CallInspector } from '../components/game/CallInspector';
import { CallText } from '../components/game/CallText';
import { ContractLabel } from '../components/game/ContractLabel';
import { DealDiagram } from '../components/game/DealDiagram';
import { DummyRail } from '../components/game/DummyRail';
import { GRADE_STARS, GRADE_TEXT, GradeToast } from '../components/game/GradeToast';
import { HandFan } from '../components/game/HandFan';
import { MeaningPanel } from '../components/game/MeaningPanel';
import { SuitText } from '../components/game/SuitText';
import {
  AUTO_PLAY_DELAY_MS,
  CLAIM_ANNOUNCE_MS,
  CLAIM_STAMP_HOLD_MS,
  ClaimAnnouncement,
  capturePlayOrigin,
  claimAnnouncement,
  motionOK,
  stageClaimSteps,
  stagePlaySteps,
} from '../components/game/playAnim';
import { ScoreReceipt } from '../components/game/ScoreReceipt';
import { TrickArea } from '../components/game/TrickArea';
import { signedScore, vulLabel } from '../format';

const SEAT_NAMES = ['NORTH', 'EAST', 'SOUTH', 'WEST'];
const SUIT_PLURALS = ['spades', 'hearts', 'diamonds', 'clubs'];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The board screen — bidding, card play, and the scored result, one route. */
export default function Board() {
  const { tid, no } = useParams();
  const navigate = useNavigate();
  const tournamentId = Number(tid);
  const boardNo = Number(no);

  const [board, setBoard] = useState<BoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCall, setSelectedCall] = useState<number | null>(null);
  const [selectedCard, setSelectedCard] = useState<number | null>(null);
  const [lastEval, setLastEval] = useState<BidEval | null>(null);
  const [inspect, setInspect] = useState<AuctionEntry | null>(null);
  const [busy, setBusy] = useState(false);

  // A claim's announce → fast-forward → stamp sequence, driven by runClaim
  // below. claimGenRef guards it the same way stagingRef guards applyBoard's
  // per-card timers: bumping it invalidates any claim sequence in flight.
  const [claimPhase, setClaimPhase] = useState<'announce' | 'playing' | 'stamp' | null>(null);
  const [claimInfo, setClaimInfo] = useState<ClaimAnnouncement | null>(null);
  const claimGenRef = useRef(0);

  // The toll receipt auto-shows only when the board completes live in this
  // visit (sawLive flips as soon as we render a bidding/playing state);
  // revisiting an already-scored board goes straight to the field view, with
  // a "view the toll receipt" affordance to reopen it.
  const [showReceipt, setShowReceipt] = useState(false);
  const sawLiveRef = useRef(false);
  const boardState = board?.state;
  useEffect(() => {
    if (!boardState) return;
    if (boardState !== 'done') {
      sawLiveRef.current = true;
    } else if (sawLiveRef.current) {
      sawLiveRef.current = false;
      setShowReceipt(true);
    }
  }, [boardState]);

  // Staged application of server responses: one card at a time on timers so
  // TrickArea can animate each play (see playAnim.ts). Bumping `gen`
  // invalidates any staging still in flight.
  const stagingRef = useRef({ gen: 0, timers: [] as number[] });
  const cancelStaging = useCallback(() => {
    stagingRef.current.gen++;
    stagingRef.current.timers.forEach(clearTimeout);
    stagingRef.current.timers = [];
  }, []);
  useEffect(() => cancelStaging, [cancelStaging]);

  const applyBoard = useCallback(
    (prev: BoardView | null, next: BoardView) => {
      cancelStaging();
      const steps = prev && motionOK() ? (next.claimed ? stageClaimSteps(prev, next) : stagePlaySteps(prev, next)) : [];
      if (!steps.length) {
        setBoard(next);
        return;
      }
      const gen = stagingRef.current.gen;
      let at = 0;
      for (const step of steps) {
        at += step.delayBefore;
        if (at === 0) {
          setBoard(step.view);
          continue;
        }
        const id = window.setTimeout(() => {
          if (stagingRef.current.gen === gen) setBoard(step.view);
        }, at);
        stagingRef.current.timers.push(id);
      }
    },
    [cancelStaging],
  );

  // Bracket a claim's fast-forward (applyBoard, above) with the announcement
  // banner and terminal stamp — see stageClaimSteps' docstring for why the
  // hand-off to the real (state: 'done') `next` view happens here, after the
  // stamp, rather than as the last staged step.
  const runClaim = useCallback(
    async (prev: BoardView, next: BoardView) => {
      const info = claimAnnouncement(prev, next);
      if (!info) {
        applyBoard(prev, next); // data didn't line up — fall back to a plain (unanimated) jump
        return;
      }
      const gen = ++claimGenRef.current;
      setClaimInfo(info);
      setClaimPhase('announce');
      await sleep(CLAIM_ANNOUNCE_MS);
      if (claimGenRef.current !== gen) return;

      setClaimPhase('playing');
      applyBoard(prev, next);
      const totalMs = motionOK() ? stageClaimSteps(prev, next).reduce((sum, step) => sum + step.delayBefore, 0) : 0;
      await sleep(totalMs);
      if (claimGenRef.current !== gen) return;

      setClaimPhase('stamp');
      await sleep(CLAIM_STAMP_HOLD_MS);
      if (claimGenRef.current !== gen) return;

      setClaimPhase(null);
      setClaimInfo(null);
      setBoard(next);
    },
    [applyBoard],
  );

  const load = useCallback(() => {
    cancelStaging();
    claimGenRef.current++;
    setBoard(null);
    setSelectedCall(null);
    setSelectedCard(null);
    setLastEval(null);
    setInspect(null);
    setError(null);
    setShowReceipt(false);
    setClaimPhase(null);
    setClaimInfo(null);
    sawLiveRef.current = false;
    api
      .board(tournamentId, boardNo)
      .then(setBoard)
      .catch((e) => setError(e.message));
  }, [tournamentId, boardNo, cancelStaging]);
  useEffect(load, [load]);

  const submitCall = async (call: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const { evaluation, board: next } = await api.call(tournamentId, boardNo, call);
      setLastEval(evaluation);
      setSelectedCall(null);
      setInspect(null);
      applyBoard(board, next); // stages the opening lead if the auction just ended
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitCard = async (card: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const { board: next } = await api.playCard(tournamentId, boardNo, card);
      setSelectedCard(null);
      setLastEval(null);
      if (next.claimed && board) {
        await runClaim(board, next);
      } else {
        applyBoard(board, next); // plays out card-by-card, then unlocks input
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // A forced move (exactly one legal card) plays itself after a short delay,
  // so the human can see it happen without needing to tap it — this simulates
  // the same "second tap" a manual play would trigger, so it reuses the whole
  // submitCard/applyBoard pipeline unchanged. Cancelled by the effect cleanup
  // whenever board/selectedCard/busy change — a manual tap, a fresher server
  // response (including intermediate staged snapshots, which always set
  // legalCards: undefined), or unmount all naturally invalidate the timer.
  useEffect(() => {
    if (!board || board.state !== 'playing' || !board.myTurn || busy) return;
    const legal = board.legalCards;
    if (!legal || legal.length !== 1 || selectedCard !== null) return;
    const card = legal[0];
    const id = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-card="${card}"]`);
      if (el) capturePlayOrigin(card, el.getBoundingClientRect());
      submitCard(card);
    }, AUTO_PLAY_DELAY_MS);
    return () => clearTimeout(id);
  }, [board, selectedCard, busy]);

  if (error) {
    return (
      <div className="board-page">
        <div className="notice-error">{error}</div>
        <div className="board-actions">
          <Button variant="secondary" to="/">
            Back to lobby
          </Button>
        </div>
      </div>
    );
  }
  if (!board) {
    return (
      <div className="board-page">
        <Loading />
      </div>
    );
  }

  return (
    <div className="board-page">
      <BoardHead board={board} />
      {board.state === 'done' ? (
        showReceipt ? (
          <ScoreReceipt board={board} onContinue={() => setShowReceipt(false)} />
        ) : (
          <Result
            board={board}
            onReceipt={() => setShowReceipt(true)}
            onNext={() =>
              boardNo < board.totalBoards
                ? navigate(`/t/${tournamentId}/b/${boardNo + 1}`)
                : navigate(`/t/${tournamentId}`)
            }
          />
        )
      ) : board.state === 'playing' ? (
        <PlayPhase
          board={board}
          lastEval={lastEval}
          selectedCard={selectedCard}
          onSelectCard={(c) => (selectedCard === c ? submitCard(c) : setSelectedCard(c))}
          inspect={inspect}
          onInspect={(e) => setInspect(e === inspect ? null : e)}
          claimPhase={claimPhase}
          claimInfo={claimInfo}
        />
      ) : (
        <BiddingPhase
          board={board}
          lastEval={lastEval}
          selectedCall={selectedCall}
          onSelectCall={(c) => setSelectedCall(selectedCall === c ? null : c)}
          onConfirm={() => selectedCall !== null && submitCall(selectedCall)}
          busy={busy}
          inspect={inspect}
          onInspect={(e) => setInspect(e === inspect ? null : e)}
        />
      )}
      {inspect ? <CallInspector entry={inspect} onClose={() => setInspect(null)} /> : null}
    </div>
  );
}

/** Compact ticket header: mini stub, tournament context, vul chip (or SCORED stamp). */
function BoardHead({ board }: { board: BoardView }) {
  const vul = vulLabel(board.vul).toUpperCase();
  return (
    <div className="board-head">
      <TicketStub label="BOARD" value={`${board.boardNo} of ${board.totalBoards}`} edgeText="ADMIT" width={92} />
      <div className="board-head-mid">
        <div className="board-head-name">{board.tournamentName}</div>
        <div className="board-head-sub num">
          Dealer {SEAT_SHORT[board.dealer]}
          {board.state === 'playing' && board.contractLabel ? (
            <>
              {' · '}
              <b>
                <ContractLabel label={board.contractLabel} />
              </b>
            </>
          ) : null}
        </div>
      </div>
      {board.state === 'done' ? (
        <InkStamp rotate={-4}>SCORED</InkStamp>
      ) : (
        <Chip color={board.vul.ns ? 'var(--suit-h)' : undefined} quiet={!board.vul.ns && !board.vul.ew} className="board-vul">
          {vul}
        </Chip>
      )}
    </div>
  );
}

function SeatLine({ label, hcp, active = false }: { label: string; hcp?: number; active?: boolean }) {
  return (
    <div className={`seat-line${active ? ' seat-line-active' : ''}`}>
      <span className="seat-line-label">{label}</span>
      {typeof hcp === 'number' ? <HcpBadge hcp={hcp} /> : null}
    </div>
  );
}

function BiddingPhase({
  board,
  lastEval,
  selectedCall,
  onSelectCall,
  onConfirm,
  busy,
  inspect,
  onInspect,
}: {
  board: BoardView;
  lastEval: BidEval | null;
  selectedCall: number | null;
  onSelectCall: (call: number) => void;
  onConfirm: () => void;
  busy: boolean;
  inspect: AuctionEntry | null;
  onInspect: (entry: AuctionEntry) => void;
}) {
  const meanings = board.legalCallMeanings ?? {};
  return (
    <>
      <AuctionGrid auction={board.auction} dealer={board.dealer} myTurn={Boolean(board.myTurn)} onInspect={onInspect} />
      {lastEval ? <GradeToast evaluation={lastEval} /> : null}
      {board.myTurn ? (
        selectedCall !== null ? (
          <MeaningPanel meaning={meanings[selectedCall]} call={selectedCall} prefix="Your" />
        ) : (
          <MeaningPanel placeholder />
        )
      ) : null}
      <div className="board-fan">
        <HandFan cards={displaySort(board.hand)} />
      </div>
      <SeatLine label="SOUTH — YOU" hcp={board.hcp} />
      {board.myTurn ? (
        <BidBox
          legalCalls={board.legalCalls ?? []}
          selected={selectedCall}
          onSelect={onSelectCall}
          onConfirm={onConfirm}
          busy={busy}
        />
      ) : (
        <div className="notice">Robots are thinking…</div>
      )}
    </>
  );
}

function PlayPhase({
  board,
  lastEval,
  selectedCard,
  onSelectCard,
  inspect,
  onInspect,
  claimPhase,
  claimInfo,
}: {
  board: BoardView;
  lastEval: BidEval | null;
  selectedCard: number | null;
  onSelectCard: (card: number) => void;
  inspect: AuctionEntry | null;
  onInspect: (entry: AuctionEntry) => void;
  claimPhase: 'announce' | 'playing' | 'stamp' | null;
  claimInfo: ClaimAnnouncement | null;
}) {
  // Bottom fan = the hand the human plays from (South, or North when the
  // board is flipped). Top fan = dummy. Either can be the hand to play.
  const playingSeat = board.playingSeat ?? 2;
  const canPlayFrom = (seat: number | undefined) => Boolean(board.myTurn) && board.handToPlay === seat;

  const humanDeclares = board.declarer === playingSeat;
  const dummyLabel = [
    board.dummy !== undefined ? SEAT_NAMES[board.dummy] : '',
    board.dummy === 2 ? 'YOUR HAND, DUMMY' : humanDeclares ? 'DUMMY · YOURS' : 'DUMMY',
    canPlayFrom(board.dummy) ? 'YOUR TURN' : '',
  ]
    .filter(Boolean)
    .join(' — ');
  const bottomLabel = [
    board.flipped ? `${SEAT_NAMES[0]} — YOU, FOR PARTNER` : `${SEAT_NAMES[2]} — YOU`,
    canPlayFrom(playingSeat) ? 'YOUR TURN' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  // follow-suit helper: the led suit constrains this turn's legal cards
  const led = board.currentTrick?.length ? cardSuit(board.currentTrick[0].card) : null;
  const activeHand = board.handToPlay === board.dummy ? board.dummyHand : board.hand;
  const mustFollow =
    Boolean(board.myTurn) &&
    led !== null &&
    activeHand !== undefined &&
    (board.legalCards?.length ?? 0) < activeHand.length;

  // Dummy on East or West is always the opposing side's exposed hand — never
  // one the human plays — so it renders as a rail on its true compass side
  // (TrickArea.tsx already puts West at screen-left, East at screen-right)
  // instead of the full-width fan a partner's dummy gets at the top.
  const dummyOnSide = board.dummy === 1 || board.dummy === 3;

  // A forced move highlights like a manual selection, for the whole delay
  // Board.tsx's auto-play timer waits out before playing it.
  const soleLegal = board.myTurn && board.legalCards?.length === 1 ? board.legalCards[0] : null;

  return (
    <>
      <AuctionGrid auction={board.auction} dealer={board.dealer} myTurn={false} onInspect={onInspect} />
      {/* keep the last bid's grade visible when the auction ends on the human's
          own call — it clears as soon as they play a card */}
      {lastEval ? <GradeToast evaluation={lastEval} /> : null}
      {board.flipped ? (
        <Toast className="flip-note">
          Partner won the auction — board flipped. You're declaring from <b>North</b>; your South hand is dummy.
        </Toast>
      ) : null}
      {claimPhase === 'announce' && claimInfo ? (
        <div className="claim-banner">
          <div className="claim-banner-side">
            {claimInfo.side === 'NS' ? 'N/S' : 'E/W'} CLAIM {claimInfo.tricks} REMAINING{' '}
            {claimInfo.tricks === 1 ? 'TRICK' : 'TRICKS'}
          </div>
          <div className="claim-banner-sub">Laydown confirmed — the rest plays itself…</div>
        </div>
      ) : null}
      {board.dummyHand && !dummyOnSide ? (
        <>
          <SeatLine label={dummyLabel} hcp={board.dummyHcp} active={canPlayFrom(board.dummy)} />
          <div className="board-fan">
            <HandFan
              cards={displaySort(board.dummyHand)}
              legal={canPlayFrom(board.dummy) ? board.legalCards : []}
              selected={selectedCard ?? soleLegal}
              onSelect={canPlayFrom(board.dummy) ? onSelectCard : undefined}
            />
          </div>
        </>
      ) : null}
      {mustFollow && led !== null ? (
        <div className="board-follow">{SUIT_PLURALS[led]} are live — you must follow suit</div>
      ) : null}
      <div className="claim-stamp-anchor">
        {board.dummyHand && dummyOnSide ? (
          <div className="play-row">
            {board.dummy === 3 ? (
              <DummyRail seat={board.dummy} cards={board.dummyHand} hcp={board.dummyHcp} side="left" />
            ) : null}
            <TrickArea board={board} />
            {board.dummy === 1 ? (
              <DummyRail seat={board.dummy} cards={board.dummyHand} hcp={board.dummyHcp} side="right" />
            ) : null}
          </div>
        ) : (
          <TrickArea board={board} />
        )}
        {claimPhase === 'stamp' ? (
          <div className="claim-stamp-wrap">
            <InkStamp className="claim-stamp" rotate={-6}>
              TOLLS CLAIMED
            </InkStamp>
          </div>
        ) : null}
      </div>
      <div className="board-fan">
        <HandFan
          cards={displaySort(board.hand)}
          legal={canPlayFrom(playingSeat) ? board.legalCards : []}
          selected={selectedCard ?? soleLegal}
          onSelect={canPlayFrom(playingSeat) ? onSelectCard : undefined}
        />
      </div>
      <SeatLine label={bottomLabel} hcp={board.hcp} active={canPlayFrom(playingSeat)} />
      {selectedCard !== null ? (
        <div className="board-hint num">
          {RANK_CHARS[cardRank(selectedCard)]}
          <span className={suitClass(cardSuit(selectedCard))}>{SUIT_SYMBOLS[cardSuit(selectedCard)]}</span> selected — tap again to
          play
        </div>
      ) : soleLegal !== null ? (
        <div className="board-hint num">
          Only {RANK_CHARS[cardRank(soleLegal)]}
          {SUIT_SYMBOLS[cardSuit(soleLegal)]} to play — playing automatically…
        </div>
      ) : claimPhase === 'playing' || claimPhase === 'stamp' ? (
        <div className="board-hint">Laydown confirmed — the rest plays itself…</div>
      ) : board.myTurn ? (
        <div className="board-hint">
          your turn{board.handToPlay === board.dummy ? ' — playing from dummy' : ''}
        </div>
      ) : (
        <div className="board-hint">Robots are thinking…</div>
      )}
    </>
  );
}

function Result({ board, onNext, onReceipt }: { board: BoardView; onNext: () => void; onReceipt: () => void }) {
  const r = board.result!;
  const low = r.pct < 40;
  const others = Math.max(0, r.field.length - 1);
  return (
    <div className="result">
      <div className="result-hero">
        <div className="result-contract">
          <ContractLabel label={r.contractLabel} />
        </div>
        <div className="result-score num">
          {signedScore(r.scoreNS)} for N–S · {vulLabel(board.vul)}
        </div>
        <div className={`pct-big${low ? ' low' : ''}`}>
          <FlipDigits value={r.pct} suffix="%" size={54} />
        </div>
        <div className="label-caps result-sub num">
          MATCHPOINTS · VS {others} OTHER {others === 1 ? 'PLAYER' : 'PLAYERS'}
          {r.bidAccuracy != null ? ` · BIDDING ${r.bidAccuracy}%` : ''}
        </div>
        <button type="button" className="label-caps receipt-link" onClick={onReceipt}>
          VIEW THE TOLL RECEIPT
        </button>
      </div>

      <PerforatedPanel heading={`THE FIELD — BOARD ${board.boardNo}`} className="result-field">
        <table className="fieldtable num">
          <tbody>
            {r.field.map((f) => (
              <tr key={f.userId} className={f.isMe ? 'me' : ''}>
                <td className="fieldtable-name">{f.isMe ? 'You' : f.handle}</td>
                <td className="fieldtable-contract">
                  <ContractLabel label={f.contract} /> · {signedScore(f.scoreNS)}
                </td>
                <td className="fieldtable-pct">
                  <PctBar pct={f.pct} width={56} /> <b>{f.pct}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PerforatedPanel>

      {board.allHands ? (
        <DealDiagram
          hands={board.allHands}
          dealer={board.dealer}
          vul={board.vul}
          playedSeat={board.flipped ? 0 : 2}
          dummy={board.dummy}
        />
      ) : null}

      {board.bidEvals.length ? (
        <div className="result-bidding">
          <div className="label-caps result-bidding-head">YOUR BIDDING</div>
          {board.bidEvals.map((e, i) => (
            <div className="result-bid-row" key={i}>
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
                    {e.bestMeaning?.exact ? (
                      <>
                        {' ('}
                        <SuitText text={e.bestMeaning.title} />)
                      </>
                    ) : null}
                  </>
                ) : (
                  <> — the robot's choice too</>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="board-actions">
        <Button onClick={onNext}>
          {board.boardNo < board.totalBoards
            ? `NEXT BOARD — ${board.boardNo + 1} OF ${board.totalBoards} →`
            : 'TOURNAMENT SUMMARY →'}
        </Button>
        <Button variant="secondary" to="/">
          Back to lobby
        </Button>
      </div>
    </div>
  );
}
