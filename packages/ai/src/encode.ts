import { Call, Card, Seat, Vulnerability, cardRank, cardSuit } from '@bridge/core';

/**
 * Faithful TypeScript port of the pgx v1.4.0 bridge_bidding observation
 * (`_observe` in pgx/bridge_bidding.py) — the encoding the brl models were
 * trained on. Verified bit-for-bit against the original jax implementation
 * by the golden fixtures in test/fixtures.json.
 *
 * Layout (480 bits):
 *   [0..3]     vulnerability relative to the acting side:
 *              [not-us-vul, us-vul, not-them-vul, them-vul]
 *   [4..7]     passes before any bid, by relative seat (0=me, 1=LHO, 2=partner, 3=RHO)
 *   [8..427]   35 bids × 12: [bid made, doubled, redoubled] × relative seat
 *   [428..479] the actor's 13 cards, OpenSpiel card indexing (suit + rank*4,
 *              suits ♣=0 ♦=1 ♥=2 ♠=3, ranks 2=0 … A=12)
 */
export const OBS_SIZE = 480;

/** our card (suit*13+rank, suits ♠♥♦♣, ranks 2..A) → OpenSpiel card index */
export function cardToOpenSpiel(card: Card): number {
  const suit = cardSuit(card); // 0=♠ 1=♥ 2=♦ 3=♣
  const rank = cardRank(card); // 0='2' .. 12='A'
  return 3 - suit + rank * 4;
}

export function encodeObservation(
  hand: Card[],
  dealer: Seat,
  vul: Vulnerability,
  calls: Call[],
  actor: Seat,
): Float32Array {
  const obs = new Float32Array(OBS_SIZE);

  // vulnerability, relative to the actor's side
  const usVul = actor % 2 === 0 ? vul.ns : vul.ew;
  const themVul = actor % 2 === 0 ? vul.ew : vul.ns;
  obs[0] = usVul ? 0 : 1;
  obs[1] = usVul ? 1 : 0;
  obs[2] = themVul ? 0 : 1;
  obs[3] = themVul ? 1 : 0;

  // bidding history
  let lastBid = 0;
  for (let i = 0; i < calls.length; i++) {
    const action = calls[i];
    const relative = (((i + dealer) % 4) + (4 - actor)) % 4;
    if (action === 0) {
      // pass — only recorded before the first bid
      if (lastBid === 0) obs[4 + relative] = 1;
    } else if (action === 1) {
      obs[8 + (lastBid - 3) * 12 + 4 + relative] = 1;
    } else if (action === 2) {
      obs[8 + (lastBid - 3) * 12 + 8 + relative] = 1;
    } else {
      lastBid = action;
      obs[8 + (action - 3) * 12 + relative] = 1;
    }
  }

  // hand
  for (const card of hand) {
    obs[428 + cardToOpenSpiel(card)] = 1;
  }
  return obs;
}
