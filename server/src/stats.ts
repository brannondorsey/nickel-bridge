import {
  BidCategory,
  Call,
  Card,
  Contract,
  ConventionFamily,
  Deal,
  ELO_INITIAL,
  Seat,
  Strain,
  Suit,
  bidCategory,
  boardConditions,
  cardRank,
  cardSuit,
  conventionFamily,
  dealBoard,
  explainBid,
  makeCard,
  partnerOf,
  playState,
  trumpSuit,
} from '@bridge/core';
import { db } from './db.js';
import { standings } from './tournaments.js';

const stmtUser = db.prepare(
  `SELECT id, handle, picture, elo, created_at, kind FROM users WHERE id = ? AND handle IS NOT NULL`,
);
// elo_history is wiped and replayed in tournament-id order on every recompute,
// so its rows carry no timestamp — tournament_id IS the rating timeline.
// finished_at (the user's last completed board of the tournament) is only a label.
const stmtEloSeries = db.prepare(
  `SELECT h.tournament_id, h.after, t.name AS tournament_name,
          (SELECT MAX(b.updated_at) FROM boards b
            WHERE b.tournament_id = h.tournament_id AND b.user_id = h.user_id AND b.state = 'done') AS finished_at
   FROM elo_history h JOIN tournaments t ON t.id = h.tournament_id
   WHERE h.user_id = ? ORDER BY h.tournament_id`,
);
// Every board/tournament sweep here excludes demo-mode exhibits
// (tournaments.kind = 'exhibit'): a scenario board someone jumped into must
// not inflate boardsCompleted, chart series, or anyone's percentile pool.
// Inert in production, where every tournament is 'standard'.
const stmtDoneBoards = db.prepare(
  `SELECT b.tournament_id, b.board_no, b.calls, b.plays, b.bid_evals, b.contract, b.tricks_declarer, b.updated_at,
          t.name AS tournament_name, t.seed AS tournament_seed
   FROM boards b JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
   WHERE b.user_id = ? AND b.state = 'done' ORDER BY b.updated_at, b.id`,
);
const stmtRatedElos = db.prepare(
  `SELECT elo FROM users WHERE EXISTS (SELECT 1 FROM elo_history h WHERE h.user_id = users.id)`,
);
// No users.kind filter: the benchmark AI personas (ai-players.ts) are full
// field members — their bid evals belong in the accuracy pool and the
// activePlayers count, same as their scores in everyone's matchpoints.
const stmtAllDoneEvals = db.prepare(
  `SELECT b.user_id, b.bid_evals FROM boards b
   JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
   WHERE b.state = 'done'`,
);
const stmtAllTournamentIds = db.prepare(`SELECT id FROM tournaments WHERE kind = 'standard' ORDER BY id`);
// Contracts across every user, for the "Declaring" percentile row — same
// declaring-side filter (contract.declarer % 2 === 0) applies to every row
// regardless of whose board it is, since every player always sits South.
const stmtAllDoneContracts = db.prepare(
  `SELECT b.user_id, b.contract, b.tricks_declarer FROM boards b
   JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
   WHERE b.state = 'done' AND b.contract IS NOT NULL`,
);

/** plain/over/under-ruff counts for one side (declarer/dummy or defense). */
export interface RuffCounts {
  plain: number;
  over: number;
  under: number;
}

interface StatPoint {
  tournamentId: number;
  tournamentName: string;
  finishedAt: number | null;
}

