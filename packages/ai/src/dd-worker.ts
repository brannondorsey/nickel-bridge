import { parentPort } from 'node:worker_threads';
import { Dds, loadDds } from '../vendor/bridge-dds/api.js';
import type { DealPbn } from '../vendor/bridge-dds/api.js';

/**
 * DDS solve worker: one WASM instance per worker thread (loadDds() returns a
 * fresh Emscripten module with its own linear memory each call, so instances
 * are fully independent). SolveBoardPBN is synchronous and blocking — that's
 * the point: it blocks this worker instead of the server's event loop, and N
 * workers give N solves in parallel. Messages are id-correlated plain
 * objects; FutureTricks is arrays/numbers, structured-clone-safe.
 */
interface SolveMessage {
  id: number;
  req: DealPbn;
}

if (!parentPort) throw new Error('dd-worker must run inside a worker thread');
const port = parentPort;

let dds: Dds | null = null;

port.on('message', async (msg: SolveMessage) => {
  try {
    if (!dds) dds = new Dds(await loadDds());
    const res = dds.SolveBoardPBN(msg.req, -1, 3, 0);
    port.postMessage({ id: msg.id, res });
  } catch (err) {
    port.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
