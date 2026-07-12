import { Contract, Vulnerability, isVulnerable } from './types.js';

/**
 * Standard duplicate bridge scoring.
 * Returns the score from the DECLARING side's perspective (negative = down).
 */
export function contractScore(contract: Contract, vul: Vulnerability, tricksTaken: number): number {
  const { level, strain, doubled, redoubled } = contract;
  const isVul = isVulnerable(contract.declarer, vul);
  const needed = 6 + level;

  if (tricksTaken < needed) {
    const under = needed - tricksTaken;
    if (redoubled) {
      // 400/1000/1600... vul: first -400 then -600 each; non-vul: -200,-400,-400 then -600
      let score = 0;
      for (let i = 1; i <= under; i++) {
        if (isVul) score += i === 1 ? 400 : 600;
        else score += i === 1 ? 200 : i <= 3 ? 400 : 600;
      }
      return -score;
    }
    if (doubled) {
      let score = 0;
      for (let i = 1; i <= under; i++) {
        if (isVul) score += i === 1 ? 200 : 300;
        else score += i === 1 ? 100 : i <= 3 ? 200 : 300;
      }
      return -score;
    }
    return -under * (isVul ? 100 : 50);
  }

  // Contract made
  const perTrick = strain <= 1 ? 20 : 30; // minors 20, majors/NT 30
  const firstTrickBonus = strain === 4 ? 10 : 0;
  let trickScore = perTrick * level + firstTrickBonus;
  if (doubled) trickScore *= 2;
  if (redoubled) trickScore *= 4;

  let score = trickScore;
  // game/part-score bonus
  score += trickScore >= 100 ? (isVul ? 500 : 300) : 50;
  // slam bonuses
  if (level === 6) score += isVul ? 750 : 500;
  if (level === 7) score += isVul ? 1500 : 1000;
  // insult bonus
  if (doubled) score += 50;
  if (redoubled) score += 100;

  // overtricks
  const over = tricksTaken - needed;
  if (over > 0) {
    if (redoubled) score += over * (isVul ? 400 : 200);
    else if (doubled) score += over * (isVul ? 200 : 100);
    else score += over * perTrick;
  }
  return score;
}

/**
 * Score from NS perspective for a completed board (or 0 for a pass-out).
 * The human always sits South, so cross-player comparisons compare these directly.
 */
export function boardScoreNS(contract: Contract | null, vul: Vulnerability, tricksTaken: number): number {
  if (!contract) return 0;
  const declarerScore = contractScore(contract, vul, tricksTaken);
  return contract.declarer % 2 === 0 ? declarerScore : -declarerScore;
}

/**
 * Matchpoint a set of NS scores on the same board.
 * Returns matchpoints (1 per pair beaten, 0.5 per tie) and percentage 0..100.
 * With a single result the percentage is 50 (nothing to compare against).
 */
export function matchpoints(scores: number[]): { mp: number; pct: number }[] {
  const n = scores.length;
  return scores.map((score, i) => {
    let mp = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (score > scores[j]) mp += 1;
      else if (score === scores[j]) mp += 0.5;
    }
    const pct = n > 1 ? (mp / (n - 1)) * 100 : 50;
    return { mp, pct };
  });
}

export function contractLabel(contract: Contract | null, tricksTaken?: number): string {
  if (!contract) return 'Passed out';
  const STRAINS = ['♣', '♦', '♥', '♠', 'NT'];
  const SEATS = ['N', 'E', 'S', 'W'];
  let label = `${contract.level}${STRAINS[contract.strain]}`;
  if (contract.redoubled) label += 'XX';
  else if (contract.doubled) label += 'X';
  label += ` by ${SEATS[contract.declarer]}`;
  if (tricksTaken !== undefined) {
    const needed = 6 + contract.level;
    if (tricksTaken >= needed) label += tricksTaken === needed ? ' =' : ` +${tricksTaken - needed}`;
    else label += ` −${needed - tricksTaken}`;
  }
  return label;
}