interface PlayerStats {
  /** kind = 'ai' identifies one of the benchmark house personas (ai-players.ts) */
  user: { id: number; handle: string; picture: string | null; elo: number; createdAt: number; kind: 'human' | 'ai' };
  totals: {
    boardsCompleted: number;
    tournamentsPlayed: number;
    tournamentsCompleted: number;
    ratedTournaments: number;
    currentElo: number;
    peakElo: number;
    avgPct: number | null;
    /** the player's best single-tournament score, from pctSeries; null if pctSeries is empty */
    bestPct: { pct: number; tournamentName: string } | null;
    /** the player's worst single-tournament score, from pctSeries; null if pctSeries is empty */
    worstPct: { pct: number; tournamentName: string } | null;
    avgBidAccuracy: number | null;
    gradeCounts: { excellent: number; good: number; fair: number; poor: number };
    declarer: { boards: number; made: number };
    defense: { boards: number; beat: number };
    passedOut: number;
    /** rating change since the start of the current UTC month; null when unrated */
    monthlyEloDelta: number | null;
  };
  /**
   * Signed histogram of tricks made vs. contract, declaring boards only (same
   * "user's side declared" filter as totals.declarer). delta = tricks_declarer
   * - (6 + contract.level); buckets clip at ±3 ("3+ down"/"3+ over") so one
   * blown slam can't stretch the row scale. avgDelta is the *unclamped* mean
   * across those boards — a true trick-differential figure even though the
   * display buckets saturate. boards === totals.declarer.boards always; kept
   * as its own field so the client doesn't have to cross-reference totals.
   */
  trickDelta: {
    buckets: { delta: -3 | -2 | -1 | 0 | 1 | 2 | 3; count: number }[]; // fixed order, always 7 entries
    boards: number;
    avgDelta: number | null; // null only when boards === 0
  };
  /** "better than N% of players" per metric; null when the player or field lacks data */
  percentiles: {
    elo: number | null;
    avgPct: number | null;
    bidAccuracy: number | null;
    /** declaring-side make-rate percentile — the one new row this batch adds, see stats-page blueprint §4 */
    declaring: number | null;
    ratedPlayers: number;
    activePlayers: number;
    /** size of the declaring-rate comparison pool (players with at least one declaring board) */
    declaringPlayers: number;
  };
  eloSeries: (StatPoint & { elo: number })[];
  pctSeries: (StatPoint & { pct: number; boards: number; fieldSize: number })[];
  accuracySeries: (StatPoint & { accuracy: number | null; calls: number })[];
  /**
   * The player's graded calls bucketed by auction role (see core's
   * bidCategory), ranked best to worst by share of satisfactory-or-better
   * (2+ star, i.e. 'good'/'excellent') calls. Derived entirely from the
   * stored auction + bid_evals — historical boards count the same as new
   * ones. Only buckets the player has actually visited appear.
   */
  bidTypes: { category: BidCategory; total: number; satisfactory: number }[];
  /**
   * The subset of graded calls that were a named SAYC convention (Stayman,
   * Jacoby transfer, Blackwood, Gerber, weak two, negative double, Michaels
   * — see core's conventionFamily), bucketed by which one. A second view
   * onto the same bid_evals as `bidTypes`, along a different axis (named
   * convention, not auction role) — natural bids never appear here. Ranked
   * the same way as bidTypes (best to worst by satisfactory share); only
   * conventions the player has actually called appear.
   */
  conventions: { family: ConventionFamily; total: number; satisfactory: number }[];
  /**
   * Declaring-side contracts only (same population as `totals.declarer`, i.e.
   * boards where contract.declarer is on the human's side, N-S), bucketed two
   * ways: partscore/game/slam tier (contractTier — level 6-7 is always slam;
   * otherwise game at 3NT/4-of-a-major/5-of-a-minor and up, partscore below
   * that) and doubled-or-redoubled (contract.doubled || contract.redoubled
   * collapsed into one bucket — the auction state machine makes the two
   * booleans mutually exclusive, see auction.ts, and redoubled contracts are
   * rare enough on their own that a separate row would mostly read 0/0).
   * `strains` is a pure distribution (not a make-rate) of the same declaring
   * boards by strain family — its three counts sum to `totals.declarer.boards`.
   */
  contractMix: {
    partscore: { boards: number; made: number };
    game: { boards: number; made: number };
    slam: { boards: number; made: number };
    doubled: { boards: number; made: number };
    strains: { notrump: number; major: number; minor: number };
  };
  /**
   * Ruffs made by the player's own hands (South always; North too whenever
   * N-S is the declaring side — see humanControls), classified plain/over/
   * under. Split by which side those hands were playing: declaring
   * (declarer or dummy) vs defending. NT boards contribute nothing.
   */
  ruffs: { declarerDummy: RuffCounts; defense: RuffCounts };
  /**
   * The classic NT hold-up: on notrump boards where the player's side
   * declared, the first time each suit is led by the opposing side, did the
   * player duck a trick they could have won outright with that suit's
   * actual highest remaining card? `taken` counts how many of
   * `opportunities` were ducked.
   */
  holdUps: { opportunities: number; taken: number };
  /**
   * The human's own opening-lead choices — only boards where East declared
   * (see the loop comment above for why). `suits` always has all 4 entries
   * in fixed ♠♥♦♣ order (Card suit convention), count 0 for suits never
   * led, so the client can render a stable 4-row chart without reflow —
   * same fixed-domain-always-present shape as `totals.gradeCounts`, chosen
   * over `bidTypes`'s "only visited buckets appear" precedent because the
   * suit domain here is small and fixed, not open-ended. `style` likewise
   * always has all three keys. Never null; `boards: 0` with all-zero
   * children is the empty state (brand-new player, or one who has simply
   * never faced an East contract yet).
   */
  openingLeads: {
    boards: number;
    suits: { suit: number; count: number }[];
    style: { topOfSequence: number; fourthBest: number; other: number };
  };
  /**
   * Completed boards bucketed by UTC calendar day (the day `updated_at` last
   * flipped to `state = 'done'` — `stmtDoneBoards` already filters on that
   * state, so this is "the day the board was finished," not started), sparse
   * — only days with at least one board appear — ordered ascending by date.
   * Deliberately NOT named "crossings": that word already means a whole
   * tournament elsewhere in the app (Lobby's TOLLS PAID list, the CROSSINGS
   * tab); a single board is a "toll" (see ScoreReceipt's "THE TOLL — BOARD
   * N"), so this field's UI-facing copy says "tolls," not "crossings."
   */
  dailyBoards: { date: string; count: number }[];
}

