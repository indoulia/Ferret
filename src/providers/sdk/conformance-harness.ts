import { runConformance, type ConformanceOptions, type ConformanceReport } from './conformance.js';

/**
 * Running EPIC-016's suite over every provider at once — EPIC-099.
 *
 * EPIC-016 built the suite, and built it well: eighteen stable checks, a
 * structured report, an assertion helper, published for authors outside this
 * repository. Its AC-11 applied the suite to Ferret's own providers, and that
 * was done — **by hand, three times, in three files**.
 *
 * Nothing enumerated the set. A fourth provider is conformant only if somebody
 * remembers to write a fourth test, and the failure mode is silence. That is
 * the shape of every defect EPIC-100 was written for: a control correctly
 * applied to the subjects someone listed, and not to the subject nobody listed.
 *
 * This adds no check and changes no report. It runs the existing suite over a
 * set and aggregates the existing shape, so a check id means the same thing
 * here as in the suite that produced it.
 */

export interface ProviderUnderTest extends ConformanceOptions {
  /** How the provider is named in the summary, before it has been constructed. */
  readonly name: string;
}

export interface ConformanceAggregate {
  /** One report per provider, in the order they were supplied. */
  readonly reports: readonly ConformanceReport[];
  readonly providers: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** True when every provider is conformant. */
  readonly conformant: boolean;
  /** `providerId: checkId` for every failure, so one run names them all. */
  readonly failures: readonly string[];
}

/**
 * Runs the conformance suite over several providers.
 *
 * Sequentially, not concurrently: a provider's lifecycle checks initialize and
 * shut it down repeatedly, and two providers contending for the same external
 * resource would produce a failure about scheduling rather than about
 * conformance.
 *
 * A provider whose factory throws is a conformance failure, not an exception
 * for the caller to handle — "cannot be constructed" is the most basic way to
 * fail the contract, and a harness that propagated it would report nothing
 * about the providers after it.
 */
export async function runProviderConformance(
  providers: readonly ProviderUnderTest[],
): Promise<ConformanceAggregate> {
  const reports: ConformanceReport[] = [];

  for (const provider of providers) {
    try {
      reports.push(await runConformance(provider));
    } catch (error) {
      reports.push({
        providerId: provider.name,
        checks: [
          {
            id: 'contract.registers',
            title: 'The provider registers in a fresh registry',
            status: 'fail',
            detail: `the provider could not be constructed or run: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        passed: 0,
        failed: 1,
        skipped: 0,
        conformant: false,
      });
    }
  }

  const failures = reports.flatMap((report) =>
    report.checks.filter((check) => check.status === 'fail').map((check) => `${report.providerId}: ${check.id}`),
  );

  return {
    reports,
    providers: reports.length,
    passed: reports.reduce((total, report) => total + report.passed, 0),
    failed: reports.reduce((total, report) => total + report.failed, 0),
    skipped: reports.reduce((total, report) => total + report.skipped, 0),
    conformant: reports.every((report) => report.conformant),
    failures,
  };
}

/**
 * One line per provider, for a run to state its own scope — AC-6.
 *
 * A passing gate that does not say what it covered is the failure mode EPIC-100
 * named: "the suite passed" over an empty set looks exactly like success.
 */
export function summarizeConformance(aggregate: ConformanceAggregate): string {
  const lines = aggregate.reports.map(
    (report) =>
      `  ${report.conformant ? 'ok  ' : 'FAIL'} ${report.providerId.padEnd(32)} ` +
      `${String(report.passed)} passed, ${String(report.failed)} failed, ${String(report.skipped)} skipped`,
  );
  return [
    `${String(aggregate.providers)} provider(s), ${String(aggregate.passed)} checks passed, ` +
      `${String(aggregate.failed)} failed, ${String(aggregate.skipped)} skipped`,
    ...lines,
  ].join('\n');
}
