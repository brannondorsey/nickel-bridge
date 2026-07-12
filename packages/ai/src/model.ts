import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Inference for the brl ActorCritic "DeepMind" policy network
 * (arXiv:2406.10306): obs(480) → 4×[Linear(1024)+ReLU] → actor head (38).
 * Weights are the converted Haiku params produced by tools/convert_weights.py.
 */
interface TensorRef {
  shape: number[];
  offset: number;
  size: number;
}

interface Manifest {
  layers: { name: string; w: TensorRef; b: TensorRef }[];
}

/** Load one of the bundled models ("sl" — SAYC-faithful, default — or "rl-fsp"). */
export function loadPolicyModel(name: 'sl' | 'rl-fsp' = 'sl'): PolicyModel {
  const manifest = fileURLToPath(new URL(`../models/${name}.json`, import.meta.url));
  const bin = fileURLToPath(new URL(`../models/${name}.bin`, import.meta.url));
  return new PolicyModel(manifest, bin);
}

export class PolicyModel {
  private data: Float32Array;
  private layers: { w: TensorRef; b: TensorRef }[];

  constructor(manifestPath: string, binPath: string) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    const buf = readFileSync(binPath);
    this.data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    this.layers = manifest.layers;
  }

  /** Raw actor logits (38). */
  logits(obs: Float32Array): Float32Array {
    let x = obs;
    for (let l = 0; l < 4; l++) {
      x = this.dense(x, this.layers[l], true);
    }
    return this.dense(x, this.layers[4], false); // actor head; layers[5] is the unused critic head
  }

  /** Softmax policy over legal actions only (illegal actions get 0). */
  policy(obs: Float32Array, legalMask: boolean[]): Float32Array {
    const logits = this.logits(obs);
    let max = -Infinity;
    for (let a = 0; a < 38; a++) if (legalMask[a] && logits[a] > max) max = logits[a];
    const probs = new Float32Array(38);
    let sum = 0;
    for (let a = 0; a < 38; a++) {
      if (legalMask[a]) {
        probs[a] = Math.exp(logits[a] - max);
        sum += probs[a];
      }
    }
    for (let a = 0; a < 38; a++) probs[a] /= sum;
    return probs;
  }

  private dense(x: Float32Array, layer: { w: TensorRef; b: TensorRef }, relu: boolean): Float32Array {
    const [inDim, outDim] = layer.w.shape;
    const w = this.data;
    const wOff = layer.w.offset;
    const bOff = layer.b.offset;
    const out = new Float32Array(outDim);
    for (let j = 0; j < outDim; j++) out[j] = w[bOff + j];
    for (let i = 0; i < inDim; i++) {
      const xi = x[i];
      if (xi === 0) continue; // observations are sparse binary; big win on layer 1
      const row = wOff + i * outDim;
      for (let j = 0; j < outDim; j++) out[j] += xi * w[row + j];
    }
    if (relu) {
      for (let j = 0; j < outDim; j++) if (out[j] < 0) out[j] = 0;
    }
    return out;
  }
}
