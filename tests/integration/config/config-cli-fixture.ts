import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect } from 'vitest';

/**
 * The isolated environment every `ferret config` case runs against.
 *
 * Extracted when `config-cli.test.ts` was split. That file held 26 cases, each
 * spawning a real `ferret` process, and vitest parallelizes across *files* rather
 * than within one — so a single file's cases ran in series and it took 167s of a
 * 177s suite on its own. The topics were already separate `describe` blocks; they
 * are now separate files, and this is the fixture they shared.
 *
 * Nothing about what any case asserts changed. What changed is which process runs
 * it.
 */

export interface ConfigCliContext {
  /** An isolated `FERRET_CONFIG_HOME`, so no case can read the developer's own. */
  home: string;
  /** An empty directory to run in, standing in for a repository. */
  repo: string;
  env: Record<string, string>;
}

/**
 * Registers the per-case fixture and returns the context cases read from.
 *
 * The returned object is **mutated** by `beforeEach` rather than replaced, so a
 * case reading `context.home` at run time sees the directory made for it. Reading
 * it at collection time would see an empty string, which is why the fields are
 * not destructured at the top of a test file.
 */
export function useConfigCli(): ConfigCliContext {
  const context: ConfigCliContext = { home: '', repo: '', env: {} };

  beforeEach(() => {
    context.home = mkdtempSync(join(tmpdir(), 'ferret-cfg-home-'));
    context.repo = mkdtempSync(join(tmpdir(), 'ferret-cfg-repo-'));
    context.env = { FERRET_CONFIG_HOME: context.home };
  });

  afterEach(() => {
    rmSync(context.home, { recursive: true, force: true });
    rmSync(context.repo, { recursive: true, force: true });
  });

  return context;
}

/**
 * Unwraps the CLI's JSON envelope, asserting it reported success.
 *
 * The assertion is here rather than at each call site because a case that meant
 * to read data out of a failed command should fail on the failure, not on a
 * confusing `undefined` three lines later.
 */
export function json<T>(stdout: string): T {
  const envelope = JSON.parse(stdout) as { ok: boolean; data: T };
  expect(envelope.ok).toBe(true);
  return envelope.data;
}
