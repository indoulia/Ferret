import { fileURLToPath } from 'node:url';

import { defaultExclude, defineConfig } from 'vitest/config';

import { requiredGroups } from './tests/required-groups.js';

/** The one required test group, named in two places, so it is named once. */
const PACKAGING = 'tests/integration/packaging.test.ts';

const resolve = {
  alias: {
    // The specifier `ferret index --content` composes the parser with
    // (EPIC-108 §8.5). Node resolves it by self-reference to `dist/`; the
    // suite runs against `src/`, and a test that silently exercised the last
    // build rather than the working tree would be worse than no test.
    '@indoulia/ferret/parsers': fileURLToPath(new URL('./src/parsers/index.ts', import.meta.url)),
  },
};

const shared = {
  environment: 'node' as const,
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
  pool: 'forks' as const,
};

export default defineConfig({
  resolve,
  test: {
    globalSetup: ['tests/global-setup.ts'],
    // F-73, the half that reports. The packaging suite *is* the release gate —
    // it scans the bytes the package actually ships for credential shapes and
    // asserts the tarball is reproducible — and its 34 assertions all hang off
    // one file-scope hook. When that hook overran its budget, Vitest marked the
    // module failed and every test `skipped`, and the `Tests` line then read
    // `3536 passed | 41 skipped`: the gate merged into the same count as seven
    // deliberately conditional tests, and read as "zero failing tests". This
    // reporter is the part that says a required group did not run, in place of
    // a number that reads as a pass. Root-level: a project's own `reporters`
    // are not consulted.
    reporters: [
      'default',
      requiredGroups([
        {
          module: PACKAGING,
          guarantee:
            'the shipped bytes carry no credential, the tarball is reproducible, ' +
            'and the installed package starts',
        },
      ]),
    ],
    // F-73, the half that fixes the cause — and the cause is not the budget.
    //
    // Measured on this machine: the packaging hook takes **33 s alone** (2.9 s
    // to pack, 29.9 s to install the tarball globally, which resolves and
    // writes 155 packages and 138 MB) and **320 s** when it is scheduled
    // alongside the other 177 files, several of which are themselves spawning
    // `git`, subprocesses and containers. A tenfold amplification on a
    // disk-bound hook is contention, not an undersized timeout, so raising the
    // 300 s would buy one run and lose the next.
    //
    // Two groups instead: everything else, then packaging on its own.
    // `groupOrder` runs projects from lowest to highest and only projects
    // sharing a number run together, so the expensive hook no longer competes
    // with the suite that made it overrun. Nothing is skipped, no budget moved,
    // and `npm test` is still one command.
    projects: [
      {
        resolve,
        test: {
          ...shared,
          name: 'suite',
          include: ['tests/**/*.test.ts'],
          exclude: [...defaultExclude, PACKAGING],
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve,
        test: {
          ...shared,
          name: 'packaging',
          include: [PACKAGING],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
