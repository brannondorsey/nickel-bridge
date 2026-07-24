import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMe } from '../App';
import { AuctionEntry, BidEval, BoardView, SEAT_SHORT, api } from '../api';
import riverSceneNight from '../assets/bridge-river-scene-night.svg';
import riverScene from '../assets/bridge-river-scene.svg';
import { Button } from '../components/ds/Button';
import { Chip } from '../components/ds/Chip';
import { FlipDigits } from '../components/ds/FlipDigits';
import { InkStamp } from '../components/ds/InkStamp';
import { Loading } from '../components/ds/Loading';
import { PctBar } from '../components/ds/PctBar';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { Postmark } from '../components/ds/Postmark';
import { StarGrade } from '../components/ds/StarGrade';
import { TicketStub } from '../components/ds/TicketStub';
import { CallInspector } from '../components/game/CallInspector';
import { CallText } from '../components/game/CallText';
import { ContractLabel } from '../components/game/ContractLabel';
import { DealDiagram } from '../components/game/DealDiagram';
import { GRADE_STARS, GRADE_TEXT } from '../components/game/GradeToast';
import { ScoreReceipt } from '../components/game/ScoreReceipt';
import { SuitText } from '../components/game/SuitText';
import { AUTO_PLAY_DELAY_MS, motionOK, stagePlaySteps } from '../components/game/playAnim';
import { postmarkDate, signedScore, vulLabel } from '../format';
import { TourBoard, loadTourBoard } from '../onboarding/board0';
import { COPY, guidanceFor } from '../onboarding/script';
import { BiddingPhase, PlayPhase } from './Board';

/**
 * The first crossing — new-user onboarding. Three teaching goals, hardest
 * first: duplicate (same deals, one ledger), the teaching loop (meanings
 * before you commit, grades after), and the house philosophy (a small,
 * unhurried club; judgment over luck).
 *
 * The spine is Board №0, a captured practice deal (onboarding/board0.ts)
 * replayed through Board.tsx's own exported BiddingPhase/PlayPhase — the
 * player is using the real gameplay surface, with one addition: the
 * tollkeeper's narration ribbon. Off-script actions show their real meanings
 * (exploring is free) but only the scripted line commits, so the replay
 * stays deterministic. The tail of the hand self-plays ("the rest play
 * themselves tonight"), and duplicate is taught by the genuine field table:
 * the three house personas really played this deal at their tiers.
 *
 * App.tsx mounts this in place of the routes while me.user.onboardedAt is
 * null; it is also routed at /tour for revisits (and for demo-mode testers,
 * for whom the automatic gate is suppressed like the splash).
 */

type Stage = 'gate' | 'offer' | 'board' | 'postmark';

