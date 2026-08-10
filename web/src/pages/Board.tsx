import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMe } from '../App';
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
import { ClaimOverlay } from '../components/game/ClaimOverlay';
import { ContractLabel } from '../components/game/ContractLabel';
import { DealDiagram } from '../components/game/DealDiagram';
import { DummyRail } from '../components/game/DummyRail';
import { GRADE_STARS, GRADE_TEXT, GradeToast } from '../components/game/GradeToast';
import { HandFan } from '../components/game/HandFan';
import { MeaningPanel } from '../components/game/MeaningPanel';
import { SuitText } from '../components/game/SuitText';
import {
  AUTO_PLAY_DELAY_MS,
  CLAIM_ANNOUNCE_HOLD_MS,
  CLAIM_LEAD_SETTLE_MS,
  ClaimAnnouncement,
  StagedStep,
  captureFanOriginIfVisible,
  motionOK,
  optimisticPlayView,
  planClaim,
  stageBidSteps,
  stageClaimSteps,
  stageOpeningBids,
  stagePlaySteps,
  totalDuration,
  trimStagedPrefix,
} from '../components/game/playAnim';
import { AdjustedReceipt } from '../components/game/AdjustedReceipt';
import { ScoreReceipt } from '../components/game/ScoreReceipt';
import { TrickArea } from '../components/game/TrickArea';
import { signedScore, vulLabel } from '../format';

const SEAT_NAMES = ['NORTH', 'EAST', 'SOUTH', 'WEST'];

/** A refused play, and whether resyncing has stopped trying — see playNotice. */
export interface PlayNotice {
  message: string;
  stuck?: boolean;
}
export const RESYNC_MESSAGE = 'Board state got out of sync. Resyncing now.';
export const RESYNC_STUCK_MESSAGE = 'Board state got out of sync, and resyncing has not settled it.';
export const RESYNC_ATTEMPT_LIMIT = 3;
/**
 * How long the resync notice stays up before the true position replaces it.
 *
 * The refetch is one GET against a board the server already has in memory, so
 * it usually answers in a few milliseconds — faster than the notice can be
 * read, and often faster than it can be SEEN at all. Without this the player
 * gets an unexplained flicker and a board that silently jumps to a different
 * position, which is the one thing this notice exists to prevent: the whole
 * point is telling them their screen was behind before the screen changes
 * under them. So the notice owns the transition for a fixed beat and the new
 * board lands with it, rather than the board arriving whenever the network
 * happens to answer.
 *
 * A floor, not a delay: a refetch slower than this costs nothing extra, and
 * the board is locked either way, so the player is never kept from a move
 * they could have made.
 */
