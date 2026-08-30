import type { EnvironmentReport } from '../environment/index.js';
import type { FerretConfig } from '../config/index.js';
import type { Logger } from '../logging/index.js';

/**
 * Health vocabulary shared by the runtime, providers and (from EPIC-004)
 * `ferret status` and `ferret doctor`.
 *
 * `unknown` exists because Governance §6 forbids manufacturing certainty: a
 * check that could not run reports `unknown`, never `ok`.
 */
export const DependencyStatus = {
  OK: 'ok',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
} as const;

export type DependencyStatus = (typeof DependencyStatus)[keyof typeof DependencyStatus];

export interface DependencyCheckResult {
  /** Stable identifier, e.g. `node-version`. */
  readonly name: string;
  readonly status: DependencyStatus;
  /** Whether an unhealthy result must prevent the runtime from becoming ready. */
  readonly required: boolean;
  /** Human-readable detail. Must not contain credentials. */
  readonly detail?: string;
  /** Concrete action that would resolve an unhealthy result. */
  readonly remediation?: string;
}

export interface DependencyCheckContext {
  readonly logger: Logger;
  readonly config: FerretConfig;
  readonly environment: EnvironmentReport;
  readonly signal: AbortSignal;
}

/**
 * A single, side-effect-free health probe.
 *
 * Checks must not mutate state (Governance §20, EPIC-004 acceptance criteria)
 * and must resolve rather than throw; a thrown check is recorded as `unknown`.
 */
export interface DependencyCheck {
  readonly name: string;
  readonly required: boolean;
  run(context: DependencyCheckContext): Promise<DependencyCheckResult> | DependencyCheckResult;
}

export function isHealthy(result: DependencyCheckResult): boolean {
  return result.status === DependencyStatus.OK || result.status === DependencyStatus.DEGRADED;
}
