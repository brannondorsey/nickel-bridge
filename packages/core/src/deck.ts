import { Card, Deal, Seat, Suit, Vulnerability, cardRank, cardSuit, makeCard, RANK_CHARS, SEAT_NAMES } from './types.js';

/** xmur3 string hash → seed for mulberry32. Deterministic across platforms. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRng(seed: string): () => number {
  return mulberry32(xmur3(seed)());
}

/** Standard duplicate dealer/vulnerability rotation for boards 1..16. */
export function boardConditions(boardNo: number): { dealer: Seat; vul: Vulnerability } {
  const dealer = ((boardNo - 1) % 4) as Seat;
  const VULS: Vulnerability[] = [
    { ns: false, ew: false },
    { ns: true, ew: false },
    { ns: false, ew: true },
    { ns: true, ew: true },
  ];
  // Standard board vulnerability cycle (boards 1-16): shifts by one each group of 4.
  const idx = ((boardNo - 1) + Math.floor((boardNo - 1) / 4)) % 4;
  return { dealer, vul: VULS[idx] };
}

/** Deal a board deterministically from a seed string. */
export function dealBoard(seed: string, boardNo: number): Deal {
  const rng = seededRng(`${seed}#board${boardNo}`);
  const cards: Card[] = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  const hands: Card[][] = [0, 1, 2, 3].map((s) => cards.slice(s * 13, s * 13 + 13).sort((a, b) => a - b));
  const { dealer, vul } = boardConditions(boardNo);
  return { hands, dealer, vul };
}

const HCP_BY_RANK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]; // J Q K A

export function hcp(cards: Card[]): number {
  return cards.reduce((sum, c) => sum + HCP_BY_RANK[cardRank(c)], 0);
}

export function suitCards(cards: Card[], suit: Suit): Card[] {
  return cards.filter((c) => cardSuit(c) === suit);
}

/** Suit lengths [♠,♥,♦,♣]. */
export function shape(cards: Card[]): [number, number, number, number] {
  const lens: [number, number, number, number] = [0, 0, 0, 0];
  for (const c of cards) lens[cardSuit(c)]++;
  return lens;
}

/** Hand → PBN suit-holding string, e.g. "AKQ2.T98.7654.32" (♠.♥.♦.♣, ranks descending). */
export function handToPbn(cards: Card[]): string {
  const suits: string[] = [];
  for (let s = 0; s < 4; s++) {
    const ranks = cards
      .filter((c) => cardSuit(c) === s)
      .map((c) => cardRank(c))
      .sort((a, b) => b - a)
      .map((r) => RANK_CHARS[r])
      .join('');
    suits.push(ranks);
  }
  return suits.join('.');
}

/** Full deal → PBN deal string, e.g. "N:AKQ2.T98... hand hand hand" (N E S W). */
export function dealToPbn(deal: Deal): string {
  return `${SEAT_NAMES[deal.dealer]}:` + rotate(deal.hands, deal.dealer).map(handToPbn).join(' ');
}

function rotate<T>(arr: T[], start: number): T[] {
  return arr.map((_, i) => arr[(start + i) % arr.length]);
}

export function pbnToDeal(pbn: string, dealer: Seat, vul: Vulnerability): Deal {
  const [startSeat, rest] = [pbn[0], pbn.slice(2)];
  const start = SEAT_NAMES.indexOf(startSeat as 'N');
  if (start < 0) throw new Error(`bad PBN deal: ${pbn}`);
  const hands: Card[][] = [[], [], [], []];
  rest.split(' ').forEach((handStr, i) => {
    const seat = (start + i) % 4;
    handStr.split('.').forEach((ranks, suit) => {
      for (const ch of ranks) {
        const rank = RANK_CHARS.indexOf(ch as '2');
        if (rank < 0) throw new Error(`bad PBN rank: ${ch}`);
        hands[seat].push(makeCard(suit as Suit, rank));
      }
    });
  });
  hands.forEach((h) => {
    if (h.length !== 13) throw new Error(`bad PBN deal (hand size): ${pbn}`);
    h.sort((a, b) => a - b);
  });
  return { hands, dealer, vul };
}
