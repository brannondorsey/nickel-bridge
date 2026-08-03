import { describe, expect, it } from 'vitest';
import { Card, Contract, dealBoard, legalCards, playState } from '@bridge/core';
import {
  analysePlayTricks,
  buildFullDealRequest,
  buildPlayTrace,
  calcDdTable,
  ddTableTricks,
  ddsVul,
  dealerParFor,
} from '../src/analyse.js';
import { chooseCard, ddsTrump, solveFutureTricks } from '../src/play-ai.js';

/**
 * Pins for the Analyze DDS helpers. Every encoding here is silent when wrong
 * (a transposed table or mis-mapped vulnerability still yields plausible
 * numbers), so each is verified against DDS itself rather than read off the
 * header — the flat-trace canary being the load-bearing one: DD-optimal play
 * by BOTH sides must produce a trace with no deltas at all, or stage 1 of the
 * analyze pipeline would invent errors.
 */

const C3NT_S: Contract = { level: 3, strain: 4, declarer: 2, doubled: false, redoubled: false };

/** play a whole board DD-optimally for both sides */
async function playOutOptimal(seed: string, boardNo: number, contract: Contract, plays: Card[] = []): Promise<Card[]> {
  const deal = dealBoard(seed, boardNo);
  const out = [...plays];
  while (!playState(deal, contract, out).isOver) {
    out.push(await chooseCard(deal, contract, out));
  }
  return out;
}

describe('encodings', () => {
  it('ddsTrump reverses the strain order except NT', () => {
    expect([0, 1, 2, 3, 4].map(ddsTrump)).toEqual([3, 2, 1, 0, 4]);
  });

  it('ddsVul: 1 is BOTH, not NS', () => {
    expect(ddsVul({ ns: false, ew: false })).toBe(0);
    expect(ddsVul({ ns: true, ew: true })).toBe(1);
    expect(ddsVul({ ns: true, ew: false })).toBe(2);
    expect(ddsVul({ ns: false, ew: true })).toBe(3);
  });

  it('buildPlayTrace: two chars per card, no separators', () => {
    // ♠A = suit 0 rank 12; ♣2 = suit 3 rank 0; ♥T = suit 1 rank 8
    expect(buildPlayTrace([12, 39, 21]).cards).toBe('SAC2HT');
    expect(buildPlayTrace([]).cards).toBe('');
  });

  it('buildFullDealRequest puts the opening leader on play with an empty trick', () => {
    const deal = dealBoard('analyse-enc', 1);
    const req = buildFullDealRequest(deal, C3NT_S);
    expect(req.first).toBe(3); // West leads against a South contract
    expect(req.trump).toBe(4);
    expect(req.currentTrickRank).toEqual([0, 0, 0]);
    expect(req.remainCards.split(' ')).toHaveLength(4);
  });
});

describe('analysePlayTricks', () => {
  it('DD-optimal play by both sides yields a FLAT trace of length 49 (the canary)', async () => {
    const plays = await playOutOptimal('analyse-flat', 1, C3NT_S);
    expect(plays).toHaveLength(52);
    const tricks = await analysePlayTricks(dealBoard('analyse-flat', 1), C3NT_S, plays);
    expect(tricks).toHaveLength(49); // min(cards + 1, 49): trick 13 is forced, never analysed
    for (const t of tricks) expect(t).toBe(tricks[0]);
  }, 60_000);

  it('a deliberately worst card produces a delta at exactly its own index', async () => {
    const deal = dealBoard('analyse-blunder', 1);
    const plays: Card[] = [];
    let blunderAt = -1;
    // walk DD-optimally until a node where some legal card is strictly worse,
    // butcher exactly that one decision, then resume optimal play
    while (blunderAt < 0) {
      const ps = playState(deal, C3NT_S, plays);
      if (ps.isOver) throw new Error('no decision with a strictly worse card found');
      const legal = legalCards(deal, ps);
      if (legal.length > 1) {
        const solve = await solveFutureTricks(deal, C3NT_S, plays);
        const worst = [...legal].sort(
          (a, b) => (solve.cardScores.get(a) ?? 99) - (solve.cardScores.get(b) ?? 99),
        )[0];
        if ((solve.cardScores.get(worst) ?? 0) < solve.bestScore) {
          blunderAt = plays.length;
          plays.push(worst);
          continue;
        }
      }
      plays.push(await chooseCard(deal, C3NT_S, plays));
    }
    const full = await playOutOptimal('analyse-blunder', 1, C3NT_S, plays);
    const tricks = await analysePlayTricks(deal, C3NT_S, full);
    for (let i = 0; i < blunderAt; i++) {
      expect(tricks[i + 1], `flat before the blunder (index ${i})`).toBe(tricks[i]);
    }
    expect(tricks[blunderAt + 1]).not.toBe(tricks[blunderAt]);
  }, 60_000);
});

describe('DD table + par', () => {
  it('accepts dealToPbn unmodified across all four dealers, 5x4 table in range', async () => {
    for (const boardNo of [1, 2, 3, 4]) {
      const table = await calcDdTable(dealBoard('analyse-table', boardNo));
      expect(table.resTable).toHaveLength(5);
      for (const row of table.resTable) {
        expect(row).toHaveLength(4);
        for (const v of row) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(13);
        }
      }
    }
  }, 60_000);

  it('resTable orientation: [ddsTrump(strain)][declarer] agrees with SolveBoardPBN', async () => {
    const deal = dealBoard('analyse-orient', 1);
    const table = await calcDdTable(deal);
    for (const { strain, declarer } of [
      { strain: 4, declarer: 2 },
      { strain: 3, declarer: 0 },
      { strain: 0, declarer: 1 },
    ]) {
      const contract: Contract = { level: 1, strain, declarer: declarer as 0 | 1 | 2, doubled: false, redoubled: false };
      // at trick 0 the side to move is the DEFENSE (opening leader), so its
      // best score is 13 minus what the table says declarer takes
      const solve = await solveFutureTricks(deal, contract, []);
      expect(ddTableTricks(table, strain, declarer)).toBe(13 - solve.bestScore);
    }
  }, 60_000);

  it('DealerPar answers with an NS-signed score and contract strings', async () => {
    const deal = dealBoard('analyse-par', 3); // board 3: dealer S, EW vul
    const table = await calcDdTable(deal);
    const par = await dealerParFor(table, deal.dealer, deal.vul);
    expect(typeof par.score).toBe('number');
    expect(par.contracts.length).toBeGreaterThan(0);
    for (const c of par.contracts) expect(typeof c).toBe('string');
  }, 60_000);
});
