import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMe } from '../App';
import { AuctionEntry, BidEval, BoardView, SEAT_SHORT, api } from '../api';
import riverSceneNight from '../assets/bridge-river-scene-night.svg';
import riverScene from '../assets/bridge-river-scene.svg';
import { BridgeMark } from '../components/ds/BridgeMark';
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
import { GlossaryProse } from '../components/game/GlossaryProse';
import { GRADE_STARS, GRADE_TEXT } from '../components/game/GradeToast';
import {
  CLAIM_ANNOUNCE_HOLD_MS,
  CLAIM_SPEEDUP_FACTOR,
  ClaimAnnouncement,
  StagedStep,
  claimAnnouncement,
  motionOK,
  stageClaimSteps,
  stagePlaySteps,
} from '../components/game/playAnim';
import { ScoreReceipt } from '../components/game/ScoreReceipt';
import { postmarkDate, signedScore, vulLabel } from '../format';
import { TourBoard, loadTourBoard } from '../onboarding/board0';
import { COPY, TOUR_LINKS, guidanceFor } from '../onboarding/script';
import { BiddingPhase, PlayPhase } from './Board';

/**
 * The first crossing — new-user onboarding. Three teaching goals, hardest
 * first: duplicate (same deals, one ledger), the teaching loop (meanings
 * before you commit, grades after), and the house philosophy (a small,
 * unhurried club; judgment over luck).
 *
 * It opens as the toll office's printed pamphlet — a cover and two short
 * panels (the club philosophy, then duplicate as a specimen ledger) with a
 * perforation-dot pager and an honest skip on every page.
 *
 * The spine is Board №0, a captured practice deal (onboarding/board0.ts)
 * replayed through Board.tsx's own exported BiddingPhase/PlayPhase — the
 * player is using the real gameplay surface, with one addition: the
 * tollkeeper's narration ribbon. Off-script actions show their real meanings
 * (exploring is free) but only the scripted line commits, so the replay
 * stays deterministic. The tail of the hand self-plays ("the rest of the
 * hand plays itself"), and duplicate is taught by the genuine field table:
 * the three house personas really played this deal at their tiers.
 *
 * App.tsx mounts this in place of the routes while me.user.onboardedAt is
 * null; it is also routed at /tour for revisits (and for demo-mode testers,
 * for whom the automatic gate is suppressed like the splash).
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Every line of the tour's own voice — pamphlet body copy and the tollkeeper's
 * narration — under the tour's glossary link policy (onboarding/script.ts's
 * TOUR_LINKS). A first crossing is where the words get met for the first time,
 * so the one screen in the app that says "dummy", "trumps" and "matchpoints"
 * to someone who has never seen them had better be able to define them.
 *
 * Display type is deliberately excluded: panel titles and the postmark heading
 * stay plain, since a dotted underline through a Poiret One headline reads as
 * damage rather than an invitation. Everything the board itself renders (bid
 * meanings, the grade toast, the receipt) already links on its own — it is the
 * real gameplay surface, under the sitewide policy.
 */
function TourProse({ text, skip }: { text: string; skip?: readonly string[] }) {
  return <GlossaryProse text={text} {...TOUR_LINKS} skip={[...(TOUR_LINKS.skip ?? []), ...(skip ?? [])]} />;
}

// A forced-but-guided decision (right now, only the dummy's forced opening-
// lead follow) still carries a full narration line worth reading — the
// live board's AUTO_PLAY_DELAY_MS (250ms, tuned for a trivial single-legal-
// card tap with nothing to read) blew right past it. Give guided steps a
// real beat before they self-advance. This one is a READING beat, not an
// animation, so reduced motion doesn't shorten it (see the delay below):
// asking for less movement isn't asking to be taught faster.
const GUIDED_FORCED_DELAY_MS = 6000;
// The self-playing tail (steps with no curated guidance) — brief, since
// there's no narration line to read, just the fastForward copy repeating.
const AUTO_STEP_DELAY_MS = 420;

