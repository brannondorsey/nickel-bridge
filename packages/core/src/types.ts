/**
 * Canonical representations shared across the app.
 *
 * Seats: 0=N, 1=E, 2=S, 3=W (clockwise). The human always sits South (2).
 * Cards: card = suit*13 + rank, suit 0=♠ 1=♥ 2=♦ 3=♣, rank 0='2' … 12='A'.
 * Calls: a single number 0..37 (the pgx/OpenSpiel action space):
 *   0=Pass, 1=Double(X), 2=Redouble(XX), 3..37 = bids where
 *   bid action = 3 + (level-1)*5 + strain, strain 0=♣ 1=♦ 2=♥ 3=♠ 4=NT.
 */

export type Seat = 0 | 1 | 2 | 3;
export const SEATS: Seat[] = [0, 1, 2, 3];
export const SEAT_NAMES = ['N', 'E', 'S', 'W'] as const;

export type Suit = 0 | 1 | 2 | 3; // ♠ ♥ ♦ ♣
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'] as const;
export const SUIT_LETTERS = ['S', 'H', 'D', 'C'] as const;

export type Card = number; // 0..51
export const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

/** Strains in bid order (matches pgx denomination = bid % 5). */
export type Strain = 0 | 1 | 2 | 3 | 4; // ♣ ♦ ♥ ♠ NT
export const STRAIN_SYMBOLS = ['♣', '♦', '♥', '♠', 'NT'] as const;
export const STRAIN_LETTERS = ['C', 'D', 'H', 'S', 'N'] as const;

export type Call = number; // 0..37
export const PASS = 0;
export const DOUBLE = 1;
export const REDOUBLE = 2;
export const BID_OFFSET = 3;

export interface Vulnerability {
  ns: boolean;
  ew: boolean;
}

export interface Deal {
  /** hands[seat] = sorted array of 13 cards */
  hands: Card[][];
  dealer: Seat;
  vul: Vulnerability;
}

export interface Contract {
  level: number; // 1..7
  strain: Strain;
  declarer: Seat;
  doubled: boolean;
  redoubled: boolean;
}

export function cardSuit(card: Card): Suit {
  return Math.floor(card / 13) as Suit;
}

export function cardRank(card: Card): number {
  return card % 13;
}

export function makeCard(suit: Suit, rank: number): Card {
  return suit * 13 + rank;
}

export function cardName(card: Card): string {
  return SUIT_SYMBOLS[cardSuit(card)] + RANK_CHARS[cardRank(card)];
}

export function isBid(call: Call): boolean {
  return call >= BID_OFFSET;
}

export function bidLevel(call: Call): number {
  return Math.floor((call - BID_OFFSET) / 5) + 1;
}

export function bidStrain(call: Call): Strain {
  return ((call - BID_OFFSET) % 5) as Strain;
}

export function makeBid(level: number, strain: Strain): Call {
  return BID_OFFSET + (level - 1) * 5 + strain;
}

export function callName(call: Call): string {
  if (call === PASS) return 'Pass';
  if (call === DOUBLE) return 'X';
  if (call === REDOUBLE) return 'XX';
  return `${bidLevel(call)}${STRAIN_SYMBOLS[bidStrain(call)]}`;
}

export function partnerOf(seat: Seat): Seat {
  return ((seat + 2) % 4) as Seat;
}

export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat;
}

export function sameSide(a: Seat, b: Seat): boolean {
  return a % 2 === b % 2;
}

export function isVulnerable(seat: Seat, vul: Vulnerability): boolean {
  return seat % 2 === 0 ? vul.ns : vul.ew;
}
