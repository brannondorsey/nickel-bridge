import { Card, Contract, Deal, Vulnerability, cardRank, cardSuit, dealToPbn } from '@bridge/core';
import type { DdTableResults, DealPbn, PlayTracePbn, SolvedPlay } from '../vendor/bridge-dds/api.js';
import { SolvePriority } from './dd-pool.js';
import { analysePlayVia, ddTableVia, dealerParVia } from './play-ai.js';
import type { DdTableDealPbn, ParResultsDealer } from '../vendor/bridge-dds/api.js';

/**
 * DDS-facing helpers for the Analyze (post-board review) feature. The raw
 * DDS encodings live HERE, next to the vendored API, so server/src/analyze.ts
 * consumes trick counts and par scores rather than byte layouts. Every one of
 * these encodings is silent when wrong — a mis-mapped vulnerability or a
 * reversed trump order produces plausible-looking numbers — which is why each
 * is pinned by test/analyse.test.ts rather than trusted from the header.
 */

/** our strain (0=♣..4=NT) → DDS trump (0=♠ 1=♥ 2=♦ 3=♣ 4=NT) — same map play-ai.ts uses */
export function ddsTrump(strain: number): number {
  return strain === 4 ? 4 : 3 - strain;
}

/**
 * Vulnerability → DDS encoding. TRAP: DDS order is 0=None 1=BOTH 2=NS 3=EW —
 * `1` is Both, not NS (see vendor/bridge-dds/api.d.ts's Vulnerable const).
 */
export function ddsVul(vul: Vulnerability): number {
  if (vul.ns && vul.ew) return 1;
  if (vul.ns) return 2;
  if (vul.ew) return 3;
  return 0;
}

const SUIT_CHARS = ['S', 'H', 'D', 'C'] as const;
const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

/**
 * A played-card sequence as DDS's PlayTracePbn: two chars per card, suit
 * letter then rank char, NO separators ("D2D5DKD4…"). DDS's buffer is 106
 * bytes, so a full 52-card trace (104 chars) fits with one byte spare.
 */
export function buildPlayTrace(plays: Card[]): PlayTracePbn {
  return { cards: plays.map((c) => SUIT_CHARS[cardSuit(c)] + RANK_CHARS[cardRank(c)]).join('') };
}

/**
 * The AnalysePlayPBN request for a whole board: the full original deal (all
 * 52 cards — dealToPbn's dealer-rotated prefix is accepted unmodified) with
 * the opening leader on play and an empty current trick.
 */
export function buildFullDealRequest(deal: Deal, contract: Contract): DealPbn {
  return {
    trump: ddsTrump(contract.strain),
    first: (contract.declarer + 1) % 4,
    currentTrickSuit: [0, 0, 0],
    currentTrickRank: [0, 0, 0],
    remainCards: dealToPbn(deal),
  };
}

/**
 * The DD trick count around every card of a completed play, in ONE DDS call.
 * The returned array's contract (verified in test/analyse.test.ts, not read
 * off the header — each item is a way to get the review screen wrong):
 *
 *  - length is min(cardsPlayed + 1, 49) — 49 for a full 52-card trace, NOT
 *    53: DDS stops after twelve tricks because the thirteenth is forced, so
 *    the last trick is never analysed (correct — it cannot hold a mistake);
 *  - values are the DECLARING SIDE's total tricks for the whole deal,
 *    absolute — not remaining, not side-to-move: tricks[0] is the DD value
 *    of the contract, tricks[cards] the actual result;
 *  - a change between consecutive entries is one error, attributable to the
 *    player of the card at that index (with DD-optimal play the array is
 *    flat — the self-test canary in analyse.test.ts).
 */
export async function analysePlayTricks(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  priority: SolvePriority = 'interactive',
): Promise<number[]> {
  const res: SolvedPlay = await analysePlayVia(buildFullDealRequest(deal, contract), buildPlayTrace(plays), priority);
  return res.tricks;
}

/**
 * The full 20-problem DD table (5 strains × 4 declarers) for a deal — the
 * slowest DDS call in the app (p50 163ms, p90 576ms, max 780ms measured), so
 * Analyze only requests it for the par stage and caches the result.
 */
export async function calcDdTable(deal: Deal, priority: SolvePriority = 'interactive'): Promise<DdTableResults> {
  const req: DdTableDealPbn = { cards: dealToPbn(deal) };
  return ddTableVia(req, priority);
}

/**
 * Tricks the DD table says `declarer` takes in `strain`. Orientation TRAP:
 * resTable's first index is the DDS-order strain, second the declarer seat
 * (0=N 1=E 2=S 3=W — our Seat exactly); pinned against SolveBoardPBN in
 * analyse.test.ts since a transposed read still looks plausible.
 */
export function ddTableTricks(table: DdTableResults, strain: number, declarer: number): number {
  return table.resTable[ddsTrump(strain)][declarer];
}

/** DealerPar over a computed table — score is NS-signed, contracts are display strings. */
export async function dealerParFor(
  table: DdTableResults,
  dealer: number,
  vul: Vulnerability,
  priority: SolvePriority = 'interactive',
): Promise<ParResultsDealer> {
  return dealerParVia(table, dealer, ddsVul(vul), priority);
}
