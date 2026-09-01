import { describe, expect, it } from 'vitest';

import { createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';

/**
 * The fixture helper's own failure reporting — issue #61.
 *
 * Not a test of Ferret. A test of the thing every Git integration test depends
 * on to tell the truth when it breaks.
 *
 * `git init` fails intermittently in these fixtures under full-suite load: two
 * of four measured runs, taking between one and twenty-seven tests with it. Every
 * occurrence reported `Command failed: git init -b main <path>` and nothing else,
 * because `promisify(execFile)` puts the child's stderr on a property and the
 * helper never read it. Four runs produced twenty-six occurrences and not one
 * diagnosis.
 *
 * Surfacing the reason does not fix the intermittent — nothing here claims to.
 * It converts the next occurrence from a guess into evidence, which is the step
 * the issue asks for first and the same step that was taken for issue #21.
 */

const version = await gitVersion();
const describeGit = version === undefined ? describe.skip : describe;

if (version === undefined) {
  process.stderr.write('\n[#61] SKIPPING fixture diagnostics: `git` was not found on PATH.\n\n');
}

describeGit('when a fixture Git command fails', () => {
  it('reports what git said, not merely that it failed', async () => {
    const workspace = await createWorkspace('ferret-diagnostics-');
    try {
      // A real failure from real git, rather than a stubbed rejection: the
      // property under test is that *git's own words* survive the helper, and a
      // fake error would only confirm the shape this test already asserts.
      const failure = await git(workspace.path, ['rev-parse', '--verify', 'refs/heads/no-such-branch'])
        .then(() => undefined)
        .catch((error: unknown) => error as Error);

      expect(failure).toBeDefined();
      const message = String(failure?.message ?? '');

      // The exit code, so a caller can tell "git refused" from "git crashed".
      expect(message).toMatch(/exit \d+/);
      // The command, so the failing invocation is identifiable in a parallel run.
      expect(message).toContain('rev-parse');
      // And the part that was being discarded: either git's stderr, or an
      // explicit statement that there was none. Silence must not look like an
      // absent field.
      expect(message).toMatch(/no-such-branch|no stderr/);

      // The original error is kept rather than replaced, so nothing that was
      // available before is lost.
      expect((failure as { cause?: unknown })?.cause).toBeDefined();
    } finally {
      await workspace.cleanup();
    }
  });
});