interface EvalRow {
  grade: 'excellent' | 'good' | 'fair' | 'poor';
  score: number;
}

interface DoneBoardRow {
  tournament_id: number;
  board_no: number;
  calls: string;
  plays: string;
  bid_evals: string;
  contract: string | null;
  tricks_declarer: number | null;
  updated_at: number;
  tournament_name: string;
  tournament_seed: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Standard partscore/game/slam boundary. Level 6-7 is always slam regardless
 * of strain (a slam already implies game); otherwise it's game once the
 * trick score alone would hit 100 — 3NT, 4-of-a-major, or 5-of-a-minor and up
 * (see packages/core/src/score.ts's game-bonus threshold) — partscore below
 * that.
 */
function contractTier(level: number, strain: Strain): 'partscore' | 'game' | 'slam' {
  if (level >= 6) return 'slam';
  const gameLevel = strain === 4 ? 3 : strain === 2 || strain === 3 ? 4 : 5; // NT / major / minor
  return level >= gameLevel ? 'game' : 'partscore';
}

/** Notrump vs. major (♥♠) vs. minor (♣♦) — for the declarer-side strain split. */
function strainFamily(strain: Strain): 'notrump' | 'major' | 'minor' {
  if (strain === 4) return 'notrump';
  return strain === 2 || strain === 3 ? 'major' : 'minor';
}

/** The human always bids from South (game.ts's HUMAN_SEAT). */
const HUMAN_SEAT: Seat = 2;

/** the opening leader is nextSeat(declarer); that's HUMAN_SEAT only when declarer is East */
const EAST: Seat = 1;

/**
 * Duplicated from game.ts's private helper of the same name and same
 * hand-flip rule (see that file's doc comment) — kept local rather than
 * imported so this read-only stats module doesn't pull in game.ts's
 * module-load-time model instantiation. Keep both in sync by hand if the
 * hand-flip rule ever changes.
 */
function humanControls(hand: Seat, contract: Contract): boolean {
  if (hand === HUMAN_SEAT) return true;
  return hand === partnerOf(HUMAN_SEAT) && contract.declarer % 2 === HUMAN_SEAT % 2;
}

/**
 * Reconstructs the full deal + complete trick-by-trick play state for one
 * completed, contract-reaching board — the shared "I need to see actual
 * cards, not just calls/contract/trick-count" path for ruffs/hold-ups (and,
 * later, opening-lead habits). The deal is re-derived on demand from the
 * tournament seed (packages/core's dealBoard), exactly as game.ts's
 * loadBoard() does for live play. Nothing here touches the DDS solver or
 * the robot engine — it only replays cards that were already played and
 * stored — so it can never affect robot determinism (invariant 1).
 */
function reconstructBoardPlay(
  row: DoneBoardRow,
  contract: Contract,
): { deal: Deal; plays: Card[]; ps: ReturnType<typeof playState> } {
  const deal = dealBoard(row.tournament_seed, row.board_no);
  const plays = JSON.parse(row.plays) as Card[];
  const ps = playState(deal, contract, plays);
  return { deal, plays, ps };
}

/**
 * Classifies every ruff made by the player's own hands (South always; North
 * too whenever N-S is the declaring side — humanControls) across one
 * board's completed tricks. Within a trick, the first trump play on a
 * non-trump lead is a plain ruff; any further trump play in the same trick
 * is an over-ruff if it beats the highest trump played so far in that
 * trick, else an under-ruff. Non-human-controlled ruffs still update the
 * trick's running best trump (so a human over/under-ruff against an
 * opponent's earlier ruff classifies correctly) but are never attributed to
 * a bucket. NT contracts (trumpSuit === null) contribute nothing.
 */
export function accumulateRuffs(
  ruffs: { declarerDummy: RuffCounts; defense: RuffCounts },
  contract: Contract,
  completedTricks: { seat: Seat; card: Card }[][],
): void {
  const trump = trumpSuit(contract.strain);
  if (trump === null) return; // NT — no ruffs possible
  for (const trick of completedTricks) {
    const ledSuit = cardSuit(trick[0].card);
    if (ledSuit === trump) continue; // trump led — playing trumps isn't ruffing
    let bestTrumpRank = -1; // highest trump rank played so far THIS trick
    for (const play of trick) {
      if (cardSuit(play.card) !== trump) continue; // following suit or discarding — not a ruff
      const rank = cardRank(play.card);
      const isFirstRuffInTrick = bestTrumpRank < 0;
      const bucket = humanControls(play.seat, contract)
        ? play.seat % 2 === contract.declarer % 2
          ? ruffs.declarerDummy
          : ruffs.defense
        : null;
      if (bucket) {
        if (isFirstRuffInTrick) bucket.plain++;
        else if (rank > bestTrumpRank) bucket.over++;
        else bucket.under++;
      }
      bestTrumpRank = Math.max(bestTrumpRank, rank);
    }
  }
}

/**
 * The classic NT hold-up, scoped to notrump boards where N-S is the
 * declaring side. For each of the four suits, the FIRST trick where that
 * suit is led by the opposing side is the one genuine hold-up opportunity
 * for that suit: if the outright highest still-unplayed card of the suit
 * was in a human-controlled hand (South always; North too, since N-S is
 * declaring — humanControls) at the moment that hand played into the trick,
 * it counts as an opportunity, and as "taken" iff that hand played a lower
 * card of the same suit instead (a duck — following suit is mandatory when
 * held, so "played lower" here always means "chose to duck", never a forced
 * discard).
 */
export function accumulateHoldUps(
  holdUps: { opportunities: number; taken: number },
  deal: Deal,
  contract: Contract,
  completedTricks: { seat: Seat; card: Card }[][],
): void {
  if (contract.strain !== 4 || contract.declarer % 2 !== 0) return; // NT, N-S declaring only
  const ledBefore = new Set<Suit>();
  const played = new Set<Card>();
  for (const trick of completedTricks) {
    const ledSuit = cardSuit(trick[0].card);
    const firstLeadOfSuit = !ledBefore.has(ledSuit);
    ledBefore.add(ledSuit);
    const openedByDefense = trick[0].seat % 2 !== contract.declarer % 2;
    for (const play of trick) {
      if (firstLeadOfSuit && openedByDefense && humanControls(play.seat, contract)) {
        let topRemaining: Card | null = null;
        for (let r = 12; r >= 0; r--) {
          const c = makeCard(ledSuit, r);
          if (!played.has(c)) {
            topRemaining = c;
            break;
          }
        }
        if (topRemaining !== null && deal.hands[play.seat].includes(topRemaining)) {
          holdUps.opportunities++;
          if (play.card !== topRemaining) holdUps.taken++;
        }
      }
      played.add(play.card);
    }
  }
}

type OpeningLeadStyle = 'topOfSequence' | 'fourthBest' | 'other';

/**
 * Classify one opening-lead card against the leader's full pre-play holding
 * in the suit led (ranks only, 0..12 = 2..A, any order). Opening lead is the
 * very first card of the board, so "holding at that point" is just the
 * dealt hand filtered to the led suit — no trick replay needed.
 *
 * "Top of sequence": the led rank's immediate next-lower rank is also held
 * (KQx -> lead K; QJx -> lead Q). Deliberately no honor floor — a low-card
 * run (e.g. leading the 9 from K-J-9-8-x) also counts by this literal
 * definition. Checked first, so it takes priority over "fourth best" on the
 * rare holding where both could apply (e.g. K-Q-J-9-8: leading the 9 is
 * both the 4th-highest card AND sits on top of a 9-8 pair).
 * "Fourth best": the led card is exactly the 4th-highest of a 4+ card
 * holding, and isn't already a sequence lead.
 * Everything else (short-suit leads, MUD, an untouched low card, etc.) is
 * "other" — the catch-all, not a claim about strategy.
 */
export function classifyOpeningLead(ledRank: number, holdingRanks: number[]): OpeningLeadStyle {
  const ranksDesc = [...holdingRanks].sort((a, b) => b - a);
  if (ranksDesc.includes(ledRank - 1)) return 'topOfSequence';
  if (ranksDesc.length >= 4 && ranksDesc[3] === ledRank) return 'fourthBest';
  return 'other';
}

/** share of *other* players this value beats, 0..100; null without a comparison field */
function betterThan(value: number, field: number[]): number | null {
  if (field.length < 2) return null;
  const below = field.filter((v) => v < value).length;
  return Math.round((below / (field.length - 1)) * 100);
}

export function playerStats(userId: number): PlayerStats | null {
  const u = stmtUser.get(userId) as
    | { id: number; handle: string; picture: string | null; elo: number; created_at: number; kind: 'human' | 'ai' }
    | undefined;
  if (!u) return null;

  const eloRows = stmtEloSeries.all(userId) as {
    tournament_id: number;
    after: number;
    tournament_name: string;
    finished_at: number | null;
  }[];
  const eloSeries = eloRows.map((r) => ({
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    finishedAt: r.finished_at,
    elo: r.after,
  }));

  const boards = stmtDoneBoards.all(userId) as DoneBoardRow[];

  const gradeCounts = { excellent: 0, good: 0, fair: 0, poor: 0 };
  const declarer = { boards: 0, made: 0 };
  const defense = { boards: 0, beat: 0 };
  let passedOut = 0;
  const allScores: number[] = [];
  const byTournament = new Map<number, { name: string; finishedAt: number; scores: number[] }>();
  const byBidType = new Map<BidCategory, { total: number; satisfactory: number }>();
  const byConvention = new Map<ConventionFamily, { total: number; satisfactory: number }>();
  const trickDeltaHist = new Map<number, number>(); // clamped delta -> count
  const trickDeltas: number[] = []; // unclamped, for the true average
  const contractMix = {
    partscore: { boards: 0, made: 0 },
    game: { boards: 0, made: 0 },
    slam: { boards: 0, made: 0 },
    doubled: { boards: 0, made: 0 },
    strains: { notrump: 0, major: 0, minor: 0 },
  };
  const ruffs: PlayerStats['ruffs'] = {
    declarerDummy: { plain: 0, over: 0, under: 0 },
    defense: { plain: 0, over: 0, under: 0 },
  };
  const holdUps: PlayerStats['holdUps'] = { opportunities: 0, taken: 0 };
  const leadSuitCounts = [0, 0, 0, 0]; // indexed by Suit: 0=♠ 1=♥ 2=♦ 3=♣
  const leadStyleCounts: Record<OpeningLeadStyle, number> = { topOfSequence: 0, fourthBest: 0, other: 0 };
  let openingLeadBoards = 0;
  const byDay = new Map<string, number>(); // UTC 'YYYY-MM-DD' -> completed-board count

  for (const b of boards) {
    const t = byTournament.get(b.tournament_id) ?? { name: b.tournament_name, finishedAt: 0, scores: [] };
    t.finishedAt = Math.max(t.finishedAt, b.updated_at);
    const evals = JSON.parse(b.bid_evals) as EvalRow[];
    for (const e of evals) {
      gradeCounts[e.grade]++;
      t.scores.push(e.score);
      allScores.push(e.score);
    }
    byTournament.set(b.tournament_id, t);

    const day = new Date(b.updated_at * 1000).toISOString().slice(0, 10); // UTC 'YYYY-MM-DD'
    byDay.set(day, (byDay.get(day) ?? 0) + 1);

    // Re-pair each eval with its auction context: evals are appended one per
    // human call, so the nth eval belongs to the nth call made from the human
    // seat (South). The dealer comes from the standard board rotation, making
    // the whole classification a pure function of the stored auction.
    const calls = JSON.parse(b.calls) as Call[];
    const { dealer } = boardConditions(b.board_no);
    let n = 0;
    for (let i = 0; i < calls.length && n < evals.length; i++) {
      if ((dealer + i) % 4 !== HUMAN_SEAT) continue;
      const e = evals[n++];
      const category = bidCategory(dealer, calls.slice(0, i), calls[i]);
      const bucket = byBidType.get(category) ?? { total: 0, satisfactory: 0 };
      bucket.total++;
      if (e.grade === 'excellent' || e.grade === 'good') bucket.satisfactory++;
      byBidType.set(category, bucket);

      // second axis: which named convention (if any) this call was
      const family = conventionFamily(explainBid(dealer, calls.slice(0, i), calls[i]));
      if (family) {
        const cbucket = byConvention.get(family) ?? { total: 0, satisfactory: 0 };
        cbucket.total++;
        if (e.grade === 'excellent' || e.grade === 'good') cbucket.satisfactory++;
        byConvention.set(family, cbucket);
      }
    }

    const contract = b.contract ? (JSON.parse(b.contract) as Contract) : null;
    if (!contract) {
      passedOut++;
    } else {
      if (contract.declarer % 2 === 0) {
        // the human always sits N-S, so an even declarer seat is the user's side
        declarer.boards++;
        const tricks = b.tricks_declarer ?? 0;
        const made = tricks >= 6 + contract.level;
        if (made) declarer.made++;
        const delta = tricks - (6 + contract.level);
        const clamped = Math.max(-3, Math.min(3, delta));
        trickDeltaHist.set(clamped, (trickDeltaHist.get(clamped) ?? 0) + 1);
        trickDeltas.push(delta);

        const tier = contractMix[contractTier(contract.level, contract.strain)];
        tier.boards++;
        if (made) tier.made++;
        if (contract.doubled || contract.redoubled) {
          contractMix.doubled.boards++;
          if (made) contractMix.doubled.made++;
        }
        contractMix.strains[strainFamily(contract.strain)]++;
      } else {
        defense.boards++;
        if ((b.tricks_declarer ?? 0) < 6 + contract.level) defense.beat++;
      }

      // Ruffs/hold-ups/opening-lead all need the actual cards, not just the
      // contract + trick count — reconstruct the deal + full play replay
      // once and feed all three accumulators from it (declaring and
      // defending boards both count for ruffs/opening-lead; hold-ups is
      // declaring-only, gated inside its own accumulator).
      const { deal, plays, ps } = reconstructBoardPlay(b, contract);
      accumulateRuffs(ruffs, contract, ps.completedTricks);
      accumulateHoldUps(holdUps, deal, contract, ps.completedTricks);

      // Opening-lead habits: the human only ever chooses the opening-lead
      // card itself when the opening leader (nextSeat(declarer)) is South —
      // i.e. exactly when East declared. When West declares, North (the
      // human's AI-controlled defensive partner) leads instead; that board
      // is excluded even though the human defends the rest of the hand.
      if (contract.declarer === EAST) {
        const led = plays[0]; // a stored, completed board always has a full play array
        const suit = cardSuit(led);
        leadSuitCounts[suit]++;
        const holdingRanks = deal.hands[HUMAN_SEAT].filter((c) => cardSuit(c) === suit).map(cardRank);
        leadStyleCounts[classifyOpeningLead(cardRank(led), holdingRanks)]++;
        openingLeadBoards++;
      }
    }
  }

  // ordered by the user's play order — their learning timeline
  const tournaments = [...byTournament.entries()].sort((a, b) => a[1].finishedAt - b[1].finishedAt);

  const accuracySeries = tournaments.map(([tid, t]) => ({
    tournamentId: tid,
    tournamentName: t.name,
    finishedAt: t.finishedAt,
    accuracy: t.scores.length ? Math.round(mean(t.scores) * 100) : null,
    calls: t.scores.length,
  }));

  let tournamentsCompleted = 0;
  const pctSeries = tournaments.flatMap(([tid, t]) => {
    const field = standings(tid);
    const mine = field.find((s) => s.userId === userId);
    if (!mine || mine.totalPct === null) return [];
    if (mine.complete) tournamentsCompleted++;
    return [
      {
        tournamentId: tid,
        tournamentName: t.name,
        finishedAt: t.finishedAt,
        pct: mine.totalPct,
        boards: mine.boardsDone,
        // the whole field — house rows are pairs too
        fieldSize: field.length,
      },
    ];
  });

  // Personal-best callouts: a plain min/max reduction over pctSeries, which
  // is already chronological — a strict >/< comparison keeps the earliest
  // tournament on a tie (same tie-break convention as bidTypes' sort below).
  const bestPct = pctSeries.length ? pctSeries.reduce((best, p) => (p.pct > best.pct ? p : best)) : null;
  const worstPct = pctSeries.length ? pctSeries.reduce((worst, p) => (p.pct < worst.pct ? p : worst)) : null;

  const avgPct = pctSeries.length ? round1(mean(pctSeries.map((p) => p.pct))) : null;
  const avgBidAccuracy = allScores.length ? Math.round(mean(allScores) * 100) : null;

  const TRICK_DELTA_BUCKETS = [-3, -2, -1, 0, 1, 2, 3] as const;
  const trickDelta = {
    buckets: TRICK_DELTA_BUCKETS.map((delta) => ({ delta, count: trickDeltaHist.get(delta) ?? 0 })),
    boards: declarer.boards,
    avgDelta: trickDeltas.length ? round1(mean(trickDeltas)) : null,
  };

  // ranked best to worst; ties break toward the larger sample, then alphabetically
  const bidTypes = [...byBidType.entries()]
    .map(([category, counts]) => ({ category, ...counts }))
    .sort(
      (a, b) =>
        b.satisfactory / b.total - a.satisfactory / a.total ||
        b.total - a.total ||
        a.category.localeCompare(b.category),
    );

  const conventions = [...byConvention.entries()]
    .map(([family, counts]) => ({ family, ...counts }))
    .sort(
      (a, b) =>
        b.satisfactory / b.total - a.satisfactory / a.total ||
        b.total - a.total ||
        a.family.localeCompare(b.family),
    );

  const declaringRate = declarer.boards ? Math.round((declarer.made / declarer.boards) * 100) : null;

  const openingLeads = {
    boards: openingLeadBoards,
    suits: leadSuitCounts.map((count, suit) => ({ suit, count })),
    style: leadStyleCounts,
  };

  // 'YYYY-MM-DD' sorts lexically = chronologically, so localeCompare is a
  // plain ascending date sort here.
  const dailyBoards = [...byDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    user: { id: u.id, handle: u.handle, picture: u.picture, elo: u.elo, createdAt: u.created_at, kind: u.kind },
    totals: {
      boardsCompleted: boards.length,
      tournamentsPlayed: byTournament.size,
      tournamentsCompleted,
      ratedTournaments: eloSeries.length,
      currentElo: u.elo,
      peakElo: Math.max(ELO_INITIAL, ...eloSeries.map((e) => e.elo)),
      avgPct,
      bestPct: bestPct ? { pct: bestPct.pct, tournamentName: bestPct.tournamentName } : null,
      worstPct: worstPct ? { pct: worstPct.pct, tournamentName: worstPct.tournamentName } : null,
      avgBidAccuracy,
      gradeCounts,
      declarer,
      defense,
      passedOut,
      monthlyEloDelta: monthlyEloDelta(u.elo, eloSeries),
    },
    trickDelta,
    percentiles: fieldPercentiles(u.elo, eloSeries.length > 0, avgPct, avgBidAccuracy, declaringRate),
    eloSeries,
    pctSeries,
    accuracySeries,
    bidTypes,
    conventions,
    contractMix,
    ruffs,
    holdUps,
    openingLeads,
    dailyBoards,
  };
}

/**
 * Rating change since the start of the current UTC month. The baseline is the
 * rating after the player's last tournament finished before this month (1200
 * when their whole rated history is inside the month); unrated players get
 * null. Like everything Elo here, a full recompute can shift this
 * retroactively — that's the evergreen model, not a bug.
 */
function monthlyEloDelta(currentElo: number, eloSeries: (StatPoint & { elo: number })[]): number | null {
  if (!eloSeries.length) return null;
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  let baseline = ELO_INITIAL;
  for (const p of eloSeries) {
    if (p.finishedAt !== null && p.finishedAt < monthStart) baseline = p.elo;
  }
  return currentElo - baseline;
}

/**
 * Where the player sits in the whole field, per metric. Populations differ on
 * purpose: elo only means something for rated players (which excludes the
 * benchmark AI personas — they never rate), while score/accuracy compare
 * against everyone who has completed at least one board, personas included.
 */
function fieldPercentiles(
  elo: number,
  isRated: boolean,
  avgPct: number | null,
  avgBidAccuracy: number | null,
  declaringRate: number | null,
): PlayerStats['percentiles'] {
  const ratedElos = (stmtRatedElos.all() as { elo: number }[]).map((r) => r.elo);

  // mean bid-eval score per user across all completed boards
  const scoresByUser = new Map<number, number[]>();
  for (const row of stmtAllDoneEvals.all() as { user_id: number; bid_evals: string }[]) {
    const list = scoresByUser.get(row.user_id) ?? [];
    for (const e of JSON.parse(row.bid_evals) as EvalRow[]) list.push(e.score);
    scoresByUser.set(row.user_id, list);
  }
  const accuracies = [...scoresByUser.values()]
    .filter((s) => s.length)
    .map((s) => Math.round(mean(s) * 100));

  // tournament-weighted mean pct per user (any kind — the personas are pool
  // members like everyone else, so betterThan's "everyone but me"
  // denominator is right for every profile, persona pages included), from
  // one standings() pass per tournament
  const pctsByUser = new Map<number, number[]>();
  for (const { id } of stmtAllTournamentIds.all() as { id: number }[]) {
    for (const s of standings(id)) {
      if (s.totalPct === null) continue;
      pctsByUser.set(s.userId, [...(pctsByUser.get(s.userId) ?? []), s.totalPct]);
    }
  }
  const avgPcts = [...pctsByUser.values()].map((p) => round1(mean(p)));

  // declaring-side make-rate per user (same declarer-side filter as
  // totals.declarer — every player always sits South, so it applies row-wise
  // across the whole table, not just for the profile subject)
  const declareByUser = new Map<number, { boards: number; made: number }>();
  for (const row of stmtAllDoneContracts.all() as { user_id: number; contract: string; tricks_declarer: number | null }[]) {
    const contract = JSON.parse(row.contract) as Contract;
    if (contract.declarer % 2 !== 0) continue;
    const rec = declareByUser.get(row.user_id) ?? { boards: 0, made: 0 };
    rec.boards++;
    if ((row.tricks_declarer ?? 0) >= 6 + contract.level) rec.made++;
    declareByUser.set(row.user_id, rec);
  }
  const declareRates = [...declareByUser.values()].map((r) => Math.round((r.made / r.boards) * 100));

  return {
    elo: isRated ? betterThan(elo, ratedElos) : null,
    avgPct: avgPct !== null ? betterThan(avgPct, avgPcts) : null,
    bidAccuracy: avgBidAccuracy !== null ? betterThan(avgBidAccuracy, accuracies) : null,
    declaring: declaringRate !== null ? betterThan(declaringRate, declareRates) : null,
    ratedPlayers: ratedElos.length,
    activePlayers: scoresByUser.size,
    declaringPlayers: declareByUser.size,
  };
}
