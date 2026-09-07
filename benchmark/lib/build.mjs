/**
 * Refuse to attribute numbers to a build that does not exist yet.
 *
 * A harness runs against `dist/`, and nothing made it check that `dist/` was
 * built from the working tree. Hit while doing exactly that: a run made after a
 * rebase failed measured a build from before a merged retrieval fix, and its
 * numbers were committed as the current ones — `ferret_search` reported as
 * sourcing 32% of tasks where the build under test scores 42%. Nothing was
 * wrong with the run; it measured what it was pointed at, and said nothing
 * about what that was.
 *
 * So the newest source file is compared with the built entrypoint, and every
 * report carries the commit and whether the tree was dirty. A stale result is
 * indistinguishable from a regression, which is the failure
 * `tests/unit/golden-dataset.test.ts` prevents one layer down.
 *
 * Shared by both benchmarks rather than copied into each. A guard whose whole
 * purpose is to stop one class of wrong result is a poor thing to keep two
 * versions of.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function newestSourceTime(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSourceTime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

export function assertBuildIsCurrent({ root, cli }) {
  const built = statSync(cli).mtimeMs;
  const newest = newestSourceTime(join(root, 'src'));
  if (built >= newest) return;
  throw new Error(
    'dist/ is older than src/, so this would measure a build that is not the ' +
      'working tree.\nRun `npm run build` first.',
  );
}

/** What produced a set of numbers: a result that cannot name its build is one nobody can contradict. */
export function describeTree(root) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0 };
}
