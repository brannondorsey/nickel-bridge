import type { BidEval, BoardView } from '../api';

/**
 * The first-crossing practice board — a full capture of one deal driven
 * through the REAL engine offline by tools/gen_tour_board.mjs (regenerate
 * with that tool; don't hand-edit board0.json). Each step is a human
 * decision point exactly as the server would have served it: `view` is the
 * genuine boardView (redactions, legal calls/cards, SAYC meanings for every
 * legal call), `action` the call/card the tour's line takes, `evaluation`
 * the real Bidder grade for a call. `final` is the completed board with the
 * three benchmark personas already in the field — they genuinely played
 * this deal at their tiers, so the ledger the tour teaches duplicate with
 * is a real matchpoint field.
 *
 * The tour (pages/Tour.tsx) replays these views through Board.tsx's own
 * exported phases; the narration overlay lives in script.ts and is curated
 * by hand against this capture — its guard test fails if the two drift.
 */
export interface TourStep {
  kind: 'call' | 'card';
  view: BoardView;
  /** the scripted line's action at this decision (call number or card number) */
  action: number;
  /** real Bidder.evaluate output — 'call' steps only */
  evaluation?: BidEval;
}

export interface TourBoard {
  seed: string;
  boardNo: number;
  steps: TourStep[];
  final: BoardView;
}

let cache: Promise<TourBoard> | null = null;

/** Lazy-loaded like glossary/deep.json: the ~100KB capture stays out of the
 * main bundle and is fetched only when someone actually enters the tour. */
export function loadTourBoard(): Promise<TourBoard> {
  if (!cache) {
    cache = import('./board0.json')
      .then((m) => m.default as unknown as TourBoard)
      .catch((err) => {
        cache = null; // don't memoize a failed chunk fetch — see glossary/deep.ts
        throw err;
      });
  }
  return cache;
}