export default function Tour() {
  const { me, refresh } = useMe();
  const navigate = useNavigate();
  const revisit = me?.user?.onboardedAt != null; // routed /tour visit, not the gate
  const [stage, setStage] = useState<Stage>('gate');
  const [busy, setBusy] = useState(false);

  // Skipping and finishing both stamp the visit server-side (idempotent).
  // A first-timer's App gate unmounts this component once `me` refreshes;
  // a revisitor navigates out explicitly instead.
  const skip = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setOnboarded();
    } catch {
      /* the gate must never trap anyone — proceed regardless */
    }
    if (revisit) navigate('/');
    else refresh();
  };

  const playTheToll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setOnboarded().catch(() => {});
      const { tournamentId, boardNo } = await api.play();
      navigate(`/t/${tournamentId}/b/${boardNo}`);
      refresh();
    } catch {
      // placement failed (offline?) — fall back to the lobby rather than trap
      navigate('/');
      refresh();
    }
  };

  if (stage === 'gate') {
    return (
      <div className="tour-gate">
        <div className="tour-booth">
          <div className="tour-booth-inner">
            <div className="label-caps">AT THE GATE</div>
            <p className="tour-booth-line">{COPY.gateLine(me?.user?.handle ?? 'traveler')}</p>
          </div>
        </div>
        <div className="tour-gate-actions">
          <Button onClick={() => setStage('offer')}>FIRST TIME →</Button>
          <Button variant="secondary" onClick={skip} busy={busy} busyLabel="OPENING THE GATE…">
            I KNOW THE WAY — LET ME THROUGH
          </Button>
          <p className="tour-aside">{COPY.gateAside}</p>
        </div>
        <div className="tour-scene">
          <img className="day-scene" src={riverScene} width="390" height="146" alt="" />
          <img className="night-scene" src={riverSceneNight} width="390" height="146" alt="" />
        </div>
      </div>
    );
  }

  if (stage === 'offer') {
    return (
      <div className="tour-offer">
        <TicketStub label="PRACTICE" value="№0" edgeText="ADMIT ONE" width={200} />
        <h1 className="tour-title">{COPY.offerTitle}</h1>
        <p className="tour-copy">{COPY.offerBody}</p>
        <p className="tour-aside">{COPY.offerAside}</p>
        <div className="tour-offer-actions">
          <Button onClick={() => setStage('board')}>TAKE THE PRACTICE BOARD →</Button>
          <button type="button" className="label-caps tour-quietlink" onClick={skip} disabled={busy}>
            {COPY.offerSkip}
          </button>
        </div>
      </div>
    );
  }

  if (stage === 'postmark') {
    return (
      <div className="tour-postmark">
        <div className="tour-postmark-stamp">
          <Postmark size={128} arcTop="NICKEL BRIDGE" arcBottom="FIRST CROSSING" line1="№0" line2={postmarkDate(Date.now() / 1000)} />
        </div>
        <h1 className="tour-title">{COPY.doneTitle}</h1>
        <p className="tour-copy">{COPY.doneBody}</p>
        <p className="tour-aside">{COPY.doneAside}</p>
        <div className="tour-offer-actions">
          <Button onClick={playTheToll} busy={busy} busyLabel="FINDING A TABLE…">
            PLAY THE TOLL →
          </Button>
          <button type="button" className="label-caps tour-quietlink" onClick={skip} disabled={busy}>
            TO THE LOBBY INSTEAD
          </button>
        </div>
      </div>
    );
  }

  return <PracticeBoard onDone={() => setStage('postmark')} />;
}

/** The tollkeeper's ribbon — the tour's one net-new gameplay surface. */
function Tollkeeper({ text }: { text: string }) {
  return (
    <div className="tour-narr">
      <span className="label-caps">THE TOLLKEEPER</span>
      <p>
        <SuitText text={text} />
      </p>
    </div>
  );
}

/**
 * Board №0. Walks the captured decision steps: guided decisions wait for the
 * scripted action (off-script selections show their real meaning plus a
 * gentle redirect), auto decisions self-play the tail. Transitions between
 * captured views reuse stagePlaySteps, so robot cards glide/collect exactly
 * as on a live board — auto-run transitions play at claim-fast-forward pace.
 */
