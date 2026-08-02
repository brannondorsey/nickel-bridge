import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMe } from '../App';
import { AuctionEntry, BidEval, BoardView, SEAT_SHORT, api } from '../api';
import { Button } from '../components/ds/Button';
import { Chip } from '../components/ds/Chip';
import { FlipDigits } from '../components/ds/FlipDigits';
import { InkStamp } from '../components/ds/InkStamp';
import { Loading } from '../components/ds/Loading';
import { PctBar } from '../components/ds/PctBar';
import { PerforatedPanel } from '../components/ds/PerforatedPanel';
import { Postmark } from '../components/ds/Postmark';
import { SignInActions } from '../components/ds/SignInActions';
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
  CLAIM_LEAD_SETTLE_MS,
  ClaimAnnouncement,
  StagedStep,
  motionOK,
  planClaim,
  stageBidSteps,
  stagePlaySteps,
} from '../components/game/playAnim';
import { ScoreReceipt } from '../components/game/ScoreReceipt';
import { postmarkDate, signedScore, vulLabel } from '../format';
import { TourBoard, loadTourBoard } from '../onboarding/board0';
import { COPY, TOUR_LINKS, guidanceFor } from '../onboarding/script';
import { stampTourDone } from '../onboarding/tourDone';
import { BiddingPhase, PlayPhase } from './Board';

/**
 * The first crossing — new-user onboarding. Three teaching goals, hardest
 * first: duplicate (same deals, one ledger), the teaching loop (meanings
 * before you commit, grades after), and the house philosophy (a small,
 * unhurried club; judgment over luck).
 *
 * It opens on the deal itself — see the Stage type for what used to precede
 * it and why that went.
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
 * Every line of the tour's own voice — the tollkeeper's narration — under
 * the tour's glossary link policy (onboarding/script.ts's
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

/**
 * The board, then the postmark. Nothing in front of them.
 *
 * There used to be a four-page pamphlet here — a cover, a philosophy panel
 * (I · THE BRIDGE), duplicate as a specimen ledger (II · THE LEDGER) and a
 * practice offer — then, briefly, a single welcome screen merged from the
 * first and last of those. Both were redundant by the time a reader arrived.
 *
 * The landing page makes the philosophy and duplicate arguments in its own
 * sections I and II (word for word, down to a shared SpecimenField), and its
 * section V then promises the practice board in the same breath as the CTA:
 * "walk one deal with the tollkeeper — bid it, play it, read the receipt". A
 * welcome screen restating that is the reader's own last ten seconds handed
 * back. And it is not a minority path: the automatic gate fires for a new
 * account arriving at `/`, which is where signing in FROM the landing page
 * returns them, so essentially every first-timer came through that pitch.
 *
 * So the tour opens on the deal itself. The tollkeeper's first line is the
 * framing ("Your hand, counted: fifteen high card points…"), the board head
 * already carries the PRACTICE №0 ticket, and SKIP THE TUTORIAL moved to the
 * narration ribbon — which is sticky, so unlike the pamphlet's fine print it
 * is now reachable at every moment of the deal rather than only before it.
 */
type Stage = 'board' | 'postmark';

