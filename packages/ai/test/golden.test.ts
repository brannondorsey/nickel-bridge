import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeObservation } from '../src/encode.js';
import { PolicyModel } from '../src/model.js';

const here = dirname(fileURLToPath(import.meta.url));

interface Fixture {
  hands: number[][];
  dealer: number;
  vulNS: boolean;
  vulEW: boolean;
  actorSeat: number;
  calls: number[];
  observation: number[];
  logits: number[];
}

const fixtures: Fixture[] = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'));

describe('golden fixtures vs pgx + brl', () => {
  it('observation encoding matches pgx bit-for-bit', () => {
    for (const f of fixtures) {
      const obs = encodeObservation(
        f.hands[f.actorSeat],
        f.dealer as 0,
        { ns: f.vulNS, ew: f.vulEW },
        f.calls,
        f.actorSeat as 0,
      );
      expect(Array.from(obs), `calls=[${f.calls}] dealer=${f.dealer} actor=${f.actorSeat}`).toEqual(f.observation);
    }
  });

  it('policy logits match the converted network', () => {
    const model = new PolicyModel(join(here, '../models/sl.json'), join(here, '../models/sl.bin'));
    for (const f of fixtures) {
      const obs = Float32Array.from(f.observation);
      const logits = model.logits(obs);
      for (let a = 0; a < 38; a++) {
        expect(Math.abs(logits[a] - f.logits[a]), `action ${a}`).toBeLessThan(1e-3);
      }
    }
  });
});
