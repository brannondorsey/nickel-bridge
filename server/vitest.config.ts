import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration suites drive full boards through the API (DD solver included),
    // which can exceed vitest's 5s default when test files run in parallel on
    // few cores. The suites are fast in practice; this only guards against
    // contention-induced flakes.
    testTimeout: 30_000,
  },
});
