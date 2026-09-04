import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { requiredGroups } from '../../required-groups.js';

/**
 * The harness under test in `tests/integration/required-groups.test.ts`.
 *
 * Deliberately not the project configuration: no global setup, no database, a
 * one-second hook budget, and one required group. It exists so the guard can be
 * exercised against a hook that overruns without waiting five minutes for the
 * real one to do it.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['*.fixture.ts'],
    environment: 'node',
    hookTimeout: 1_000,
    pool: 'forks',
    reporters: [
      'default',
      requiredGroups([
        {
          // Overridable so the guard can also be exercised against a required
          // group that the run never collected at all.
          module: process.env['FERRET_FIXTURE_REQUIRED'] ?? 'timing-out.fixture.ts',
          guarantee: 'the stand-in for the packaging gate',
        },
      ]),
    ],
  },
});
