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
  },
});
