import { parentPort } from 'node:worker_threads';
import { Dds, loadDds } from '../vendor/bridge-dds/api.js';
import type { DdTableDealPbn, DdTableResults, DealPbn, PlayTracePbn } from '../vendor/bridge-dds/api.js';

/**
 * DDS worker: one WASM instance per worker thread (loadDds() returns a fresh
 * Emscripten module with its own linear memory each call, so instances are
 * fully independent). Every DDS entry point is synchronous and blocking —
 * that's the point: it blocks this worker instead of the server's event loop,
 * and N workers give N calls in parallel. Messages are id-correlated plain
 * objects; every payload below is strings/numbers/arrays, structured-clone-safe.
 *
 * `kind` discriminates the operation; an ABSENT kind means 'solve', so a
 * message from an older dd-pool build still solves. 'solve' is the hot path
 * (every robot card decision); the other three exist for the Analyze feature's
 * board review (DD trace of a whole play, the 20-problem DD table, and par).
 */
export type WorkerRequest =
  | { id: number; kind?: 'solve'; req: DealPbn }
  | { id: number; kind: 'analysePlay'; req: DealPbn; play: PlayTracePbn }
  | { id: number; kind: 'ddTable'; req: DdTableDealPbn }
  | { id: number; kind: 'dealerPar'; table: DdTableResults; dealer: number; vul: number };

if (!parentPort) throw new Error('dd-worker must run inside a worker thread');
const port = parentPort;

// Lazy, race-free init: a burst of messages can arrive before the WASM is up,
// and each handler invocation must await the SAME instantiation.
let ddsPromise: Promise<Dds> | null = null;
const getDds = (): Promise<Dds> => (ddsPromise ??= loadDds().then((m) => new Dds(m)));

port.on('message', async (msg: WorkerRequest) => {
  try {
    const dds = await getDds();
    let res: unknown;
    switch (msg.kind) {
      case undefined:
      case 'solve':
        res = dds.SolveBoardPBN(msg.req, -1, 3, 0);
        break;
      case 'analysePlay':
        res = dds.AnalysePlayPBN(msg.req, msg.play);
        break;
      case 'ddTable':
        res = dds.CalcDDTablePBN(msg.req);
        break;
      case 'dealerPar':
        res = dds.DealerPar(msg.table, msg.dealer, msg.vul);
        break;
    }
    port.postMessage({ id: msg.id, res });
  } catch (err) {
    port.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