export const RESYNC_MIN_NOTICE_MS = 3000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The board screen — bidding, card play, and the scored result, one route. */
export default function Board() {
  const { tid, no } = useParams();
  const navigate = useNavigate();
  const tournamentId = Number(tid);
  const boardNo = Number(no);

  const { me, refresh } = useMe();
  // "Bid feedback" (settings gate) — gates only whether the post-call grading
  // toast renders below; grading is computed and stored (bidEvals)
  // unconditionally, so turning this off never affects scoring, stats, or
  // the post-board review table. See the bid_feedback migration in db.ts.
  const bidFeedback = me?.user?.bidFeedback !== false;
  // "Beta features" (settings gate) — Analyze is still in beta; see the
  // beta_features migration in db.ts. The server enforces this too (the
  // /analysis route 403s an account without it), so hiding the door here is
  // a courtesy, not the only guard.
  const betaFeatures = me?.user?.betaFeatures === true;
  // "Double-tap to bid" (settings gate) — whether a second tap on the already-
  // selected call submits it. Defaults OFF (fail closed, unlike the flags
  // above), since accidental bids from that shortcut are what shipping it off
  // by default fixes; the confirm CTA is always the other, unaffected path.
  // See the double_tap_bid migration in db.ts.
  const doubleTapBid = me?.user?.doubleTapBid === true;
  // "Trick clearing" (settings gate) — 'auto' (default) sweeps a completed
  // trick off the table on its own timer; 'tap' holds it until the player
  // taps the trick area. See scheduleSteps below for where this is read, and
  // the trick_clear_mode migration in db.ts for why claims are excluded.
  const trickClearMode = me?.user?.trickClearMode === 'tap' ? 'tap' : 'auto';

  const [board, setBoard] = useState<BoardView | null>(null);
  // The auction length stageOpeningBids' reveal is building toward — see
  // AuctionGrid's reserveThrough. Set alongside the reveal it paces (load,
  // below) so the tray is already at its settled row count on the empty
  // first frame instead of growing a row partway through the replay; 0
  // outside that reveal is a no-op (AuctionGrid takes the max against the
  // real auction length, which only grows from there).
  const [auctionReserve, setAuctionReserve] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // A REJECTED CARD PLAY means this screen is BEHIND THE SERVER, and that is
  // the only thing it means. Every rejection submitPlay can raise — 'not in
  // play phase', 'not your turn', 'illegal card' — is thrown after refresh()
  // re-reads the row under the board lock, so all three say the same thing:
  // somebody else (a second tab, another device) moved this board on. The
  // pre-tap view is therefore not a position to hand back to the player.
  // Restoring it and leaving the fan tappable is actually the worst of the
  // options: the next tap is made against a trick that is no longer on the
  // table, and if that card happens to still be legal in the position the
  // server actually holds, it simply plays — a card chosen to follow a lead
  // that isn't there any more.
  //
  // But the board is not broken either, so replacing the screen with the
  // "back to lobby" `error` page throws away something recoverable. The
  // state isn't unrecoverable, it's UNKNOWN, and one GET settles it. So a
  // refused play locks the board, says so, and refetches. That covers the
  // failure this can't be told apart from, too — api.ts's request() throws a
  // bare Error with no status, so a dropped connection where the server
  // never saw the play looks identical here, and there the refetch simply
  // returns the same position and the player taps again.
  const [playNotice, setPlayNotice] = useState<PlayNotice | null>(null);
  // Consecutive refused plays with no successful one in between. The resync
  // is only a fix if the server eventually agrees with its own GET; a second
  // tab playing continuously could otherwise ping-pong refuse → refetch →
  // auto-play → refuse indefinitely, which is the unbounded retry loop this
  // guard exists to stop being, just at two round trips a lap. After
  // RESYNC_ATTEMPT_LIMIT the screen stops trying and hands it to the player.
  const rejectStreakRef = useRef(0);
  const [selectedCall, setSelectedCall] = useState<number | null>(null);
  const [selectedCard, setSelectedCard] = useState<number | null>(null);
  const [lastEval, setLastEval] = useState<BidEval | null>(null);
  const [inspect, setInspect] = useState<AuctionEntry | null>(null);
  const [busy, setBusy] = useState(false);

  // A claim's fast-forward, driven by runClaim below. claimInfo is non-null
  // for the whole sequence (announcement + fast-forward); claimAnnounceOpen
  // is true only while the ClaimOverlay itself should be on screen — it
  // closes (tap, Escape, or CLAIM_ANNOUNCE_HOLD_MS elapsing) before the
  // fast-forward starts. claimGenRef guards the sequence the same way
  // stagingRef guards applyBoard's per-card timers: bumping it invalidates
  // any claim sequence in flight. claimSkipRef holds the current
  // announcement's early-dismiss resolver, if one is waiting.
  const [claimInfo, setClaimInfo] = useState<ClaimAnnouncement | null>(null);
  const [claimAnnounceOpen, setClaimAnnounceOpen] = useState(false);
  const claimGenRef = useRef(0);
  const claimSkipRef = useRef<(() => void) | null>(null);
  const skipClaimAnnouncement = useCallback(() => claimSkipRef.current?.(), []);

  // Vulnerability ink-wash pulse: flags a vulnerable board once, right as its
  // bidding phase is first seen, so vulnerability (which changes the stakes of
  // every call) can't be missed the way a static chip can. Keyed per
  // (tournament, board) so it fires exactly once per board no matter how many
  // times the bidding-phase view re-renders as calls come in; CSS handles
  // reduced motion by never animating the pulse, since the chip's own red
  // border/label already marks vulnerability at rest.
  const vulPulseSeenRef = useRef<Set<string>>(new Set());
  const [vulPulseKey, setVulPulseKey] = useState<string | null>(null);
  useEffect(() => {
    if (!board || board.state !== 'bidding' || (!board.vul.ns && !board.vul.ew)) return;
    const key = `${tournamentId}:${board.boardNo}`;
    if (vulPulseSeenRef.current.has(key)) return;
    vulPulseSeenRef.current.add(key);
    setVulPulseKey(key);
  }, [board, tournamentId]);

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
      // The tournament (not just this board) just finished live — Home's
      // medal rail and "TOLLS PAID" list read off MeContext/api.tournaments(),
      // neither of which this screen otherwise touches, so without this a
      // medal earned on this exact board stays uncolored until a hard reload.
      // Never true for a rehearsal (board.rehearsal set): it isn't a real
      // tournament board, so this would just be a wasted /api/me round trip.
      if (board && !board.rehearsal && board.boardNo === board.totalBoards) refresh();
    }
  }, [boardState]);

  // Staged application of server responses: one card at a time on timers so
  // TrickArea can animate each play (see playAnim.ts). Bumping `gen`
  // invalidates any staging still in flight. `resumeStep`, when set, is the
  // one pending action "Trick clearing: tap" is holding open — see
  // scheduleSteps below — and is always cleared alongside `gen` so a stale
  // tap can never resume a sequence that's since been superseded.
  const stagingRef = useRef({ gen: 0, timers: [] as number[], resumeStep: null as (() => void) | null });
  const [awaitingTrickClear, setAwaitingTrickClear] = useState(false);
  const cancelStaging = useCallback(() => {
    stagingRef.current.gen++;
    stagingRef.current.timers.forEach(clearTimeout);
    stagingRef.current.timers = [];
    stagingRef.current.resumeStep = null;
    setAwaitingTrickClear(false);
  }, []);
  useEffect(() => cancelStaging, [cancelStaging]);

  // Schedules an already-computed steps array on timers. Split out of
  // applyBoard so runClaim (below) can compute stageClaimSteps exactly once
  // and reuse the same array both to schedule the animation and to sum its
  // total duration — computing it twice risked the two copies disagreeing
  // (e.g. after a future edit to one call site) about how long the
  // fast-forward actually takes.
  //
  // "Trick clearing: tap" (trickClearMode) turns exactly one step's timer
  // into an indefinite wait: the step playAnim.ts marks `holdForClear` (the
  // completed trick sweeping away) is held until clearHeldTrick fires,
  // instead of firing after its own delayBefore. Everything before and after
  // that one step keeps the ORIGINAL batch-scheduled timing (every timer set
  // up front from a shared zero point) — runSegment below is byte-for-byte
  // what this function always did, just runnable on a slice of the array —
  // so 'auto' mode (holdIndex always -1) and any steps array with no held
  // trick (bidding, claims — see holdForClear's doc comment) are completely
  // untouched by this split.
  const scheduleSteps = useCallback(
    (prev: BoardView, steps: StagedStep[]) => {
      cancelStaging();
      const gen = stagingRef.current.gen;
      let priorTrick = prev.currentTrick ?? [];

      const runSegment = (segment: StagedStep[], onSegmentDone: () => void) => {
        if (!segment.length) {
          onSegmentDone();
          return;
        }
        let at = 0;
        segment.forEach((step, i) => {
          const curTrick = step.view.currentTrick ?? [];
          // the one new card this step adds to the trick in progress, if any
          // (a trick boundary resets currentTrick to [], not a new play)
          const newPlay = curTrick.length > priorTrick.length ? curTrick[curTrick.length - 1] : null;
          priorTrick = curTrick;
          const apply = () => {
            if (stagingRef.current.gen !== gen) return;
            // fills in the flight origin for a card that was never tapped
            // (auto-play, or any card in a claim) but is still sitting in a
            // visible fan — see captureFanOriginIfVisible's docstring
            if (newPlay) captureFanOriginIfVisible(step.view, newPlay);
            setBoard(step.view);
            if (i === segment.length - 1) onSegmentDone();
          };
          at += step.delayBefore;
          if (at === 0) {
            apply();
            return;
          }
          const id = window.setTimeout(() => {
            if (stagingRef.current.gen === gen) apply();
          }, at);
          stagingRef.current.timers.push(id);
        });
      };

      const runFrom = (rest: StagedStep[]) => {
        if (!rest.length || stagingRef.current.gen !== gen) return;
        const holdIndex = trickClearMode === 'tap' ? rest.findIndex((s) => s.holdForClear) : -1;
        if (holdIndex === -1) {
          runSegment(rest, () => {});
          return;
        }
        const before = rest.slice(0, holdIndex);
        const holdStep = rest[holdIndex];
        const after = rest.slice(holdIndex + 1);
        runSegment(before, () => {
          const curTrick = holdStep.view.currentTrick ?? [];
          const newPlay = curTrick.length > priorTrick.length ? curTrick[curTrick.length - 1] : null;
          priorTrick = curTrick;
          stagingRef.current.resumeStep = () => {
            if (stagingRef.current.gen !== gen) return;
            if (newPlay) captureFanOriginIfVisible(holdStep.view, newPlay);
            setBoard(holdStep.view);
            setAwaitingTrickClear(false);
            runFrom(after);
          };
          setAwaitingTrickClear(true);
        });
      };

      runFrom(steps);
    },
    [cancelStaging, trickClearMode],
  );

  // The trick area's tap target while "Trick clearing: tap" is holding a
  // completed trick open — see scheduleSteps above. A no-op the rest of the
  // time (resumeStep is null under 'auto' mode, and between tricks).
  const clearHeldTrick = useCallback(() => {
    const resume = stagingRef.current.resumeStep;
    if (!resume) return;
    stagingRef.current.resumeStep = null;
    resume();
  }, []);

  // `shown` is the optimistic view submitCard already put on screen (see
  // there), with the timestamp it went up. `prev` stays the PRE-TAP view
  // either way, so the staging functions compute exactly what they always
  // computed; trimStagedPrefix then drops the one step the screen is
  // already showing and charges the wait against the next one's delay.
  //
  // Which staging a response gets: a claim is its own thing; otherwise a
  // response that STARTED in the auction goes through stageBidSteps, which
  // owns the whole bidding-phase composition (the robots' calls, and the
  // hand-off into play when the auction ends) and falls through to
  // stagePlaySteps when there are no new calls to reveal. Only a card play
  // ever has an optimistic view on screen, so the bid branch never trims.
  const applyBoard = useCallback(
    (prev: BoardView | null, next: BoardView, shown?: { view: BoardView; at: number } | null) => {
      // "Trick clearing: tap" holds on a real user action, not on animation —
      // unlike every other staged sequence here, it must not go inert under
      // prefers-reduced-motion/no-WAAPI (motionOK() false), the same
      // reasoning CLAIM_ANNOUNCE_HOLD_MS/CLAIM_LEAD_SETTLE_MS already apply to
      // the claim announcement. Without this clause, `staged` below would
      // stay [] whenever motion is off and the trick would clear the instant
      // the response landed — silently undoing the whole setting for exactly
      // the population likeliest to want a deliberate pause. Scoped to
      // ordinary play only (matching what actually carries holdForClear —
      // see its doc comment): bidding and claims keep their untouched,
      // motion-gated behavior.
      const ordinaryPlay = prev !== null && !next.claimed && prev.state !== 'bidding';
      const holdsOnTapWithoutMotion = trickClearMode === 'tap' && ordinaryPlay;
      const staged =
        prev && (motionOK() || holdsOnTapWithoutMotion)
          ? next.claimed
            ? // Both entry points that can receive a claimed response
              // (submitCall, submitCard) hand it to runClaim, so this branch
              // is only runClaim's OWN fallback for when planClaim couldn't
              // read the response. Those are the same conditions
              // stageClaimSteps guards on, so it emits nothing and the board
              // jumps — which is the intent. It keeps the table-pace default
              // deliberately: there is no announcement to pace against here.
              stageClaimSteps(prev, next)
            : prev.state === 'bidding'
              ? stageBidSteps(prev, next)
              : stagePlaySteps(prev, next)
          : [];
      // A claim is left alone: runClaim owns that sequence, its own beats
      // already separate the tap from the fast-forward, and whichever step
      // comes first — the lead's, or the tail's when there is no lead —
      // re-applies the optimistic card harmlessly. The cost of not trimming
      // there is that the step AFTER it starts its gap from the response
      // rather than from when the card appeared, i.e. the claim's first beat
      // runs about a round trip long. Accepted rather than threaded through:
      // that sequence is already paced by a 2s announcement hold.
      let steps = shown && !next.claimed ? trimStagedPrefix(staged, shown.view, Date.now() - shown.at) : staged;
      // No WAAPI/motion to animate the rest of the burst with — collapse
      // every OTHER delay to 0 so it lands as fast as a render allows, and
      // leave the held step itself alone: scheduleSteps gates it on a tap
      // regardless of its numeric delay, so this is the only change needed
      // to make the rest of the sequence feel instant. A no-op whenever
      // `steps` has no holdForClear step (nothing here changes the final
      // state, only how many synchronous renders it takes to reach it).
      if (!motionOK()) steps = steps.map((step) => (step.holdForClear ? step : { ...step, delayBefore: 0 }));
      if (!steps.length) {
        cancelStaging();
        setBoard(next);
        return;
      }
      // The trimmed list is relative to what is ON SCREEN, so origin capture
      // (scheduleSteps' newPlay) has to diff against that, not against prev.
      scheduleSteps(shown?.view ?? prev!, steps);
    },
    [cancelStaging, scheduleSteps, trickClearMode],
  );

  // Bracket a claim in three beats. First the LEAD: the newly-completed
  // tricks that aren't part of the guaranteed run — in practice the trick
  // that was already in progress when this request went out, which either
  // side can still win — replay at ordinary table pace, exactly as they
  // would have without a claim. Announcing over them was the bug: you play
  // the card that wins a trick, and before the trick is finished or paid a
  // modal says "E/W CLAIM" over it. Then the ClaimOverlay holds the board for
  // CLAIM_ANNOUNCE_HOLD_MS (tap/click/Escape dismisses early, via
  // claimSkipRef/skipClaimAnnouncement above) — nothing else on the board is
  // moving while it's up, which is the whole point of the overlay. Then the
  // tail plays out, paced per the "Fast forward settled tricks" setting,
  // before handing off to the real (state: 'done') `next` view.
  //
  // Only the tail is animation: the lead's final view and the announcement
  // hold both apply whether or not motion is on, since a reduced-motion
  // player still needs the board to agree with the modal covering it and
  // still deserves a deliberate, dismissible read of the news.
  //
  // A tap during the lead deliberately skips nothing — claimSkipRef is only
  // armed while the announcement is up, there's no affordance offering a
  // skip before then, and skipping would jump the very trick this exists to
  // show.
  const runClaim = useCallback(
    async (prev: BoardView, next: BoardView) => {
      const motion = motionOK();
      const plan = planClaim(prev, next, { fast: true, motion });
      if (!plan) {
        applyBoard(prev, next); // data didn't line up — fall back to a plain (unanimated) jump
        return;
      }
      const gen = ++claimGenRef.current;

      // beat one: pay the trick in progress before saying anything about it
      if (plan.lead.length) {
        const settled = plan.lead[plan.lead.length - 1].view;
        if (motion) {
          scheduleSteps(prev, plan.lead);
          await sleep(totalDuration(plan.lead));
        } else {
          cancelStaging();
          setBoard(settled);
        }
        if (claimGenRef.current !== gen) return;
        await sleep(CLAIM_LEAD_SETTLE_MS); // let the tally stamp land
        if (claimGenRef.current !== gen) return;
      }

      // beat two: the announcement. claimInfo is set only now — non-null, it
      // blanks PlayPhase's board hint for the whole sequence, and during the
      // lead that hint should read like any other robot burst.
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

      // beat three: the fast-forward itself, always at the compressed pace.
      // Whether a settled tail is fast-forwarded AT ALL is the settings gate's
      // "Settled tricks" (users.auto_claim), and it is answered on the server
      // — a board that reaches here was already claimed, so its cards were
      // played before this response arrived. A player who opted out never
      // gets one. Scheduled against whatever is actually on
      // screen, so scheduleSteps' new-card diff (and with it the fan flight
      // origin for the human's own next card) starts from the right trick.
      if (plan.tail.length) {
        const tailPrev = plan.lead.length ? plan.lead[plan.lead.length - 1].view : prev;
        scheduleSteps(tailPrev, plan.tail);
        await sleep(totalDuration(plan.tail));
        if (claimGenRef.current !== gen) return;
      }

      setClaimInfo(null);
      cancelStaging();
      setBoard(next);
    },
    [applyBoard, cancelStaging, scheduleSteps],
  );

  // Refetch this board's true position after a refused play, leaving the
  // notice up until it lands. Deliberately NOT load(): that blanks the board
  // to a spinner and resets the screen, and there is nothing here worth
  // resetting — the player keeps looking at the (locked) position they had
  // while the real one is on its way, so the board doesn't jump to Loading
  // and back for what is usually one round trip.
  const resync = useCallback(() => {
    cancelStaging();
    const gen = stagingRef.current.gen;
    const noticeShownAt = Date.now();
    // Hold the notice for its full read before anything replaces it (see
    // RESYNC_MIN_NOTICE_MS). Measured from when the notice went up rather
    // than from when the response landed, so a slow refetch spends the beat
    // instead of adding to it. The gen is re-checked on the far side the same
    // way runClaim re-checks claimGenRef across its own hold — navigating
    // away mid-beat must not paint this board over the next one.
    const afterHold = async (apply: () => void) => {
      if (stagingRef.current.gen !== gen) return; // navigated away mid-resync
      const remaining = RESYNC_MIN_NOTICE_MS - (Date.now() - noticeShownAt);
      if (remaining > 0) await sleep(remaining);
      if (stagingRef.current.gen !== gen) return;
      apply();
    };
    api
      .board(tournamentId, boardNo)
      .then((fresh) =>
        afterHold(() => {
          setBoard(fresh);
          setPlayNotice(null);
        }),
      )
      .catch((e) =>
        // the board itself won't load — that IS the "there is no board" case.
        // Held too: replacing the notice instantly would leave the player
        // with an error screen and no idea a resync had been attempted.
        afterHold(() => setError((e as Error).message)),
      );
  }, [tournamentId, boardNo, cancelStaging]);

  const load = useCallback(() => {
    cancelStaging();
    claimGenRef.current++;
    rejectStreakRef.current = 0;
    setBoard(null);
    setSelectedCall(null);
    setSelectedCard(null);
    setLastEval(null);
    setInspect(null);
    setError(null);
    setPlayNotice(null);
    setShowReceipt(false);
    setClaimInfo(null);
    setClaimAnnounceOpen(false);
    setAuctionReserve(0);
    claimSkipRef.current = null;
    sawLiveRef.current = false;
    // Everything past the await belongs to the board this load was started
    // for. Board.tsx stays MOUNTED across a board change (the route params
    // change and load() refetches into the same component), so the same
    // staging generation submitCard uses to answer "is this still my board?"
    // answers it here too — all the more so now that a load can SCHEDULE
    // timers, where a stale response would otherwise cancel the new board's
    // staging and then reveal the old board's auction over it.
    const gen = stagingRef.current.gen;
    const stillMyBoard = () => stagingRef.current.gen === gen;
    api
      .board(tournamentId, boardNo)
      .then((fresh) => {
        if (!stillMyBoard()) return;
        // The calls the robots made before this board was ever opened get the
        // same one-at-a-time reveal as the ones they make in reply — see
        // stageOpeningBids, which returns [] for anything that isn't a fresh
        // arrival in the auction (and motionOK() gates it like every other
        // staged sequence).
        const steps = motionOK() ? stageOpeningBids(fresh) : [];
        if (!steps.length) {
          setBoard(fresh);
          return;
        }
        // fresh.auction.length is the tray this reveal is building toward —
        // known upfront, so the tray can already be at that height before
        // the first call lands. See AuctionGrid's reserveThrough.
        setAuctionReserve(fresh.auction.length);
        scheduleSteps(steps[0].view, steps);
      })
      .catch((e) => {
        if (stillMyBoard()) setError(e.message);
      });
  }, [tournamentId, boardNo, cancelStaging, scheduleSteps]);
  useEffect(load, [load]);

  const submitCall = async (call: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const { evaluation, board: next } = await api.call(tournamentId, boardNo, call);
      setLastEval(evaluation);
      setSelectedCall(null);
      setInspect(null);
      // A call can end the auction on a position that is settled from the
      // very first card — a total laydown — in which case the response comes
      // back already claimed, exactly as a card play's can. Dispatch it the
      // same way submitCard does: runClaim owns the three beats (pay the
      // trick, announce, fast-forward), and routing it through applyBoard
      // instead would replay the tail at table pace with no ClaimOverlay at
      // all, which is the bug this clause exists to close. Otherwise: stage
      // the robots' replies one at a time, and the opening lead if the
      // auction just ended.
      if (next.claimed && board) await runClaim(board, next);
      else applyBoard(board, next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      // Awaiting runClaim above holds `busy` for the whole claim sequence,
      // which is what submitCard already does and is right here too: the
      // board is finished, so there is nothing left to keep unlocked.
      // Otherwise deliberately NOT awaited past the scheduling. The
      // bid box is still ON SCREEN through the reveal — that is the whole
      // point of the `waiting` treatment — so what makes releasing `busy`
      // safe here is that every staged snapshot carries myTurn: false, which
      // is exactly what BidBox reads to lock every control it owns. Remove
      // `waiting`, or the dock condition that keeps the box mounted, and
      // this needs revisiting.
      setBusy(false);
    }
  };

  const submitCard = async (card: number) => {
    if (busy) return;
    setBusy(true);
    // Put the tapped card on the table NOW rather than after the round trip.
    // The server already ruled it legal (it came from legalCards) and is
    // deterministic about where it lands, so there is nothing to wait for to
    // draw it — what the response actually carries is the robots' replies,
    // which stagePlaySteps holds back a beat anyway. optimisticPlayView
    // returns null for anything it can't predict with certainty, and then
    // this whole path is byte-for-byte the old one.
    //
    // The view it returns is a locked one (myTurn false, no legalCards), so
    // the fans go non-interactive and the auto-play effect stays parked for
    // the same reasons they do during an ordinary staged robot burst — a
    // second tap can't land on a card that is already in flight.
    const preTap = board;
    const optimistic = preTap ? optimisticPlayView(preTap, card) : null;
    let shown: { view: BoardView; at: number } | null = null;
    if (optimistic) {
      // HandFan (or the auto-play timer) captured this card's flight origin
      // before calling in, so TrickArea still glides it from the fan.
      cancelStaging();
      setBoard(optimistic);
      setSelectedCard(null);
      shown = { view: optimistic, at: Date.now() };
    }
    // Everything past the await belongs to the board this tap was made on,
    // and `preTap`/`shown` are closed over from that render. Board.tsx stays
    // MOUNTED across a board change — the route params change and load()
    // refetches into the same component — so a response landing after that
    // must not paint this board over the one now on screen. load() bumps the
    // staging generation on its way in (so does unmount), exactly as it
    // already invalidates in-flight staged timers, so that same counter
    // answers "is this still my board?". Read after the optimistic
    // cancelStaging() above, which bumps it itself.
    const gen = stagingRef.current.gen;
    const stillMyBoard = () => stagingRef.current.gen === gen;
    try {
      const { board: next } = await api.playCard(tournamentId, boardNo, card);
      if (!stillMyBoard()) return;
      setSelectedCard(null);
      setLastEval(null);
      setPlayNotice(null);
      rejectStreakRef.current = 0;
      if (next.claimed && preTap) {
        await runClaim(preTap, next);
      } else {
        applyBoard(preTap, next, shown); // plays out card-by-card, then unlocks input
      }
    } catch (e) {
      // Scoped the same way, and for the same reason the success path is: a
      // failure on the board you left is not news on the board you are
      // looking at now. (Before the optimistic render this path only ever
      // called setError, so the rollback below is the new reason to care.)
      if (!stillMyBoard()) return;
      // The optimistic card was never real — put the pre-tap board back
      // before surfacing the error, so nothing downstream (a retry, a
      // reload, the receipt) can read a fabricated position. A rejection
      // here is a genuine race (a second tab's play landing first, 409 from
      // submitPlay's board lock), not just a network fault.
      // No board to say it over means the tap raced a reload, and the lobby
      // route is all that's left to offer.
      if (!preTap) {
        setError((e as Error).message);
        return;
      }
      // The optimistic card was never real, and neither is the pre-tap
      // position any more (see playNotice above) — so put the position back
      // but LOCKED, exactly as a staged snapshot is locked, so nothing can be
      // tapped against a trick the server has already moved past. The real
      // one replaces it when the resync lands.
      cancelStaging();
      setBoard({ ...preTap, myTurn: false, legalCards: undefined });
      setSelectedCard(null);
      rejectStreakRef.current += 1;
      if (rejectStreakRef.current >= RESYNC_ATTEMPT_LIMIT) {
        setPlayNotice({ message: RESYNC_STUCK_MESSAGE, stuck: true });
        return;
      }
      setPlayNotice({ message: RESYNC_MESSAGE });
      resync();
    } finally {
      setBusy(false);
    }
  };

  // A forced move (exactly one legal card) plays itself after a short delay,
  // so the human can see it happen without needing to tap it — this simulates
  // the same "second tap" a manual play would trigger, so it reuses the whole
  // submitCard/applyBoard pipeline unchanged. Cancelled by the effect cleanup
  // whenever board/selectedCard/busy/playError change — a manual tap, a
  // fresher server response (including intermediate staged snapshots, which
  // always set legalCards: undefined), or unmount all naturally invalidate
  // the timer.
  //
  // playNotice parks it, and that guard is load-bearing rather than tidy: a
  // rejected forced play would otherwise leave this effect firing at the
  // locked pre-tap view's expense, and once the resync lands on a genuinely
  // forced position it fires again — which is right, and is exactly why
  // rejectStreakRef bounds how many times that can go around.
  useEffect(() => {
    if (!board || board.state !== 'playing' || !board.myTurn || busy || playNotice) return;
    const legal = board.legalCards;
    if (!legal || legal.length !== 1 || selectedCard !== null) return;
    const card = legal[0];
    const id = window.setTimeout(() => {
      captureFanOriginIfVisible(board, { seat: board.handToPlay ?? board.playingSeat ?? 2, card });
      submitCard(card);
    }, AUTO_PLAY_DELAY_MS);
    return () => clearTimeout(id);
  }, [board, selectedCard, busy, playNotice]);

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
    <div className={`board-page${board.state === 'bidding' ? ' bidding-dock' : ''}`}>
      <BoardHead board={board} vulPulse={vulPulseKey === `${tournamentId}:${board.boardNo}`} />
      {board.state === 'done' ? (
        board.rehearsal ? (
          // Never a toll receipt — this was never going to be tolled. Also
          // never the ordinary Result: matchpoints() gives a placeholder
          // pct against a field of exactly one (nobody else ever plays a
          // rehearsal tournament), which would be a meaningless number to
          // show. Shown on live completion AND on a later reload alike —
          // unlike showReceipt below, there is no "field view" to fall
          // through to afterward.
          <AdjustedReceipt
            board={board}
            onTryAnotherLine={() => {
              const rr = board.rehearsal!;
              api
                .rehearse(rr.originTournamentId, rr.originBoardNo, rr.branchPly)
                .then((next) => navigate(`/t/${next.tournamentId}/b/${next.boardNo}`))
                .catch((e) => setError((e as Error).message));
            }}
            onBackToAnalyze={() => navigate(`/t/${board.rehearsal!.originTournamentId}/b/${board.rehearsal!.originBoardNo}/analyze`)}
          />
        ) : showReceipt ? (
          <ScoreReceipt
            board={board}
            onContinue={() => setShowReceipt(false)}
            analyzeHref={betaFeatures ? `/t/${tournamentId}/b/${board.boardNo}/analyze` : undefined}
          />
        ) : (
          <Result
            board={board}
            onReceipt={() => setShowReceipt(true)}
            actions={
              <>
                <Button
                  onClick={() =>
                    board.boardNo < board.totalBoards
                      ? navigate(`/t/${tournamentId}/b/${board.boardNo + 1}`)
                      : navigate(`/t/${tournamentId}`)
                  }
                >
                  {board.boardNo < board.totalBoards
                    ? `NEXT BOARD — ${board.boardNo + 1} OF ${board.totalBoards} →`
                    : 'TOURNAMENT SUMMARY →'}
                </Button>
                {/* the Tournament ledger's old promise, finally kept — the
                    review lives at its own route; the Result carries only
                    this door (no analysis data outside the Analyze screen).
                    Still in beta — see the betaFeatures note above. */}
                {betaFeatures ? (
                  <Button variant="secondary" to={`/t/${tournamentId}/b/${board.boardNo}/analyze`}>
                    Analyze play →
                  </Button>
                ) : null}
                <Button variant="secondary" to="/">
                  Back to lobby
                </Button>
              </>
            }
          />
        )
      ) : board.state === 'playing' ? (
        <PlayPhase
          board={board}
          lastEval={bidFeedback ? lastEval : null}
          selectedCard={selectedCard}
          playNotice={playNotice}
          onReloadBoard={load}
          onSelectCard={(c) => (selectedCard === c ? submitCard(c) : setSelectedCard(c))}
          inspect={inspect}
          onInspect={(e) => setInspect(e === inspect ? null : e)}
          claimInfo={claimInfo}
          claimAnnounceOpen={claimAnnounceOpen}
          onSkipClaim={skipClaimAnnouncement}
          awaitingTrickClear={awaitingTrickClear}
          onClearTrick={clearHeldTrick}
        />
      ) : (
        <BiddingPhase
          board={board}
          lastEval={bidFeedback ? lastEval : null}
          selectedCall={selectedCall}
          onSelectCall={(c) => (doubleTapBid && selectedCall === c ? submitCall(c) : setSelectedCall(c))}
          onConfirm={() => selectedCall !== null && submitCall(selectedCall)}
          busy={busy}
          inspect={inspect}
          onInspect={(e) => setInspect(e === inspect ? null : e)}
          auctionReserve={auctionReserve}
          doubleTapBid={doubleTapBid}
        />
      )}
      {/*
        PlayPhase renders the ClaimOverlay for the ordinary case, and keeps
        doing so — it is exported and Tour/Analyze mount it through useReplay,
        so the overlay cannot simply move up here. This is the case PlayPhase
        cannot cover: a claim announced while the board is NOT in the play
        phase. That happens when the response to a CALL comes back already
        claimed — the auction ends on a position settled from the first card —
        because runClaim holds `prev` (a bidding view) on screen until the very
        end. Without this the announcement had nowhere to render and the board
        jumped from the auction straight to the toll receipt, with nothing to
        say why the player had stopped being asked for cards.
      */}
      {board.state !== 'playing' && claimAnnounceOpen && claimInfo ? (
        <ClaimOverlay info={claimInfo} onDismiss={skipClaimAnnouncement} />
      ) : null}
      {inspect ? <CallInspector entry={inspect} onClose={() => setInspect(null)} /> : null}
    </div>
  );
}

