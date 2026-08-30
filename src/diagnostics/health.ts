import { DependencyStatus, type DependencyCheckResult } from './contract.js';

/**
 * Ferret's health model.
 *
 * The vocabulary is EPIC-001's {@link DependencyStatus}, reused rather than
 * duplicated so a provider's own check and the top-level verdict cannot drift
 * apart in meaning:
 *
 * - `ok` — observed working.
 * - `degraded` — working with reduced capability. Ferret is usable.
 * - `unavailable` — observed not working. Something Ferret needs is absent.
 * - `unknown` — *could not be determined*. Never a synonym for `ok`.
 *
 * `unknown` carries real weight. Governance §6 forbids manufacturing certainty,
 * so a check that could not run says so, and a check that reports `unknown` for
 * something required makes the whole report `unknown` rather than `ok`. An
 * operator who is told "healthy" by a system that did not actually look has been
 * misled, which is worse than being told nothing.
 */

/** Severity order, worst last. Used to aggregate components into one verdict. */
const SEVERITY: readonly DependencyStatus[] = [
  DependencyStatus.OK,
  DependencyStatus.DEGRADED,
  DependencyStatus.UNKNOWN,
  DependencyStatus.UNAVAILABLE,
];

function rank(status: DependencyStatus): number {
  const index = SEVERITY.indexOf(status);
  // An unrecognized status is treated as the worst case rather than the best.
  return index === -1 ? SEVERITY.length : index;
}

/** The worse of two statuses. */
export function worseOf(a: DependencyStatus, b: DependencyStatus): DependencyStatus {
  return rank(a) >= rank(b) ? a : b;
}

/**
 * Areas of Ferret a report is divided into.
 *
 * Stable identifiers: an AI client or a script may branch on them, and EPIC-095
 * (Operational Diagnostics) extends rather than renames this set.
 */
export const HealthArea = {
  RUNTIME: 'runtime',
  CONFIGURATION: 'configuration',
  DATABASE: 'database',
  SCHEMA: 'schema',
  EXTENSIONS: 'extensions',
  PROVIDERS: 'providers',
  INDEX: 'index',
  SOURCES: 'sources',
} as const;

export type HealthArea = (typeof HealthArea)[keyof typeof HealthArea];

export interface HealthComponent {
  /** Stable identifier, e.g. `postgres-schema`. */
  readonly name: string;
  readonly area: HealthArea;
  readonly status: DependencyStatus;
  /**
   * Whether Ferret can do its job without this.
   *
   * An unhealthy optional component degrades the report; an unhealthy required
   * one makes it unavailable. This is what keeps health useful when an optional
   * provider is down.
   */
  readonly required: boolean;
  /** Human-readable detail. Must never contain a credential. */
  readonly detail?: string;
  /** Concrete action that would resolve an unhealthy result. */
  readonly remediation?: string;
}

export interface HealthReport {
  /** The aggregate verdict. */
  readonly status: DependencyStatus;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly components: readonly HealthComponent[];
  /** One line an operator can read without expanding anything. */
  readonly summary: string;
  readonly ferret: { readonly version: string; readonly node: string; readonly platform: string };
}

/** Turns a provider's dependency result into a component of a report. */
export function componentFrom(result: DependencyCheckResult, area: HealthArea): HealthComponent {
  const component: {
    name: string;
    area: HealthArea;
    status: DependencyStatus;
    required: boolean;
    detail?: string;
    remediation?: string;
  } = {
    name: result.name,
    area,
    status: result.status,
    required: result.required,
  };
  if (result.detail !== undefined) component.detail = result.detail;
  if (result.remediation !== undefined) component.remediation = result.remediation;
  return component;
}

/**
 * Reduces components to one verdict.
 *
 * An *optional* component can never make the whole report `unavailable`: an
 * absent pgvector means semantic search is unavailable, not that Ferret is. It
 * degrades the report instead, which is the distinction that keeps `status`
 * useful on an installation that has deliberately not enabled everything.
 */
export function aggregateStatus(components: readonly HealthComponent[]): DependencyStatus {
  let overall: DependencyStatus = DependencyStatus.OK;
  for (const component of components) {
    const contribution = component.required
      ? component.status
      : component.status === DependencyStatus.OK
        ? DependencyStatus.OK
        : DependencyStatus.DEGRADED;
    overall = worseOf(overall, contribution);
  }
  return overall;
}

/** True when Ferret can serve requests, even if not everything is available. */
export function isUsable(status: DependencyStatus): boolean {
  return status === DependencyStatus.OK || status === DependencyStatus.DEGRADED;
}

/**
 * One line describing the report.
 *
 * Names the specific thing that is wrong rather than saying "3 problems": the
 * summary is what an operator reads first and often all they read.
 */
export function summarize(status: DependencyStatus, components: readonly HealthComponent[]): string {
  const unhealthy = components.filter((component) => component.status !== DependencyStatus.OK);
  if (status === DependencyStatus.OK) {
    return `Ferret is healthy — ${String(components.length)} checks passed.`;
  }

  // Required components lead, then severity. Without the first term a pending
  // migration — which the operator can and should act on — would be headlined
  // by an optional capability that merely does not exist yet, because `unknown`
  // outranks `degraded`. The aggregate verdict is unaffected; only which
  // finding gets named is.
  const worst = [...unhealthy].sort(
    (a, b) => Number(b.required) - Number(a.required) || rank(b.status) - rank(a.status),
  )[0];
  const others = unhealthy.length - 1;
  // "findings", not "issues": some of these are capabilities that do not exist
  // yet rather than things that are broken, and calling those issues would
  // overstate what is wrong.
  const tail = others > 0 ? ` (+${String(others)} more finding${others === 1 ? '' : 's'})` : '';
  const headline = worst?.detail ?? worst?.name ?? 'see `ferret doctor`';

  switch (status) {
    case DependencyStatus.DEGRADED:
      return `Ferret is usable but degraded: ${headline}${tail}. Run \`ferret doctor\` for remediation.`;
    case DependencyStatus.UNKNOWN:
      return `Ferret's health could not be determined: ${headline}${tail}. Run \`ferret doctor\` for detail.`;
    default:
      return `Ferret is not usable: ${headline}${tail}. Run \`ferret doctor\` for remediation.`;
  }
}

export interface BuildReportInput {
  readonly components: readonly HealthComponent[];
  readonly durationMs: number;
  readonly version: string;
  readonly node: string;
  readonly platform: string;
  readonly now?: Date;
}

/** Assembles a report. Pure, so it is trivially testable and cannot fail. */
export function buildReport(input: BuildReportInput): HealthReport {
  const status = aggregateStatus(input.components);
  return {
    status,
    checkedAt: (input.now ?? new Date()).toISOString(),
    durationMs: input.durationMs,
    components: input.components,
    summary: summarize(status, input.components),
    ferret: { version: input.version, node: input.node, platform: input.platform },
  };
}
