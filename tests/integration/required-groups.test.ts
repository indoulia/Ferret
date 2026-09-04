import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROOT } from '../helpers/cli.js';

/**
 * F-73 — the release gate may not report a green result for a group it did not
 * run.
 *
 * The defect is not in `packaging.test.ts`; it is in what the harness does with
 * a file-scope hook that overruns. Vitest fails the module and marks every test
 * inside it `skipped`, and the `Tests` summary then merges those into one count
 * with the tests that are deliberately conditional. On this repository that
 * read as `3366 passed | 41 skipped` — the packaging gate's 34 assertions
 * among them — and was recorded as "zero failing tests".
 *
 * Reproducing that against the real packaging suite means waiting five minutes
 * for a hook that installs 155 packages, and only on a machine loaded enough to
 * make it overrun. So it is reproduced against a fixture harness with the same
 * shape — one required group, all of its assertions behind one synchronous
 * hook, a one-second budget — and the assertions below are about the harness,
 * which is where the fix is.
 */

const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const CONFIG = 'tests/fixtures/required-groups/vitest.config.ts';

interface FixtureRun {
  readonly code: number;
  readonly output: string;
}

/**
 * Strips ANSI colour, so an assertion is about content and not about styling.
 *
 * **CI found this, and a local run structurally could not.** Vitest colours its
 * output when it believes the terminal supports it, and GitHub Actions is such
 * a terminal while a redirected local run is not. Coloured, the summary line
 * reads `ESC[2m Tests ESC[22m … ESC[33m2 skipped ESC[39m` — which
 * breaks a `Tests\s+` match, because what follows `Tests ` is an escape rather
 * than whitespace, and breaks `\b2` too, because the character before the `2`
 * is the `m` ending the escape and `m`-to-`2` is not a word boundary. The
 * assertions below passed locally and failed on all four CI platforms at once.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Runs the fixture harness as a real child process.
 *
 * A nested Vitest, deliberately: the guard's contract is the run's *exit code*
 * plus what it printed, and neither is observable from inside the run it
 * governs.
 */
function runFixture(
  env: Readonly<Record<string, string>>,
  filters: readonly string[] = [],
): FixtureRun {
  const result = spawnSync(process.execPath, [VITEST, 'run', '--config', CONFIG, ...filters], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  return {
    code: result.status ?? 1,
    output: stripAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`),
  };
}

describe('a required test group that did not execute', () => {
  it('fails the run, and says which guarantee went unverified', () => {
    const run = runFixture({ FERRET_FIXTURE_HOOK_MS: '4000' });

    expect(run.code).not.toBe(0);
    expect(run.output).toContain('Required test groups did not execute');
    expect(run.output).toContain('timing-out.fixture.ts');
    expect(run.output).toContain('2 of 2 tests did not execute');
    // The cause, not just the symptom. Without this the report says a group did
    // not run and leaves the reader to guess whether it was a filter, a skip
    // condition or a dead hook.
    expect(run.output).toContain('cause: Hook timed out in 1000ms.');
    expect(run.output).toContain('unverified: the stand-in for the packaging gate');
  });

  it('is not distinguishable from a pass in the summary Vitest prints — which is the defect', () => {
    const run = runFixture({ FERRET_FIXTURE_HOOK_MS: '4000' });

    // This assertion is not aspirational. It pins the reason the guard has to
    // exist: Vitest's own `Tests` line reports the two dead assertions as
    // skipped and reports *no* failing test, which is the shape a reader
    // accepted as green. If a future Vitest starts reporting them as failed,
    // this test fails and the guard can be reconsidered on that evidence
    // rather than removed on a guess.
    expect(run.output).toMatch(/Tests\s+[^\n]*\b2 skipped\b/);
    expect(run.output).not.toMatch(/Tests\s+[^\n]*\bfailed\b/);
  });

  it('fails the run when a required group was never collected at all', () => {
    // The other half, and the one nothing failed on before: a run that does not
    // collect the gate at all has no failing test to report, so it was green.
    const run = runFixture({
      FERRET_FIXTURE_HOOK_MS: '0',
      FERRET_FIXTURE_REQUIRED: 'absent.fixture.ts',
    });

    expect(run.code).not.toBe(0);
    expect(run.output).toContain('the module was not collected by this run');
  });
});

describe('a required test group that did execute', () => {
  it('passes, and states that it ran rather than merely not failing', () => {
    const run = runFixture({ FERRET_FIXTURE_HOOK_MS: '0' });

    expect(run.code).toBe(0);
    expect(run.output).toContain('required group timing-out.fixture.ts — 2/2 tests executed');
    expect(run.output).not.toContain('Required test groups did not execute');
  });

  it('does not fail a narrowed run for the files it was asked not to run', () => {
    // `npm run test:unit` and `vitest run <path>` are narrower by request. A
    // guard that failed them would be turned off within a day, which is the
    // usual way a gate stops being a gate.
    const run = runFixture({ FERRET_FIXTURE_HOOK_MS: '0' }, ['other']);

    expect(run.code).toBe(0);
    expect(run.output).toContain('not selected by this filtered run');
    expect(run.output).not.toContain('Required test groups did not execute');
  });
});
