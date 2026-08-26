import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration suites drive full boards through the API (DD solver included),
    // which can exceed vitest's 5s default when test files run in parallel on
    // few cores. The suites are fast in practice; this only guards against
    // contention-induced flakes.
    testTimeout: 30_000,
    // Same reasoning, and it needs saying separately: hookTimeout does not
    // inherit from testTimeout, and its default is 10s. A beforeAll that sets a
    // suite up by playing real boards is doing exactly the work above.
    hookTimeout: 30_000,
    // Vitest's own file-level parallelism defaults to `availableParallelism() - 1`
    // (3 on a 4-vCPU runner) — and every one of those concurrently-running test
    // FILES that touches DD-solver code (a full playBoard(), a claim check, a
    // sampled-difficulty solve) independently spins up its OWN
    // packages/ai/src/dd-pool.ts worker_threads pool, sized off that SAME
    // availableParallelism() reading (capped at 4). Left uncapped, that is up
    // to 3 files × 3 solver threads = 9 CPU-bound OS threads contending for 4
    // real cores — self-inflicted, entirely within this one `vitest run`, no
    // other job needs to be involved. That oversubscription is what turned
    // a single contention-hit `finishedBoard()` retry in
    // test/rehearsal.test.ts into a 30s test timeout in CI on 2026-08-21 —
    // unreproducible locally, where nothing else was competing for the CPU —
    // and, because a real board's still sitting mid-play when a test times out
    // (vitest reports the failure but does not cancel the in-flight
    // app.inject() chain), the abandoned request kept racing every following
    // test's own finishedBoard() call for the SAME tournament (evergreen
    // placement resumes your unfinished one), turning one slow test into six
    // more "illegal card" failures behind it. Capping file workers bounds the
    // multiplication without touching what any test asserts; 2 (vs. the
    // default 3) cut worst-case concurrent solver threads from 9 to 6 while
    // costing ~15% suite wall time in local measurement, well inside the
    // ~10s combined-workspace budget `npm test`'s own doc comment assumes.
    maxWorkers: 2,
  },
});
