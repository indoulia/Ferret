import type { Reporter, TestModule, TestRunEndReason, Vitest } from 'vitest/node';

/**
 * A test group whose execution is part of the release gate.
 *
 * F-73: `tests/integration/packaging.test.ts` prepares its subject in a
 * file-scope `beforeAll` — `npm pack`, then a global install of the tarball,
 * measured at 2.9 s and 29.9 s respectively on an idle machine, the second of
 * which resolves and writes 155 packages and 138 MB. Under full-suite
 * contention that hook exceeded its 300 s budget, and Vitest's response to a
 * hook that never returned is to fail the *module* and mark all 34 tests
 * `skipped`. The `Tests` summary then reads `3366 passed | 41 skipped` — the 34
 * assertions merged into the same bucket as the 7 tests that are deliberately
 * conditional — and the run was read as "zero failing tests".
 *
 * The secret scan of the shipped bytes and the reproducible-tarball assertion
 * are the gate. A run that did not execute them has not cleared it, and this
 * reporter is what says so.
 */
export interface RequiredGroup {
  /** Repository-relative path of the test file, with forward slashes. */
  readonly module: string;
  /** What goes unverified when it does not run. Printed when the guard fires. */
  readonly guarantee: string;
}

interface Census {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Skipped *and* pending together: neither reached an assertion. */
  readonly unexecuted: number;
}

/**
 * Fails a run in which a required test group did not actually execute.
 *
 * Two failure modes, and they need different treatment:
 *
 * - **The group ran but its tests did not.** A dead `beforeAll` — timed out,
 *   threw — leaves the module failed and its tests skipped. Vitest already
 *   exits non-zero for this, so what was missing was never the exit code: it
 *   was a statement of *which* guarantee went unverified, in place of a skip
 *   count that reads as a pass.
 * - **The group was not collected at all.** Nothing fails, because nothing ran.
 *   Only enforced for a whole run — see `#isWholeRun`.
 */
export function requiredGroups(groups: readonly RequiredGroup[]): Reporter {
  return new RequiredGroupsReporter(groups);
}

class RequiredGroupsReporter implements Reporter {
  readonly #groups: readonly RequiredGroup[];
  #vitest: Vitest | undefined;

  constructor(groups: readonly RequiredGroup[]) {
    this.#groups = groups;
  }

  onInit(vitest: Vitest): void {
    this.#vitest = vitest;
  }

  async onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    _errors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): Promise<void> {
    // A cancelled run reports nothing as acceptable, so there is nothing to
    // guard against.
    if (reason === 'interrupted') return;

    const ran = new Map<string, TestModule>();
    for (const module of testModules) ran.set(identify(module), module);

    const whole = await this.#isWholeRun(testModules);
    const verdicts = this.#groups.map((group) => this.#judge(group, ran.get(group.module), whole));

    const failed = verdicts.filter((verdict) => verdict.problem !== undefined);
    if (failed.length === 0) {
      // The positive statement a release reviewer needs, and the reason this
      // line exists at all: "no failures" and "the gate ran" are different
      // claims, and only one of them was ever printed.
      for (const verdict of verdicts) {
        process.stdout.write(
          ` \u001b[32m\u2713\u001b[0m required group ${verdict.module} — ${verdict.detail}\n`,
        );
      }
      return;
    }

    process.stdout.write(
      `\n\u001b[31m\u23af\u23af\u23af\u23af\u23af\u23af Required test groups did not execute \u23af\u23af\u23af\u23af\u23af\u23af\u001b[0m\n\n`,
    );
    for (const verdict of failed) {
      process.stdout.write(` \u001b[31m${verdict.module}\u001b[0m\n`);
      process.stdout.write(`   ${verdict.problem ?? ''}\n`);
      for (const line of verdict.causes) process.stdout.write(`   cause: ${line}\n`);
      process.stdout.write(`   unverified: ${verdict.guarantee}\n\n`);
    }
    process.stdout.write(
      `A skipped test is not a passing test. This run is reported as failed.\n\n`,
    );

    // Set after the reporter list has been reached, which is after Vitest has
    // already decided the run's own exit code (`cli-api`: `if (state !==
    // "passed") process.exitCode = 1`). Nothing downstream sets it back to 0,
    // so this only ever escalates.
    process.exitCode = 1;
  }

  #judge(
    group: RequiredGroup,
    module: TestModule | undefined,
    whole: boolean,
  ): {
    module: string;
    guarantee: string;
    detail: string;
    problem: string | undefined;
    causes: readonly string[];
  } {
    const base = { module: group.module, guarantee: group.guarantee, causes: [] as string[] };

    if (module === undefined) {
      return whole
        ? {
            ...base,
            detail: 'not collected',
            problem: 'the module was not collected by this run',
          }
        : { ...base, detail: 'not selected by this filtered run', problem: undefined };
    }

    const census = take(module);
    const causes = module.errors().map((error) => firstLine(error.message));

    if (module.state() === 'skipped') {
      return { ...base, causes, detail: 'skipped', problem: 'the whole module was skipped' };
    }
    if (census.total === 0) {
      return { ...base, causes, detail: 'no tests', problem: 'the module collected no tests' };
    }
    if (census.unexecuted > 0) {
      return {
        ...base,
        causes,
        detail: `${String(census.unexecuted)} of ${String(census.total)} tests did not execute`,
        problem:
          `${String(census.unexecuted)} of ${String(census.total)} tests did not execute ` +
          `(${String(census.passed)} passed, ${String(census.failed)} failed)`,
      };
    }

    // Every test ran. A test that ran and failed is a failure the default
    // reporter has already named, and repeating it here would only add noise:
    // this guard is about execution, not about outcome.
    return {
      ...base,
      causes,
      detail: `${String(census.total)}/${String(census.total)} tests executed`,
      problem: undefined,
    };
  }

  /**
   * Whether this run collected everything the configuration selects.
   *
   * `vitest run tests/unit`, `--changed` and `-t <pattern>` are all narrower by
   * request, and failing them for the files or tests they were asked not to run
   * would make the iteration loop unusable. Presence is therefore enforced only
   * for a whole run; whatever *did* run is held to full execution either way.
   */
  async #isWholeRun(testModules: ReadonlyArray<TestModule>): Promise<boolean> {
    const vitest = this.#vitest;
    if (vitest === undefined) return false;
    // `-t` leaves every file collected and every non-matching test skipped, so
    // file counts alone cannot tell it apart from a hook that died.
    if (vitest.config.testNamePattern !== undefined) return false;

    const collected = new Set(testModules.map((module) => module.moduleId));
    const selectable = await vitest.globTestSpecifications();
    return selectable.every((specification) => collected.has(specification.moduleId));
  }
}

/** Repository-relative module path, with forward slashes on every platform. */
function identify(module: TestModule): string {
  return module.relativeModuleId.split('\\').join('/');
}

function take(module: TestModule): Census {
  let passed = 0;
  let failed = 0;
  let unexecuted = 0;
  let total = 0;
  for (const test of module.children.allTests()) {
    total += 1;
    const state = test.result().state;
    if (state === 'passed') passed += 1;
    else if (state === 'failed') failed += 1;
    else unexecuted += 1;
  }
  return { total, passed, failed, unexecuted };
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}