type Stage = 'cover' | 'bridge' | 'ledger' | 'offer' | 'board' | 'postmark';

/** Panel II's illustration: one deal, three fates — the whole idea in a table. */
const SPECIMEN = [
  { who: 'You', contract: '4♠ by S =', score: 620, pct: 100, me: true },
  { who: 'Harold', contract: '3♠ by S +1', score: 170, pct: 50, me: false },
  { who: 'Margaret', contract: '4♠ by S −1', score: -100, pct: 0, me: false },
];

export default function Tour() {
  const { me, refresh } = useMe();
  const navigate = useNavigate();
  // Mounted at the /tour route (a Glossary or Exhibit Hall replay) vs.
  // rendered by App's arrival gate in place of the routes. The gate unmounts
  // on refresh(); a routed visit has to navigate out itself.
  const routed = useLocation().pathname === '/tour';
  const [stage, setStage] = useState<Stage>('cover');
  const [busy, setBusy] = useState(false);

  // Skipping and finishing both stamp the visit server-side (idempotent,
  // write-once — replays never move it). `finally` resets `busy` on every
  // path: a thrown setOnboarded (session hiccup, transient network failure)
  // is swallowed so the gate never traps anyone, but without resetting busy
  // here every skip/continue control on the page — all `disabled={busy}` —
  // would stay wedged for the rest of the session, since a failed call never
  // flips onboardedAt and App.tsx keeps rendering this same Tour instance.
  const skip = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setOnboarded();
    } catch {
      /* the gate must never trap anyone — proceed regardless */
    } finally {
      setBusy(false);
    }
    if (routed) navigate('/');
    refresh();
  };

  // Deliberately NOT catching setOnboarded separately: a failed stamp leaves
  // the gate closed, so navigating to a freshly-placed board would show the
  // tour at a board URL until the next reload. Let it fall into the catch
  // below and land back at the pamphlet's own exit instead.
  const playTheToll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setOnboarded();
      const { tournamentId, boardNo } = await api.play();
      navigate(`/t/${tournamentId}/b/${boardNo}`);
      refresh();
    } catch {
      // stamp or placement failed (offline?) — fall back to the lobby rather
      // than trap. If it was the stamp, the gate is still closed and this
      // lands back on the postmark, where PLAY THE TOLL can simply be tapped
      // again; if it was placement, the stamp took and the lobby renders.
      navigate('/');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'cover') {
    return (
      <div className="tour-gate">
        <div className="tour-cover-head">
          <span className="label-caps">{COPY.cover.dept}</span>
          <InkStamp color="var(--accent)" rotate={-7}>
            {COPY.cover.stamp}
          </InkStamp>
        </div>
        <div className="tour-cover-main">
          <h1 className="tour-cover-title">{COPY.cover.title}</h1>
          <p className="tour-aside">
            <TourProse text={COPY.cover.aside} />
          </p>
          <div className="tour-gate-actions">
            <Button onClick={() => setStage('bridge')}>{COPY.cover.begin}</Button>
          </div>
        </div>
        <button type="button" className="label-caps tour-skip" onClick={skip} disabled={busy}>
          {COPY.skip}
        </button>
        <div className="tour-scene">
          <img className="day-scene" src={riverScene} width="390" height="146" alt="" />
          <img className="night-scene" src={riverSceneNight} width="390" height="146" alt="" />
        </div>
      </div>
    );
  }

  if (stage === 'bridge') {
    return (
      <div className="tour-page">
        <span className="label-caps tour-page-no">{COPY.bridgePanel.no}</span>
        <h1 className="tour-title">{COPY.bridgePanel.title}</h1>
        <p className="tour-copy">
          <TourProse text={COPY.bridgePanel.body1} />
        </p>
        <p className="tour-copy">
          <TourProse text={COPY.bridgePanel.body2} />
        </p>
        <hr className="tour-rule" />
        <p className="tour-aside">
          <TourProse text={COPY.bridgePanel.aside} />
        </p>
        <div className="tour-page-foot">
          <BridgeMark variant="footer" width={150} />
        </div>
        <div className="tour-gate-actions">
          <Button onClick={() => setStage('ledger')}>CONTINUE →</Button>
        </div>
        <button type="button" className="label-caps tour-skip" onClick={skip} disabled={busy}>
          {COPY.skip}
        </button>
      </div>
    );
  }

  if (stage === 'ledger') {
    return (
      <div className="tour-page">
        <span className="label-caps tour-page-no">{COPY.ledgerPanel.no}</span>
        <h1 className="tour-title">{COPY.ledgerPanel.title}</h1>
        <PerforatedPanel heading="THE FIELD — ONE DEAL, THREE CROSSINGS" className="tour-specimen">
          <table className="fieldtable num">
            <tbody>
              {SPECIMEN.map((r) => (
                <tr key={r.who} className={r.me ? 'me' : ''}>
                  <td className="fieldtable-name">{r.who}</td>
                  <td className="fieldtable-contract">
                    <ContractLabel label={r.contract} /> · {signedScore(r.score)}
                  </td>
                  <td className="fieldtable-pct">
                    <PctBar pct={r.pct} width={56} /> <b className="fieldtable-pctnum">{r.pct}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PerforatedPanel>
        <p className="tour-copy">
          <TourProse text={COPY.ledgerPanel.body1} />
        </p>
        <p className="tour-copy">
          {/* "the game" here means bridge itself, not the scoring term */}
          <TourProse text={COPY.ledgerPanel.body2} skip={['game']} />
        </p>
        <div className="tour-page-foot" />
        <div className="tour-gate-actions">
          <Button onClick={() => setStage('offer')}>CONTINUE →</Button>
        </div>
        <button type="button" className="label-caps tour-skip" onClick={skip} disabled={busy}>
          {COPY.skip}
        </button>
      </div>
    );
  }

  if (stage === 'offer') {
    return (
      <div className="tour-offer">
        <span className="label-caps tour-page-no">{COPY.offerNo}</span>
        <div style={{ height: 18 }} />
        <TicketStub label="PRACTICE" value="№0" edgeText="ADMIT ONE" width={200} />
        <h1 className="tour-title">{COPY.offerTitle}</h1>
        <p className="tour-copy">
          <TourProse text={COPY.offerBody} />
        </p>
        <div className="tour-offer-actions">
          <Button onClick={() => setStage('board')}>PRACTICE →</Button>
        </div>
        <button type="button" className="label-caps tour-skip" onClick={skip} disabled={busy}>
          {COPY.skip}
        </button>
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
        <p className="tour-copy">
          <TourProse text={COPY.doneBody} />
        </p>
        <p className="tour-aside">
          <TourProse text={COPY.doneAside} />
        </p>
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

  // onLeave: the practice board's receipt carries the shared "Back to lobby"
  // secondary action, which is an ordinary <Link to="/"> on a live board — but
  // the tour renders in place of the routes, so it would change the URL and
  // leave the tester staring at the same receipt. Route it through skip(),
  // which is what leaving actually means here.
  return <PracticeBoard onDone={() => setStage('postmark')} onLeave={skip} />;
}

/**
 * The tollkeeper's ribbon — the tour's one net-new gameplay surface. Sticky
 * at the top of the viewport so the narration stays readable from any scroll
 * position (play and result phases scroll the document; content passes
 * underneath rather than being covered), with a run-in label to keep the
 * band shallow. A line change replays a brief ink-wash pulse (same "don't
 * miss this" idea as the vulnerability chip's one-time pulse; stilled under
 * reduced motion) by remounting the wash overlay — and ONLY the overlay. The
 * `role="status"` element itself has to outlive the change: assistive tech
 * announces mutations inside a live region it is already watching, and a
 * region swapped out for a fresh, already-populated one is routinely missed.
 */
function Tollkeeper({ text, skip }: { text: string; skip?: readonly string[] }) {
  return (
    <div className="tour-narr" role="status">
      <span key={text} className="tour-narr-wash" aria-hidden="true" />
      <span className="label-caps tour-narr-who">THE TOLLKEEPER</span>
      <p>
        <TourProse text={text} skip={skip} />
      </p>
    </div>
  );
}

/**
 * Board №0. Walks the captured decision steps: guided decisions wait for the
 * scripted action (off-script selections show their real meaning plus a
 * gentle redirect), auto decisions self-play the tail. Transitions between
 * captured views reuse stagePlaySteps, so robot cards glide/collect exactly
 * as on a live board — auto-run transitions play sped up. This deal's
 * contract is decided early enough that the capture's tail IS a genuine
 * server-side claim (see gen_tour_board.mjs), so the last transition uses
 * the same ClaimOverlay + stageClaimSteps fast-forward the live board does,
 * instead of the flat cut a multi-trick jump would otherwise fall back to.
 */
function PracticeBoard({ onDone, onLeave }: { onDone: () => void; onLeave: () => void }) {
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
  // speed factor for the self-playing tail).
  const timersRef = useRef<number[]>([]);
  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  // Claim state, mirroring Board.tsx's runClaim: the captured tail can BE a
  // genuine server-side claim (this deal's contract is 100% decided early —
  // see gen_tour_board.mjs's doc comment on why the capture must preserve
  // that). stagePlaySteps only ever stages a single trick boundary, so a
  // multi-trick claim jump needs the same announcement + sped-up
  // fast-forward the live board uses, or it falls back to an unanimated cut
  // straight to the ledger. claimGenRef invalidates an in-flight sequence
  // the same way it does in Board.tsx (a fresher commit, or unmount).
  const [claimInfo, setClaimInfo] = useState<ClaimAnnouncement | null>(null);
  const [claimAnnounceOpen, setClaimAnnounceOpen] = useState(false);
  const claimGenRef = useRef(0);
  const claimSkipRef = useRef<(() => void) | null>(null);
  const skipClaimAnnouncement = useCallback(() => claimSkipRef.current?.(), []);

  useEffect(
    () => () => {
      clearTimers();
      claimGenRef.current++;
      claimSkipRef.current = null;
    },
    [clearTimers],
  );

  // Schedules already-computed steps on timers; returns the total duration
  // so runClaim (below) can await it, same split Board.tsx's scheduleSteps
  // enables for its own runClaim.
  const scheduleSteps = useCallback(
    (steps: StagedStep[], speed = 1) => {
      clearTimers();
      let at = 0;
      for (const step of steps) {
        at += Math.max(step.delayBefore * speed, step.delayBefore > 0 ? 60 : 0);
        const id = window.setTimeout(() => setView(step.view), at);
        timersRef.current.push(id);
      }
      return at;
    },
    [clearTimers],
  );

  const applyTransition = useCallback(
    (prev: BoardView, next: BoardView, speed: number) => {
      const steps = motionOK() ? stagePlaySteps(prev, next) : [];
      if (!steps.length) {
        // bidding→bidding (or reduced motion): land after a beat, as if the
        // robots took a moment to reply
        clearTimers();
        const id = window.setTimeout(() => setView(next), motionOK() ? 500 : 0);
        timersRef.current.push(id);
        return;
      }
      scheduleSteps(steps, speed);
    },
    [clearTimers, scheduleSteps],
  );

  // Bracket a claim the same two ways Board.tsx does: an unmissable,
  // dismissible announcement (tap/click/Escape via ClaimOverlay, rendered by
  // the shared PlayPhase below), THEN the sped-up fast-forward, before
  // handing off to the real (done) `next` view.
  const runClaim = useCallback(
    async (prev: BoardView, next: BoardView) => {
      const info = claimAnnouncement(prev, next);
      if (!info) {
        applyTransition(prev, next, 0.35); // data didn't line up — fall back to a plain cut
        return;
      }
      const gen = ++claimGenRef.current;
      setClaimInfo(info);
      setClaimAnnounceOpen(true);
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(finish, CLAIM_ANNOUNCE_HOLD_MS);
        function finish() {
          window.clearTimeout(timer);
          claimSkipRef.current = null;
          resolve();
        }
        claimSkipRef.current = finish;
      });
      if (claimGenRef.current !== gen) return;
      setClaimAnnounceOpen(false);

      if (motionOK()) {
        const steps = stageClaimSteps(prev, next, CLAIM_SPEEDUP_FACTOR);
        if (steps.length) {
          const totalMs = scheduleSteps(steps);
          await sleep(totalMs);
          if (claimGenRef.current !== gen) return;
        }
      }
      setClaimInfo(null);
      clearTimers();
      setView(next);
    },
    [applyTransition, scheduleSteps, clearTimers],
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
      if (next.claimed && step.view.state === 'playing') {
        runClaim(step.view, next);
      } else {
        applyTransition(step.view, next, auto ? 0.35 : 1);
      }
    },
    [data, applyTransition, runClaim],
  );

  // Self-playing decisions: the scripted tail (guidance `auto`), plus any
  // forced single-card turn — same treatment as Board.tsx's auto-play. A
  // guided-but-forced decision (right now, only the dummy's forced opening-
  // lead follow) still has a full narration line worth reading, so it gets
  // GUIDED_FORCED_DELAY_MS instead of the live board's near-instant
  // auto-play delay — that line was disappearing before a player could
  // read it.
  const step = data?.steps[idx];
  const guidance = data ? guidanceFor(idx, data) : null;
  useEffect(() => {
    if (!data || !step || view !== step.view) return;
    const forced = step.kind === 'card' && step.view.legalCards?.length === 1;
    if (!guidance?.auto && !forced) return;
    // The tail's pacing is animation, so reduced motion drops it to 0; the
    // guided beat is reading time and survives either way.
    const delay = guidance?.auto ? (motionOK() ? AUTO_STEP_DELAY_MS : 0) : GUIDED_FORCED_DELAY_MS;
    const id = window.setTimeout(() => commit(Boolean(guidance?.auto)), delay);
    return () => clearTimeout(id);
  }, [data, step, view, guidance, commit]);

  // The ribbon narrates what's ALREADY true on screen — but idx (and thus
  // `guidance` above) advances the instant a call/card commits, synchronously,
  // while the corresponding view can take a staged glide/hold (or a claim
  // fast-forward) to visually catch up. Switching the caption immediately
  // used to describe events — "West leads, and partner lays their hand on
  // the table" — before the board had shown any of it (still displaying the
  // completed auction, dummy not yet down), which read as rushed even though
  // the line itself stayed up for a while. displayIdx lags idx until `view`
  // actually settles onto that step's own view (or the final view), keeping
  // the PREVIOUS caption up for the whole transition instead.
  const [displayIdx, setDisplayIdx] = useState(0);
  useEffect(() => {
    if (!data || !view) return;
    if (view === data.final) {
      setDisplayIdx(data.steps.length);
      return;
    }
    if (data.steps[idx]?.view === view) setDisplayIdx(idx);
  }, [data, view, idx]);
  const displayGuidance = data ? guidanceFor(displayIdx, data) : null;

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
    : (offScript ?? displayGuidance?.say ?? COPY.fastForward);

  return (
    <div className={`board-page tour-board${view.state === 'bidding' ? ' bidding-dock' : ''}`}>
      <TourHead view={view} />
      <Tollkeeper text={narration} skip={displayGuidance?.skip} />
      {done ? (
        resultView === 'receipt' ? (
          <ScoreReceipt board={data.final} onContinue={() => setResultView('field')} onLeave={onLeave} />
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
          claimInfo={claimInfo}
          claimAnnounceOpen={claimAnnounceOpen}
          onSkipClaim={skipClaimAnnouncement}
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
