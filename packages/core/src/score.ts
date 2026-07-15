import { Contract, Vulnerability, isVulnerable } from './types.js';

/** One line of a duplicate-scoring receipt, from the DECLARING side's perspective. */
export interface ScoreLine {
  kind: 'odd-tricks' | 'overtricks' | 'undertricks' | 'game-bonus' | 'partscore-bonus' | 'slam-bonus' | 'insult-bonus';
  /** Display name, e.g. 'Odd tricks', 'Game bonus'. */
  label: string;
  /** The arithmetic behind the amount, e.g. '4 × 30', '2 × 300', 'vulnerable'. */
  detail: string;
  /** Signed amount; negative only for undertricks. */
  amount: number;
}

export interface ScoreBreakdown {
  lines: ScoreLine[];
  vulnerable: boolean;
  /** Sum of the line amounts — always equals contractScore() for the same inputs. */
  total: number;
}

/** Compress a penalty progression like [200, 300, 300] into '200 + 2 × 300'. */
function progression(values: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j < values.length && values[j] === values[i]) j++;
    parts.push(j - i === 1 ? `${values[i]}` : `${j - i} × ${values[i]}`);
    i = j;
  }
  return parts.join(' + ');
}

/**
 * Standard duplicate bridge scoring, itemized. `contractScore` is the sum of these
 * lines, so the two can never disagree; anything that explains a score to the player
 * (the toll receipt) should render these lines rather than redoing the arithmetic.
 */
export function scoreBreakdown(contract: Contract, vul: Vulnerability, tricksTaken: number): ScoreBreakdown {
  const { level, strain, doubled, redoubled } = contract;
  const isVul = isVulnerable(contract.declarer, vul);
  const needed = 6 + level;
  const vulWord = isVul ? 'vulnerable' : 'not vulnerable';
  const lines: ScoreLine[] = [];

  if (tricksTaken < needed) {
    const under = needed - tricksTaken;
    // vul doubled: 200 then 300 each; non-vul doubled: 100, 200, 200, then 300 each;
    // redoubled is exactly double the doubled scale; undoubled 100/50 flat.
    const per: number[] = [];
    for (let i = 1; i <= under; i++) {
      if (redoubled) per.push(isVul ? (i === 1 ? 400 : 600) : i === 1 ? 200 : i <= 3 ? 400 : 600);
      else if (doubled) per.push(isVul ? (i === 1 ? 200 : 300) : i === 1 ? 100 : i <= 3 ? 200 : 300);
      else per.push(isVul ? 100 : 50);
    }
    const penalty = per.reduce((a, b) => a + b, 0);
    const scale = redoubled ? 'redoubled ' : doubled ? 'doubled ' : '';
    lines.push({
      kind: 'undertricks',
      label: under === 1 ? 'Down one' : `Down ${under}`,
      detail: `${progression(per)}, ${scale}${vulWord}`,
      amount: -penalty,
    });
    return { lines, vulnerable: isVul, total: -penalty };
  }

  // Contract made
  const perTrick = strain <= 1 ? 20 : 30; // minors 20, majors/NT 30
  const firstTrickBonus = strain === 4 ? 10 : 0;
  const mult = (doubled ? 2 : 1) * (redoubled ? 4 : 1);
  const trickScore = (perTrick * level + firstTrickBonus) * mult;
  const trickMath = `${level} × ${perTrick}${firstTrickBonus ? ' + 10' : ''}`;
  lines.push({
    kind: 'odd-tricks',
    label: 'Odd tricks',
    detail: mult > 1 ? `(${trickMath}) × ${mult}` : trickMath,
    amount: trickScore,
  });

  if (trickScore >= 100) {
    lines.push({ kind: 'game-bonus', label: 'Game bonus', detail: vulWord, amount: isVul ? 500 : 300 });
  } else {
    lines.push({ kind: 'partscore-bonus', label: 'Part-score bonus', detail: '', amount: 50 });
  }
  if (level === 6) {
    lines.push({ kind: 'slam-bonus', label: 'Small slam bonus', detail: vulWord, amount: isVul ? 750 : 500 });
  }
  if (level === 7) {
    lines.push({ kind: 'slam-bonus', label: 'Grand slam bonus', detail: vulWord, amount: isVul ? 1500 : 1000 });
  }
  if (doubled) lines.push({ kind: 'insult-bonus', label: 'The insult', detail: 'doubled and made', amount: 50 });
  if (redoubled) lines.push({ kind: 'insult-bonus', label: 'The insult', detail: 'redoubled and made', amount: 100 });

  const over = tricksTaken - needed;
  if (over > 0) {
    const perOver = redoubled ? (isVul ? 400 : 200) : doubled ? (isVul ? 200 : 100) : perTrick;
    const scale = redoubled ? `, redoubled ${vulWord}` : doubled ? `, doubled ${vulWord}` : '';
    lines.push({
      kind: 'overtricks',
      label: over === 1 ? 'Overtrick' : 'Overtricks',
      detail: `${over} × ${perOver}${scale}`,
      amount: over * perOver,
    });
  }

  return { lines, vulnerable: isVul, total: lines.reduce((sum, l) => sum + l.amount, 0) };
}

/**
 * Standard duplicate bridge scoring.
 * Returns the score from the DECLARING side's perspective (negative = down).
 */
export function contractScore(contract: Contract, vul: Vulnerability, tricksTaken: number): number {
  return scoreBreakdown(contract, vul, tricksTaken).total;
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