export default function Tour() {
  const { me, refresh } = useMe();
  const navigate = useNavigate();
  // The tour reads without an account (App.tsx's isPublicPath): the practice
  // board is a captured replay, so nothing on this screen needs a session —
  // but both doors out of it did. Signed out, skipping is just leaving, and
  // finishing ends at the gate rather than at a real table.
  const authed = Boolean(me?.user);
  // Mounted at the /tour route (a Glossary or Exhibit Hall replay) vs.
  // rendered by App's arrival gate in place of the routes. The gate unmounts
  // on refresh(); a routed visit has to navigate out itself.
  const routed = useLocation().pathname === '/tour';
  const [stage, setStage] = useState<Stage>('board');
  const [busy, setBusy] = useState(false);

  // Skipping and finishing both stamp the visit server-side (idempotent,
  // write-once — replays never move it). `finally` resets `busy` on every
  // path: a thrown setOnboarded (session hiccup, transient network failure)
  // is swallowed so the gate never traps anyone, but without resetting busy
  // here every skip/continue control on the page — all `disabled={busy}` —
  // would stay wedged for the rest of the session, since a failed call never
  // flips onboardedAt and App.tsx keeps rendering this same Tour instance.
  //
  // Signed out there is no gate to stamp and no session to stamp it with, so
  // leaving is just leaving: firing a POST that can only 401 would be noise
  // in the console and a pointless wait on the way to the landing page.
  const skip = async () => {
    if (busy) return;
    if (!authed) {
      navigate('/');
      return;
    }
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
  // below and land back on the practice board, whose ribbon carries the exit.
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

  if (stage === 'postmark') {
    return <TourPostmark authed={authed} busy={busy} onPlay={playTheToll} onSkip={skip} />;
  }

  // onLeave: the practice board's receipt carries the shared "Back to lobby"
  // secondary action, which is an ordinary <Link to="/"> on a live board — but
  // the tour renders in place of the routes, so it would change the URL and
  // leave the tester staring at the same receipt. Route it through skip(),
  // which is what leaving actually means here. (The tour shell also hides that
  // button outright — see .tour-board .receipt in style.css — so this is a
  // belt-and-braces override, not the visible exit; the visible one is the
  // ribbon's SKIP THE TUTORIAL and, signed out, the postmark below.)
  return <PracticeBoard onDone={() => setStage('postmark')} onLeave={skip} busy={busy} />;
}

/**
 * The last page: the crossing is stamped, and the tour hands over.
 *
 * Its own component so a test can reach it without walking all thirteen
 * decisions of board №0 first — that walk is a 30-second case, and the two
 * doors here are exactly what changed when the tour went public.
 *
 * Signed in, the primary action places you into a real tournament. Signed
 * out, it IS the sign-up: this is the one moment in the whole unauthenticated
 * experience where asking for an account buys the visitor something they have
 * just been shown the value of. The secondary door changes with it — someone
 * who has never signed in has no lobby to be sent back to, so they're offered
 * the ledger, which they can read right now.
 */
export function TourPostmark({
  authed,
  busy,
  onPlay,
  onSkip,
}: {
  authed: boolean;
  busy: boolean;
  onPlay: () => void;
  onSkip: () => void;
}) {
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
        <TourProse text={authed ? COPY.doneAside : COPY.doneAsideAnon} />
      </p>
      <div className="tour-offer-actions">
        {authed ? (
          <>
            <Button onClick={onPlay} busy={busy} busyLabel="FINDING A TABLE…">
              PLAY THE TOLL →
            </Button>
            <button type="button" className="label-caps tour-quietlink" onClick={onSkip} disabled={busy}>
              TO THE LOBBY INSTEAD
            </button>
          </>
        ) : (
          <>
            {/* stampTourDone before the redirect: OAuth takes this browser off
                to Google and brings it back as a brand-new account with
                onboarded_at NULL, which is precisely the state App.tsx's
                arrival gate exists to catch. Without the claim, finishing the
                tour is rewarded with the tour. */}
            <SignInActions onSignIn={stampTourDone} />
            <Link className="label-caps tour-quietlink" to="/glossary">
              READ THE LEDGER INSTEAD
            </Link>
          </>
        )}
      </div>
    </div>
  );
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
function Tollkeeper({
  text,
  skip,
  onSkip,
  busy,
}: {
  text: string;
  skip?: readonly string[];
  onSkip: () => void;
  busy: boolean;
}) {
  return (
    <div className="tour-narr" role="status">
      <span key={text} className="tour-narr-wash" aria-hidden="true" />
      <div className="tour-narr-head">
        <span className="label-caps tour-narr-who">THE TOLLKEEPER</span>
        {/* The way out, and the only one now that nothing precedes the board.
            It lives in the ribbon because the ribbon is sticky: the pamphlet's
            fine print could only be reached before the deal started, this can
            be reached at any point during it. Outside the role="status" text
            so a live-region announcement never reads the control. */}
        <button type="button" className="label-caps tour-narr-skip" onClick={onSkip} disabled={busy}>
          {COPY.skip}
        </button>
      </div>
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
function PracticeBoard({ onDone, onLeave, busy }: { onDone: () => void; onLeave: () => void; busy: boolean }) {
  // The tour is public, so there may be no account to have set this; the
  // default matches the live board's.
  const fastForward = useMe().me?.user?.fastForward !== false;
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
      const steps = motionOK() ? (prev.state === 'bidding' ? stageBidSteps(prev, next) : stagePlaySteps(prev, next)) : [];
      if (!steps.length) {
        // reduced motion, or a transition with nothing to stage: land after a
        // beat, as if the robots took a moment to reply
        clearTimers();
        const id = window.setTimeout(() => setView(next), motionOK() ? 500 : 0);
        timersRef.current.push(id);
        return;
      }
      scheduleSteps(steps, speed);
    },
    [clearTimers, scheduleSteps],
  );

  // Bracket a claim the same three ways Board.tsx does, off the same shared
  // plan: the tricks that aren't part of the guaranteed run replay at
  // ordinary table pace first (announcing over a trick the player just won
  // reads as the board contradicting itself), THEN an unmissable, dismissible
  // announcement (tap/click/Escape via ClaimOverlay, rendered by the shared
  // PlayPhase below), THEN the sped-up fast-forward, before handing off to
  // the real (done) `next` view. planClaim owns the arithmetic so the two
  // copies of this glue can't drift about which cards belong to which beat.
  const runClaim = useCallback(
    async (prev: BoardView, next: BoardView) => {
      const motion = motionOK();
      // Honours the settings gate's fast-forward the same way the live board
      // does — and defaults to on for the signed-out visitor walking the
      // practice deal, who has no account to have set it.
      const plan = planClaim(prev, next, { fast: fastForward, motion });
      if (!plan) {
        applyTransition(prev, next, 0.35); // data didn't line up — fall back to a plain cut
        return;
      }
      const gen = ++claimGenRef.current;

      if (plan.lead.length) {
        const settled = plan.lead[plan.lead.length - 1].view;
        if (motion) {
          await sleep(scheduleSteps(plan.lead));
        } else {
          clearTimers();
          setView(settled);
        }
        if (claimGenRef.current !== gen) return;
        await sleep(CLAIM_LEAD_SETTLE_MS); // let the tally stamp land
        if (claimGenRef.current !== gen) return;
      }

      setClaimInfo(plan.info);
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

      if (plan.tail.length) {
        await sleep(scheduleSteps(plan.tail));
        if (claimGenRef.current !== gen) return;
      }
      setClaimInfo(null);
      clearTimers();
      setView(next);
    },
    [applyTransition, scheduleSteps, clearTimers, fastForward],
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
      <Tollkeeper text={narration} skip={displayGuidance?.skip} onSkip={onLeave} busy={busy} />
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
