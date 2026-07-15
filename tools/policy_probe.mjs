#!/usr/bin/env node
/**
 * Print the bidding model's full policy for an arbitrary position.
 *
 * The observation encoding only reads the acting player's hand, so you can
 * probe any position from a single hand plus the auction so far — the other
 * three hands are filled with the remaining cards in order (they don't matter).
 *
 * Usage (from repo root, after npm run build):
 *   node tools/policy_probe.mjs <hand> [--model sl|rl-fsp] [--dealer N|E|S|W]
 *                               [--vul none|ns|ew|both] [--calls "1H P ..."]
 *
 * <hand> is PBN suit order ♠.♥.♦.♣, e.g. "K98.QT95.AQJT5.7".
 * --calls are the calls made so far, dealer first: bids like 1H/3N, P, X, XX.
 * The probed hand is placed at the seat whose turn it is after those calls.
 */
import {
  BID_OFFSET,
  DOUBLE,
  PASS,
  RANK_CHARS,
  REDOUBLE,
  SEAT_NAMES,
  STRAIN_LETTERS,
  auctionState,
  callName,
  legalCalls,
  makeCard,
} from '../packages/core/dist/index.js';
import { Bidder, loadPolicyModel } from '../packages/ai/dist/index.js';

function parseArgs(argv) {
  const args = { model: 'sl', dealer: 'N', vul: 'none', calls: '', hand: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model' || a === '--dealer' || a === '--vul' || a === '--calls') {
      args[a.slice(2)] = argv[++i];
    } else if (!args.hand) {
      args.hand = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  if (!args.hand) throw new Error('missing <hand> (PBN suit order ♠.♥.♦.♣, e.g. "K98.QT95.AQJT5.7")');
  return args;
}

function parseHand(pbn) {
  const suits = pbn.split('.');
  if (suits.length !== 4) throw new Error(`bad hand "${pbn}": need 4 dot-separated suits (♠.♥.♦.♣)`);
  const cards = [];
  suits.forEach((ranks, suit) => {
    for (const ch of ranks.toUpperCase()) {
      const rank = RANK_CHARS.indexOf(ch);
      if (rank < 0) throw new Error(`bad rank "${ch}" in hand`);
      cards.push(makeCard(suit, rank));
    }
  });
  if (cards.length !== 13) throw new Error(`hand has ${cards.length} cards, need 13`);
  return cards.sort((a, b) => a - b);
}

function parseCall(tok) {
  const t = tok.toUpperCase();
  if (t === 'P' || t === 'PASS') return PASS;
  if (t === 'X' || t === 'DBL') return DOUBLE;
  if (t === 'XX' || t === 'RDBL') return REDOUBLE;
  const level = Number(t[0]);
  const strain = STRAIN_LETTERS.indexOf(t.slice(1, 2));
  if (!(level >= 1 && level <= 7) || strain < 0) throw new Error(`bad call "${tok}"`);
  return BID_OFFSET + (level - 1) * 5 + strain;
}

const args = parseArgs(process.argv.slice(2));
const dealer = SEAT_NAMES.indexOf(args.dealer.toUpperCase());
if (dealer < 0) throw new Error(`bad dealer "${args.dealer}"`);
const vul = { ns: args.vul === 'ns' || args.vul === 'both', ew: args.vul === 'ew' || args.vul === 'both' };
const calls = args.calls.trim() ? args.calls.trim().split(/\s+/).map(parseCall) : [];
const hand = parseHand(args.hand);

// Place the probed hand at the acting seat; deal the remaining 39 cards to the
// other seats in card order. encodeObservation only reads hands[turn].
const turn = auctionState(dealer, calls).turn;
const rest = [];
for (let c = 0; c < 52; c++) if (!hand.includes(c)) rest.push(c);
const hands = [[], [], [], []];
hands[turn] = hand;
let i = 0;
for (const s of [0, 1, 2, 3]) if (s !== turn) hands[s] = rest.slice(13 * i, 13 * ++i);
const deal = { hands, dealer, vul };

const bidder = new Bidder(loadPolicyModel(args.model));
const { probs, state, mask } = bidder.policyFor(deal, calls);

console.log(`model=${args.model} dealer=${SEAT_NAMES[dealer]} vul=${args.vul} turn=${SEAT_NAMES[state.turn]}`);
console.log(`auction: ${calls.length ? calls.map(callName).join(' ') : '(opening position)'}`);
const ranked = [...probs.keys()].filter((a) => mask[a]).sort((a, b) => probs[b] - probs[a]);
for (const a of ranked) {
  const pct = (probs[a] * 100).toFixed(2).padStart(6);
  if (probs[a] >= 0.0005 || a === ranked[0]) console.log(`${pct}%  ${callName(a)}`);
}
