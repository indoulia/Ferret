import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The specifier `ferret index --content` composes the parser with
      // (EPIC-108 §8.5). Node resolves it by self-reference to `dist/`; the
      // suite runs against `src/`, and a test that silently exercised the last
      // build rather than the working tree would be worse than no test.
      '@indoulia/ferret/parsers': fileURLToPath(new URL('./src/parsers/index.ts', import.meta.url)),
    },
  },
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