/**
 * Compact ticket header: mini stub, tournament context, vul chip (or SCORED
 * stamp). A rehearsal (board.rehearsal set) is the ONE thing that changes
 * this screen from an ordinary live board — everything below this header,
 * PlayPhase/BiddingPhase included, is untouched. Two swaps: the name slot
 * reads "REHEARSAL — Board N, from Trick M" instead of the tournament name,
 * and the right-hand slot trades the vulnerability chip for an END action
 * (live play has nowhere to go mid-board; a rehearsal does, since leaving
 * loses nothing — it persists, resumable from Analyze's history surfaces).
 */
function BoardHead({ board, vulPulse }: { board: BoardView; vulPulse: boolean }) {
  const vul = vulLabel(board.vul).toUpperCase();
  const r = board.rehearsal;
  return (
    <div className="board-head">
      <TicketStub label="BOARD" value={`${board.boardNo} of ${board.totalBoards}`} edgeText="ADMIT" width={92} />
      <div className="board-head-mid">
        <div className="board-head-name">
          {r ? `REHEARSAL — Board ${board.boardNo}, from Trick ${Math.floor(r.branchPly / 4) + 1}` : board.tournamentName}
        </div>
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
        <InkStamp rotate={-4} color={r ? 'var(--muted)' : undefined}>
          {r ? 'REHEARSAL' : 'SCORED'}
        </InkStamp>
      ) : r ? (
        <Button variant="secondary" to={`/t/${r.originTournamentId}/b/${r.originBoardNo}/analyze`} className="board-head-end">
          END
        </Button>
      ) : (
        <Chip
          color={board.vul.ns ? 'var(--suit-h)' : undefined}
          quiet={!board.vul.ns && !board.vul.ew}
          className={`board-vul${vulPulse ? ' board-vul-pulse' : ''}`}
        >
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

/** Exported for the first-crossing tour (pages/Tour.tsx), which replays a
 * captured practice board through these exact phases — same components, same
 * classes, same behavior — with scripted transitions instead of API calls. */
export function BiddingPhase({
  board,
  lastEval,
  selectedCall,
  onSelectCall,
  onConfirm,
  busy,
  inspect,
  onInspect,
  hint = null,
  auctionReserve = 0,
  doubleTapBid = false,
}: {
  board: BoardView;
  lastEval: BidEval | null;
  selectedCall: number | null;
  onSelectCall: (call: number) => void;
  onConfirm: () => void;
  busy: boolean;
  inspect: AuctionEntry | null;
  onInspect: (entry: AuctionEntry) => void;
  /** tour only: pulse this call in the bid box */
  hint?: number | null;
  /** see AuctionGrid's reserveThrough — the tour's captured board never needs it (no pre-existing calls precede its human-dealt opening) */
  auctionReserve?: number;
  /** does a second tap on the selected call actually submit it here? Only used to pick the placeholder's copy — the caller still owns the real gating logic in onSelectCall. */
  doubleTapBid?: boolean;
}) {
  const meanings = board.legalCallMeanings ?? {};
  // The height-changing feedback — the selected call's meaning, the grade of your
  // last bid, or the placeholder — sizes to its own content (no reserved slot).
  // It stays stable-feeling because the bid box is DOCKED: the auction + feedback
  // + hand live in a scroll region and the bid box sits in a fixed dock at the
  // foot, so the controls never move no matter how tall the feedback grows. The
  // decision cluster (feedback, hand, seat line) is pinned to the bottom of the
  // scroll region (margin-top:auto), hugging the dock; the auction stays up top.
  const feedback = board.myTurn ? (
    selectedCall !== null ? (
      <MeaningPanel meaning={meanings[selectedCall]} call={selectedCall} prefix="Your" />
    ) : lastEval ? (
      <GradeToast evaluation={lastEval} />
    ) : (
      <MeaningPanel placeholder doubleTapBid={doubleTapBid} />
    )
  ) : lastEval ? (
    <GradeToast evaluation={lastEval} />
  ) : null;

  return (
    <div className="bid-phase">
      <div className="bid-scroll">
        <AuctionGrid
          auction={board.auction}
          dealer={board.dealer}
          myTurn={Boolean(board.myTurn)}
          live
          onInspect={onInspect}
          reserveThrough={auctionReserve}
        />
        <div className="bid-decision">
          {feedback}
          <div className="board-fan">
            <HandFan cards={displaySort(board.hand)} />
          </div>
          <SeatLine label="SOUTH · YOU" hcp={board.hcp} />
        </div>
      </div>
      <div className="bid-dock">
        {/* The box stays docked through the robots' staged replies, locked
            rather than swapped out: it sizes the dock, and the decision
            cluster above hugs the dock's top edge, so anything shorter here
            slides the hand and feedback down the screen and back on every
            turn. The bare notice is for a server view that genuinely has no
            calls to show — nothing to render a box from. */}
        {board.myTurn || board.legalCalls?.length ? (
          <BidBox
            legalCalls={board.legalCalls ?? []}
            selected={selectedCall}
            onSelect={onSelectCall}
            onConfirm={onConfirm}
            busy={busy}
            waiting={!board.myTurn}
            hint={hint}
          />
        ) : (
          <div className="notice">Robots are thinking…</div>
        )}
      </div>
    </div>
  );
}

/** Exported for the first-crossing tour — see BiddingPhase above. */
export function PlayPhase({
  board,
  lastEval,
  selectedCard,
  onSelectCard,
  inspect,
  onInspect,
  claimInfo,
  claimAnnounceOpen,
  onSkipClaim,
  playNotice = null,
  onReloadBoard,
  hint = null,
  awaitingTrickClear = false,
  onClearTrick = () => {},
}: {
  board: BoardView;
  lastEval: BidEval | null;
  selectedCard: number | null;
  onSelectCard: (card: number) => void;
  inspect: AuctionEntry | null;
  onInspect: (entry: AuctionEntry) => void;
  claimInfo: ClaimAnnouncement | null;
  claimAnnounceOpen: boolean;
  onSkipClaim: () => void;
  /** a rejected play, said over the locked board — see Board's playNotice */
  playNotice?: PlayNotice | null;
  onReloadBoard?: () => void;
  /** tour only: pulse this card in whichever fan holds it */
  hint?: number | null;
  /** "Trick clearing: tap" is holding a completed trick on the table — see
   * Board.tsx's scheduleSteps. Always false for the tour, which never plays
   * this setting. */
  awaitingTrickClear?: boolean;
  /** tap anywhere on the trick area to sweep the held trick — a no-op unless awaitingTrickClear */
  onClearTrick?: () => void;
}) {
  // Bottom fan = the hand the human plays from (South, or North when the
  // board is flipped). Top fan = dummy. Either can be the hand to play.
  const playingSeat = board.playingSeat ?? 2;
  const canPlayFrom = (seat: number | undefined) => Boolean(board.myTurn) && board.handToPlay === seat;

  const dummyLabel = board.dummy !== undefined ? `${SEAT_NAMES[board.dummy]} · DUMMY` : '';
  const bottomLabel = `${SEAT_NAMES[playingSeat]} · YOU`;


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
      {claimAnnounceOpen && claimInfo ? <ClaimOverlay info={claimInfo} onDismiss={onSkipClaim} /> : null}
      {board.dummyHand && !dummyOnSide ? (
        <>
          <SeatLine label={dummyLabel} hcp={board.dummyHcp} active={canPlayFrom(board.dummy)} />
          <div className="board-fan">
            <HandFan
              cards={displaySort(board.dummyHand)}
              legal={canPlayFrom(board.dummy) ? board.legalCards : []}
              selected={selectedCard ?? soleLegal}
              onSelect={canPlayFrom(board.dummy) ? onSelectCard : undefined}
              hint={canPlayFrom(board.dummy) ? hint : null}
            />
          </div>
        </>
      ) : null}
      {board.dummyHand && dummyOnSide ? (
        <div className="play-row">
          {board.dummy === 3 ? (
            <DummyRail seat={board.dummy} cards={board.dummyHand} hcp={board.dummyHcp} side="left" />
          ) : null}
          <TrickArea board={board} awaitingClear={awaitingTrickClear} onClearTap={onClearTrick} />
          {board.dummy === 1 ? (
            <DummyRail seat={board.dummy} cards={board.dummyHand} hcp={board.dummyHcp} side="right" />
          ) : null}
        </div>
      ) : (
        <TrickArea board={board} awaitingClear={awaitingTrickClear} onClearTap={onClearTrick} />
      )}
      <div className="board-fan">
        <HandFan
          cards={displaySort(board.hand)}
          legal={canPlayFrom(playingSeat) ? board.legalCards : []}
          selected={selectedCard ?? soleLegal}
          onSelect={canPlayFrom(playingSeat) ? onSelectCard : undefined}
          hint={canPlayFrom(playingSeat) ? hint : null}
        />
      </div>
      <SeatLine label={bottomLabel} hcp={board.hcp} active={canPlayFrom(playingSeat)} />
      {playNotice ? (
        // Takes the hint slot rather than sitting above it: it displaces
        // "playing automatically…", which the parked auto-play timer is no
        // longer doing, and lands where the player is already looking.
        <div className="notice-error notice-play" role="alert">
          <div>{playNotice.message}</div>
          {/* the aside is the italic-Crimson register every other hint on
              this screen uses */}
          <div className="notice-play-aside">
            {playNotice.stuck
              ? 'Another device may still be playing this board.'
              : 'Fetching the board’s real position…'}
          </div>
          {playNotice.stuck ? (
            <div>
              <Button variant="secondary" onClick={onReloadBoard}>
                Reload the board
              </Button>
            </div>
          ) : null}
        </div>
      ) : awaitingTrickClear ? (
        <div className="board-hint">Tap the trick to continue</div>
      ) : selectedCard !== null ? (
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
      ) : claimInfo ? null : board.myTurn ? ( // suppressed for the whole claim sequence, not just while the overlay is up
        <div className="board-hint">
          your turn{board.handToPlay === board.dummy ? ' — playing from dummy' : ''}
        </div>
      ) : (
        <div className="board-hint">Robots are thinking…</div>
      )}
    </>
  );
}

/**
 * The completed-board Result — hero score, the field, the deal, YOUR BIDDING.
 * Exported for the first-crossing tour, which used to mirror it class-for-
 * class as TourResult because the actions differed (board №0 has no next
 * board); the `actions` slot is what dissolved that copy. `fieldHeading`
 * exists for the same reason (№0 wants its own board label).
 *
 * Deliberately NO analysis data here: MP costs and verdicts render only
 * inside the Analyze screen — the Result carries the door (Analyze play →,
 * threaded through `actions` by Board below) and nothing else.
 */
export function Result({
  board,
  onReceipt,
  actions,
  fieldHeading,
}: {
  board: BoardView;
  onReceipt: () => void;
  actions: ReactNode;
  fieldHeading?: string;
}) {
  const r = board.result!;
  const low = r.pct < 40;
  // House (benchmark AI) rows are full field members — the hero pct is
  // matchpointed against everyone on the board, house included.
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

      <PerforatedPanel heading={fieldHeading ?? `THE FIELD — BOARD ${board.boardNo}`} className="result-field">
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

      <div className="board-actions">{actions}</div>
    </div>
  );
}