function PracticeBoard({ onDone }: { onDone: () => void }) {
  const [data, setData] = useState<TourBoard | null>(null);
  const [error, setError] = useState(false);
  const [view, setView] = useState<BoardView | null>(null);
  const [idx, setIdx] = useState(0);
  const [selectedCall, setSelectedCall] = useState<number | null>(null);
  const [selectedCard, setSelectedCard] = useState<number | null>(null);
  const [lastEval, setLastEval] = useState<BidEval | null>(null);
  const [inspect, setInspect] = useState<AuctionEntry | null>(null);
  const [offScript, setOffScript] = useState<string | null>(null);
  const [resultView, setResultView] = useState<'receipt' | 'field'>('receipt');

  useEffect(() => {
    let alive = true;
    loadTourBoard()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setView(d.steps[0].view);
      })
      .catch(() => setError(true));
    return () => {
      alive = false;
    };
  }, []);

  // Staged-transition timers, mirroring Board.tsx's scheduleSteps (with a
  // speed factor for the self-playing tail). Cancelled on unmount.
  const timersRef = useRef<number[]>([]);
  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const applyTransition = useCallback(
    (prev: BoardView, next: BoardView, speed: number) => {
      clearTimers();
      const steps = motionOK() ? stagePlaySteps(prev, next) : [];
      if (!steps.length) {
        // bidding→bidding (or reduced motion): land after a beat, as if the
        // robots took a moment to reply
        const id = window.setTimeout(() => setView(next), motionOK() ? 500 : 0);
        timersRef.current.push(id);
        return;
      }
      let at = 0;
      for (const step of steps) {
        at += Math.max(step.delayBefore * speed, step.delayBefore > 0 ? 60 : 0);
        const id = window.setTimeout(() => setView(step.view), at);
        timersRef.current.push(id);
      }
    },
    [clearTimers],
  );

  const idxRef = useRef(idx);
  idxRef.current = idx;

  const commit = useCallback(
    (auto: boolean) => {
      if (!data) return;
      const i = idxRef.current;
      const step = data.steps[i];
      if (!step) return;
      const next = i + 1 < data.steps.length ? data.steps[i + 1].view : data.final;
      if (step.kind === 'call' && step.evaluation) setLastEval(step.evaluation);
      if (step.kind === 'card') setLastEval(null);
      setSelectedCall(null);
      setSelectedCard(null);
      setOffScript(null);
      setInspect(null);
      setIdx(i + 1);
      applyTransition(step.view, next, auto ? 0.35 : 1);
    },
    [data, applyTransition],
  );

  // Self-playing decisions: the scripted tail (guidance `auto`), plus any
  // forced single-card turn — same treatment as Board.tsx's auto-play.
  const step = data?.steps[idx];
  const guidance = data ? guidanceFor(idx, data) : null;
  useEffect(() => {
    if (!data || !step || view !== step.view) return;
    const forced = step.kind === 'card' && step.view.legalCards?.length === 1;
    if (!guidance?.auto && !forced) return;
    const delay = !motionOK() ? 0 : forced && !guidance?.auto ? AUTO_PLAY_DELAY_MS : 420;
    const id = window.setTimeout(() => commit(Boolean(guidance?.auto)), delay);
    return () => clearTimeout(id);
  }, [data, step, view, guidance, commit]);

  if (error) {
    return (
      <div className="board-page">
        <div className="notice-error">The practice board went missing. Cross without it —</div>
        <div className="board-actions">
          <Button onClick={onDone}>CARRY ON →</Button>
        </div>
      </div>
    );
  }
  if (!data || !view) {
    return (
      <div className="board-page">
        <Loading />
      </div>
    );
  }

  const atDecision = step !== undefined && view === step.view;
  const guided = atDecision && !guidance?.auto;
  const forced = step?.kind === 'card' && step.view.legalCards?.length === 1;

  const attemptCall = (call: number) => {
    if (!step || step.kind !== 'call') return;
    if (call === step.action) commit(false);
    else setOffScript(guidance?.offScript ?? COPY.offScriptCall);
  };
  const onSelectCall = (call: number) => {
    if (!guided) return;
    if (selectedCall === call) {
      attemptCall(call);
      return;
    }
    setSelectedCall(call);
    setOffScript(null);
  };
  const onSelectCard = (card: number) => {
    if (!guided || !step || step.kind !== 'card') return;
    if (selectedCard === card) {
      if (card === step.action) commit(false);
      else {
        setSelectedCard(null);
        setOffScript(guidance?.offScript ?? COPY.offScriptCard);
      }
      return;
    }
    setSelectedCard(card);
    setOffScript(null);
  };

  const done = view.state === 'done';
  const narration = done
    ? resultView === 'receipt'
      ? COPY.receiptSay
      : COPY.fieldSay
    : (offScript ?? guidance?.say ?? COPY.fastForward);

  return (
    <div className={`board-page tour-board${view.state === 'bidding' ? ' bidding-dock' : ''}`}>
      <TourHead view={view} />
      <Tollkeeper text={narration} />
      {done ? (
        resultView === 'receipt' ? (
          <ScoreReceipt board={data.final} onContinue={() => setResultView('field')} />
        ) : (
          <TourResult board={data.final} onReceipt={() => setResultView('receipt')} onDone={onDone} />
        )
      ) : view.state === 'playing' ? (
        <PlayPhase
          board={view}
          lastEval={lastEval}
          selectedCard={selectedCard}
          onSelectCard={onSelectCard}
          inspect={inspect}
          onInspect={(e) => setInspect(e === inspect ? null : e)}
          claimInfo={null}
          hint={guided && !forced && step?.kind === 'card' && selectedCard === null ? step.action : null}
        />
      ) : (
        <BiddingPhase
          board={view}
          lastEval={lastEval}
          selectedCall={selectedCall}
          onSelectCall={onSelectCall}
          onConfirm={() => selectedCall !== null && attemptCall(selectedCall)}
          busy={!atDecision}
          inspect={inspect}
          onInspect={(e) => setInspect(e === inspect ? null : e)}
          hint={guided && step?.kind === 'call' && selectedCall === null ? step.action : null}
        />
      )}
      {inspect ? <CallInspector entry={inspect} onClose={() => setInspect(null)} /> : null}
    </div>
  );
}

