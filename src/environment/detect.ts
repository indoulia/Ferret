import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { scrubEnvironment } from '../security/subprocess.js';
import { SUPPORTED_NODE_RANGE, VERSION } from '../version.js';

const execFileAsync = promisify(execFile);

/** Minimum Node.js major version, derived from the package `engines` range. */
export const MINIMUM_NODE_MAJOR = Number.parseInt(
  /(\d+)/.exec(SUPPORTED_NODE_RANGE)?.[1] ?? '22',
  10,
);

export interface GitInfo {
  /** Whether a `git` executable was found on PATH. */
  readonly available: boolean;
  /** Reported version, e.g. `2.55.0`. Undefined when unavailable. */
  readonly version?: string;
}

export interface EnvironmentReport {
  readonly ferretVersion: string;
  readonly node: {
    readonly version: string;
    readonly major: number;
    readonly supportedRange: string;
    readonly supported: boolean;
  };
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cwd: string;
  readonly interactive: boolean;
  readonly git: GitInfo;
}

function nodeMajor(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '0', 10);
}

/**
 * Locates the Git executable and reports its version.
 *
 * `execFile` is used rather than `exec` so the argument vector is passed
 * directly to the OS: there is no shell, and therefore no shell metacharacter
 * interpretation. Governance §12 — Ferret must not establish unsafe subprocess
 * primitives that later Epics inherit.
 *
 * The environment is scrubbed of credentials — EPIC-081 AC-9. This call passed
 * no `env` at all, so its child inherited the parent's whole environment,
 * including `FERRET_DATABASE_PASSWORD`, without even the Git-redirect scrub the
 * runner applies. It is `git --version` and reads nothing, which is exactly why
 * it was missed: the least consequential subprocess in the codebase was the one
 * handing on the most.
 *
 * Through the runner's `scrubEnvironment` rather than `withoutCredentials`
 * alone, since Batch 6. Two spawners with two environment policies is the
 * divergence F-71 is an instance of, and the weaker of the two is the one
 * nobody looks at: this call still inherited `GIT_DIR`, `GIT_CONFIG_GLOBAL` and
 * the rest. There is no cost to it reading exactly what every other `git`
 * Ferret starts reads.
 */
export async function detectGit(timeoutMs = 5_000): Promise<GitInfo> {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], {
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      env: scrubEnvironment(process.env),
    });
    const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
    return version === undefined ? { available: true } : { available: true, version };
  } catch {
    // Absence is a fact to report, not an error to raise. `ferret doctor`
    // (EPIC-004) decides whether it matters for a given operation.
    return { available: false };
  }
}

/**
 * Collects the facts about the host that Ferret's behaviour depends on.
 *
 * Reports facts only: no health verdict is rendered here. Interpreting these
 * facts as healthy, degraded or unavailable belongs to EPIC-004.
 *
 * Never throws and never mutates host state.
 */
export async function detectEnvironment(): Promise<EnvironmentReport> {
  const version = process.versions.node;
  const major = nodeMajor(version);
  return {
    ferretVersion: VERSION,
    node: {
      version,
      major,
      supportedRange: SUPPORTED_NODE_RANGE,
      supported: major >= MINIMUM_NODE_MAJOR,
    },
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    interactive: process.stdout.isTTY === true,
    git: await detectGit(),
  };
}
