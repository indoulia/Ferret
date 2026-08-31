import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Ninety seconds, not thirty.
    //
    // Most of this suite is integration work against a real PostgreSQL and a
    // real `git`, and a single test can index a repository two or three times.
    // Each run spawns a good number of subprocesses — heavily so on Windows —
    // and the files run in parallel forks, so a test that takes eight seconds
    // alone can take four times that when fifty files are contending.
    //
    // At thirty seconds those tests failed intermittently, and the failure
    // named whichever test drew the short straw rather than the contention that
    // caused it. One of them asserted a sixty-second budget it could never
    // reach, because the harness killed it at thirty. A timeout shorter than
    // the work is not a useful signal; it is a flake that reads as a
    // correctness problem.
    //
    // Individual tests still narrow this where a fast failure is the point.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    pool: 'forks',
    globalSetup: ['tests/global-setup.ts'],
    reporters: ['default'],
  },
});
