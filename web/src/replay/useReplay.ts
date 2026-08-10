import { useCallback, useEffect, useRef, useState } from 'react';
import { BoardView } from '../api';
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The replay driver: a current BoardView plus the machinery for moving it
 * FORWARD through captured or synthetic views with the live board's own
 * staging — extracted verbatim from the first-crossing tour (pages/Tour.tsx),
 * which proved the shape, so the tour and the Analyze play lens share one
 * copy instead of each growing their own.
 *
 * Three ways to move, and the split is load-bearing:
 *
 *  - transition(prev, next, speed): one decision forward. Dispatches to the
 *    claim sequence when `next` is a claim landing (next.claimed with prev
 *    still in play), else stages the ordinary robot burst via stageBidSteps/
 *    stagePlaySteps — WHICH ASSUME AT MOST ONE TRICK BOUNDARY PER TRANSITION
 *    (playAnim.ts:166). Callers step one decision at a time; anything bigger
 *    must cut().
 *  - runClaim(prev, next): the live board's three claim beats (lead at table
 *    pace, ClaimOverlay hold, sped-up fast-forward), off the shared planClaim
 *    so this copy can't drift from Board.tsx's about which cards belong to
 *    which beat.
 *  - cut(next): timers cleared, claim sequence invalidated, the view simply
 *    replaced. The ONLY legal move for backward steps and jumps: TrickArea
 *    animates by diffing consecutive views (prevRef + WAAPI clones), so a
 *    multi-card jump has nothing coherent to animate, and rewinding through
 *    the stagers would violate their single-boundary assumption. A cut also
 *    reads correctly — stepping back is consulting the record, not replaying
 *    time in reverse.
 */
export function useReplay() {
  const [view, setView] = useState<BoardView | null>(null);

  const timersRef = useRef<number[]>([]);
  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  // Claim state, mirroring Board.tsx's runClaim. claimGenRef invalidates an
  // in-flight sequence (a fresher commit, a cut, or unmount).
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

  /** Schedules already-computed steps on timers; returns the total duration
   *  so runClaim can await it — the same split Board.tsx's scheduleSteps
   *  enables for its own runClaim. */
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
  // announcement (tap/click/Escape via ClaimOverlay, rendered by the caller's
  // PlayPhase), THEN the sped-up fast-forward, before handing off to the real
  // (done) `next` view.
  const runClaim = useCallback(
    async (prev: BoardView, next: BoardView) => {
      const motion = motionOK();
      const plan = planClaim(prev, next, { fast: true, motion });
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
    [applyTransition, scheduleSteps, clearTimers],
  );

  /** One decision forward: the claim sequence when `next` lands a claim, the
   *  ordinary staged burst otherwise. */
  const transition = useCallback(
    (prev: BoardView, next: BoardView, speed = 1) => {
      if (next.claimed && prev.state === 'playing') void runClaim(prev, next);
      else applyTransition(prev, next, speed);
    },
    [applyTransition, runClaim],
  );

  /** Replace the view with no animation — backward steps, jumps, and loads. */
  const cut = useCallback(
    (next: BoardView | null) => {
      clearTimers();
      claimGenRef.current++;
      claimSkipRef.current = null;
      setClaimInfo(null);
      setClaimAnnounceOpen(false);
      setView(next);
    },
    [clearTimers],
  );

  return { view, transition, applyTransition, runClaim, cut, claimInfo, claimAnnounceOpen, skipClaimAnnouncement };
}