/** Board-head chrome for №0 — same classes as Board's, practice markings. */
function TourHead({ view }: { view: BoardView }) {
  return (
    <div className="board-head">
      <TicketStub label="BOARD" value="№0" edgeText="PRACTICE" width={92} />
      <div className="board-head-mid">
        <div className="board-head-name">A practice crossing</div>
        <div className="board-head-sub num">
          Dealer {SEAT_SHORT[view.dealer]}
          {view.state === 'playing' && view.contractLabel ? (
            <>
              {' · '}
              <b>
                <ContractLabel label={view.contractLabel} />
              </b>
            </>
          ) : null}
        </div>
      </div>
      {view.state === 'done' ? (
        <InkStamp rotate={-4}>NO RECORD</InkStamp>
      ) : (
        <Chip color={view.vul.ns ? 'var(--suit-h)' : undefined} quiet={!view.vul.ns && !view.vul.ew}>
          {vulLabel(view.vul).toUpperCase()}
        </Chip>
      )}
    </div>
  );
}

/**
 * The ledger reveal — Board.tsx's Result composition with tour actions.
 * (Board's own Result navigates to the next board/tournament, which №0
 * doesn't have, so the markup is mirrored class-for-class here instead of
 * reusing the component with the wrong buttons.)
 */
function TourResult({ board, onReceipt, onDone }: { board: BoardView; onReceipt: () => void; onDone: () => void }) {
  const r = board.result!;
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
        <div className={`pct-big${r.pct < 40 ? ' low' : ''}`}>
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

      <PerforatedPanel heading="THE FIELD — BOARD №0" className="result-field">
        <table className="fieldtable num">
          <tbody>
            {r.field.map((f) => (
              <tr key={f.userId} className={f.isMe ? 'me' : f.kind === 'ai' ? 'house' : ''}>
                <td className="fieldtable-name">
                  {f.isMe ? 'You' : f.handle}
                  {f.kind === 'ai' ? <span className="house-tag">HOUSE</span> : null}
                </td>
                <td className="fieldtable-contract">
                  <ContractLabel label={f.contract} /> · {signedScore(f.scoreNS)}
                </td>
                <td className="fieldtable-pct">
                  <PctBar pct={f.pct} width={56} /> <b className="fieldtable-pctnum">{f.pct}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PerforatedPanel>

      {board.allHands ? (
        <DealDiagram hands={board.allHands} dealer={board.dealer} vul={board.vul} playedSeat={2} dummy={board.dummy} />
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
        <Button onClick={onDone}>ONE LAST THING →</Button>
      </div>
    </div>
  );
}
