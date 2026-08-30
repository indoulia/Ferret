import { DependencyStatus } from './contract.js';
import type { HealthArea, HealthComponent, HealthReport } from './health.js';

/**
 * Turning health into advice.
 *
 * `ferret status` answers "is Ferret working". `ferret doctor` answers "what do
 * I do about it". The difference matters for the Definition of Done, which
 * requires failure modes to have **deterministic classifications**: every
 * finding gets a stable `id` derived from the component and its status, so a
 * script or an AI client can branch on the *kind* of problem rather than
 * pattern-matching English.
 *
 * Every diagnosis carries a remediation. A finding without one tells a user
 * their system is broken and leaves them there, which is worse than not
 * checking.
 */

export const DiagnosisSeverity = {
  /** Ferret cannot do its job until this is fixed. */
  ERROR: 'error',
  /** Ferret works, with reduced capability. */
  WARNING: 'warning',
  /** Could not be determined, or not yet implemented. */
  UNKNOWN: 'unknown',
} as const;

export type DiagnosisSeverity = (typeof DiagnosisSeverity)[keyof typeof DiagnosisSeverity];

export interface Diagnosis {
  /** Stable, machine-branchable, e.g. `postgres:unavailable`. */
  readonly id: string;
  readonly severity: DiagnosisSeverity;
  readonly area: HealthArea;
  /** What is wrong. Never contains a credential. */
  readonly finding: string;
  /** What to do about it. */
  readonly remediation: string;
}

/**
 * Severity of a finding.
 *
 * An *optional* component being unavailable is a warning, not an error: an
 * absent pgvector means semantic search is unavailable, not that Ferret is.
 * This is the same rule the health aggregation applies, kept in one place in
 * spirit — a doctor that disagreed with `status` about severity would be worse
 * than either alone.
 */
export function severityOf(component: HealthComponent): DiagnosisSeverity {
  if (component.status === DependencyStatus.UNKNOWN) return DiagnosisSeverity.UNKNOWN;
  if (component.status === DependencyStatus.DEGRADED) return DiagnosisSeverity.WARNING;
  return component.required ? DiagnosisSeverity.ERROR : DiagnosisSeverity.WARNING;
}

const SEVERITY_ORDER: readonly DiagnosisSeverity[] = [
  DiagnosisSeverity.ERROR,
  DiagnosisSeverity.WARNING,
  DiagnosisSeverity.UNKNOWN,
];

/**
 * A remediation for a component that did not supply one.
 *
 * Deliberately generic and honest: it says what Ferret observed and where to
 * look, rather than guessing at a cause it did not establish.
 */
function fallbackRemediation(component: HealthComponent): string {
  switch (component.status) {
    case DependencyStatus.UNKNOWN:
      return `Ferret could not determine the state of "${component.name}". Re-run with \`--log-level debug\` to see what it attempted.`;
    case DependencyStatus.DEGRADED:
      return `"${component.name}" is working with reduced capability. Features that depend on it stay unavailable.`;
    default:
      return `"${component.name}" is unavailable. Re-run \`ferret doctor --log-level debug\` for detail.`;
  }
}

/**
 * Derives ordered advice from a report.
 *
 * Healthy components produce no diagnosis: a doctor that lists everything that
 * is fine buries the one thing that is not.
 */
export function diagnose(report: HealthReport): Diagnosis[] {
  const diagnoses = report.components
    .filter((component) => component.status !== DependencyStatus.OK)
    .map((component): Diagnosis => ({
      id: `${component.name}:${component.status}`,
      severity: severityOf(component),
      area: component.area,
      finding: component.detail ?? `${component.name} is ${component.status}`,
      remediation: component.remediation ?? fallbackRemediation(component),
    }));

  return diagnoses.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

export interface DoctorReport extends HealthReport {
  readonly diagnoses: readonly Diagnosis[];
  /** How many checks ran, so "no findings" is distinguishable from "no checks". */
  readonly checked: number;
}

export function buildDoctorReport(report: HealthReport): DoctorReport {
  return { ...report, diagnoses: diagnose(report), checked: report.components.length };
}

/** Counts by severity, for a one-line human summary. */
export function countBySeverity(diagnoses: readonly Diagnosis[]): Record<DiagnosisSeverity, number> {
  const counts: Record<DiagnosisSeverity, number> = {
    [DiagnosisSeverity.ERROR]: 0,
    [DiagnosisSeverity.WARNING]: 0,
    [DiagnosisSeverity.UNKNOWN]: 0,
  };
  for (const diagnosis of diagnoses) counts[diagnosis.severity] += 1;
  return counts;
}
