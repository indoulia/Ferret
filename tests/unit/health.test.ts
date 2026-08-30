import { describe, expect, it } from 'vitest';

import {
  DependencyStatus,
  DiagnosisSeverity,
  HealthArea,
  aggregateStatus,
  buildDoctorReport,
  buildReport,
  componentFrom,
  countBySeverity,
  diagnose,
  isUsable,
  severityOf,
  summarize,
  worseOf,
  type HealthComponent,
} from '../../src/index.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { exitCodeForHealth } from '../../src/cli/health.js';

function component(overrides: Partial<HealthComponent> & { name: string }): HealthComponent {
  return {
    area: HealthArea.RUNTIME,
    status: DependencyStatus.OK,
    required: true,
    ...overrides,
  };
}

function report(components: readonly HealthComponent[]) {
  return buildReport({
    components,
    durationMs: 1,
    version: '0.0.0',
    node: '22.0.0',
    platform: 'test/x64',
    now: new Date('2026-08-30T00:00:00Z'),
  });
}

describe('status severity', () => {
  it('orders unknown as worse than degraded, because it is not a pass', () => {
    // Governance §6: a check that could not run must never read as healthy.
    expect(worseOf(DependencyStatus.OK, DependencyStatus.DEGRADED)).toBe(DependencyStatus.DEGRADED);
    expect(worseOf(DependencyStatus.DEGRADED, DependencyStatus.UNKNOWN)).toBe(DependencyStatus.UNKNOWN);
    expect(worseOf(DependencyStatus.UNKNOWN, DependencyStatus.UNAVAILABLE)).toBe(DependencyStatus.UNAVAILABLE);
  });

  it('is commutative', () => {
    const all = [
      DependencyStatus.OK,
      DependencyStatus.DEGRADED,
      DependencyStatus.UNKNOWN,
      DependencyStatus.UNAVAILABLE,
    ];
    for (const a of all) for (const b of all) expect(worseOf(a, b)).toBe(worseOf(b, a));
  });

  it('treats an unrecognized status as the worst case, not the best', () => {
    const rogue = 'invented' as DependencyStatus;
    expect(worseOf(DependencyStatus.OK, rogue)).toBe(rogue);
  });
});

describe('aggregation', () => {
  it('reports healthy only when every component is ok', () => {
    expect(aggregateStatus([component({ name: 'a' }), component({ name: 'b' })])).toBe(DependencyStatus.OK);
  });

  it('lets a required failure make Ferret unusable', () => {
    const status = aggregateStatus([
      component({ name: 'a' }),
      component({ name: 'db', status: DependencyStatus.UNAVAILABLE, required: true }),
    ]);
    expect(status).toBe(DependencyStatus.UNAVAILABLE);
    expect(isUsable(status)).toBe(false);
  });

  it('never lets an optional failure make Ferret unusable', () => {
    // An absent pgvector means semantic search is unavailable, not that Ferret
    // is. This is what keeps health useful on an installation that has
    // deliberately not enabled everything.
    const status = aggregateStatus([
      component({ name: 'a' }),
      component({ name: 'pgvector', status: DependencyStatus.UNAVAILABLE, required: false }),
    ]);
    expect(status).toBe(DependencyStatus.DEGRADED);
    expect(isUsable(status)).toBe(true);
  });

  it('degrades rather than unknowns when an optional check could not run', () => {
    const status = aggregateStatus([
      component({ name: 'index', status: DependencyStatus.UNKNOWN, required: false }),
    ]);
    expect(status).toBe(DependencyStatus.DEGRADED);
  });

  it('reports unknown when a required check could not run', () => {
    const status = aggregateStatus([
      component({ name: 'db', status: DependencyStatus.UNKNOWN, required: true }),
    ]);
    expect(status).toBe(DependencyStatus.UNKNOWN);
    expect(isUsable(status)).toBe(false);
  });

  it('is empty-safe', () => {
    expect(aggregateStatus([])).toBe(DependencyStatus.OK);
  });
});

describe('summary', () => {
  it('states the count when everything passed', () => {
    expect(summarize(DependencyStatus.OK, [component({ name: 'a' }), component({ name: 'b' })])).toContain(
      '2 checks passed',
    );
  });

  it('headlines the actionable required finding over an optional undetermined one', () => {
    // `unknown` outranks `degraded` for the verdict, but a pending migration is
    // what the operator can act on — an unimplemented capability is not.
    const summary = summarize(DependencyStatus.DEGRADED, [
      component({
        name: 'postgres-schema',
        status: DependencyStatus.DEGRADED,
        required: true,
        detail: '1 migration pending',
      }),
      component({
        name: 'index-integrity',
        status: DependencyStatus.UNKNOWN,
        required: false,
        detail: 'no index yet',
      }),
    ]);
    expect(summary).toContain('1 migration pending');
    expect(summary).toContain('+1 more finding');
    expect(summary).toContain('ferret doctor');
  });

  it('says a verdict could not be determined rather than implying a pass', () => {
    const summary = summarize(DependencyStatus.UNKNOWN, [
      component({ name: 'db', status: DependencyStatus.UNKNOWN, detail: 'could not connect' }),
    ]);
    expect(summary).toContain('could not be determined');
    expect(summary).not.toContain('healthy');
  });
});

describe('report', () => {
  it('carries the verdict, the components and an identifying header', () => {
    const built = report([component({ name: 'node' })]);
    expect(built.status).toBe(DependencyStatus.OK);
    expect(built.checkedAt).toBe('2026-08-30T00:00:00.000Z');
    expect(built.ferret).toStrictEqual({ version: '0.0.0', node: '22.0.0', platform: 'test/x64' });
  });

  it('converts a provider dependency result into a component, keeping remediation', () => {
    const converted = componentFrom(
      {
        name: 'postgres',
        status: DependencyStatus.UNAVAILABLE,
        required: true,
        detail: 'refused',
        remediation: 'start it',
      },
      HealthArea.DATABASE,
    );
    expect(converted).toStrictEqual({
      name: 'postgres',
      area: HealthArea.DATABASE,
      status: DependencyStatus.UNAVAILABLE,
      required: true,
      detail: 'refused',
      remediation: 'start it',
    });
  });

  it('omits absent optional fields rather than rendering them as undefined', () => {
    const converted = componentFrom(
      { name: 'x', status: DependencyStatus.OK, required: false },
      HealthArea.RUNTIME,
    );
    expect('detail' in converted).toBe(false);
    expect('remediation' in converted).toBe(false);
  });
});

describe('diagnosis', () => {
  it('classifies a required failure as an error and an optional one as a warning', () => {
    expect(severityOf(component({ name: 'a', status: DependencyStatus.UNAVAILABLE, required: true }))).toBe(
      DiagnosisSeverity.ERROR,
    );
    expect(severityOf(component({ name: 'a', status: DependencyStatus.UNAVAILABLE, required: false }))).toBe(
      DiagnosisSeverity.WARNING,
    );
    expect(severityOf(component({ name: 'a', status: DependencyStatus.DEGRADED, required: true }))).toBe(
      DiagnosisSeverity.WARNING,
    );
    expect(severityOf(component({ name: 'a', status: DependencyStatus.UNKNOWN, required: true }))).toBe(
      DiagnosisSeverity.UNKNOWN,
    );
  });

  it('reports nothing for a healthy system, so a finding is never buried', () => {
    expect(diagnose(report([component({ name: 'a' }), component({ name: 'b' })]))).toStrictEqual([]);
  });

  it('gives every finding a stable id a script can branch on', () => {
    // The Definition of Done requires deterministic classification: callers
    // must not have to pattern-match English.
    const diagnoses = diagnose(
      report([
        component({ name: 'postgres', status: DependencyStatus.UNAVAILABLE, detail: 'refused' }),
        component({ name: 'git', status: DependencyStatus.DEGRADED, required: false, detail: 'absent' }),
      ]),
    );
    expect(diagnoses.map((diagnosis) => diagnosis.id)).toStrictEqual([
      'postgres:unavailable',
      'git:degraded',
    ]);
  });

  it('orders errors before warnings before undetermined findings', () => {
    const diagnoses = diagnose(
      report([
        component({ name: 'unknown-thing', status: DependencyStatus.UNKNOWN, required: false }),
        component({ name: 'optional-thing', status: DependencyStatus.DEGRADED, required: false }),
        component({ name: 'required-thing', status: DependencyStatus.UNAVAILABLE, required: true }),
      ]),
    );
    expect(diagnoses.map((diagnosis) => diagnosis.severity)).toStrictEqual([
      DiagnosisSeverity.ERROR,
      DiagnosisSeverity.WARNING,
      DiagnosisSeverity.UNKNOWN,
    ]);
  });

  it('always supplies a remediation, even when the component gave none', () => {
    // A finding without a remediation tells a user their system is broken and
    // leaves them there.
    const diagnoses = diagnose(
      report([component({ name: 'mystery', status: DependencyStatus.UNAVAILABLE })]),
    );
    expect(diagnoses[0]?.remediation.length).toBeGreaterThan(0);
    expect(diagnoses[0]?.remediation).toContain('mystery');
  });

  it('counts by severity, and reports how many checks ran', () => {
    const built = buildDoctorReport(
      report([
        component({ name: 'a' }),
        component({ name: 'b', status: DependencyStatus.UNAVAILABLE }),
        component({ name: 'c', status: DependencyStatus.DEGRADED, required: false }),
      ]),
    );
    expect(built.checked).toBe(3);
    expect(countBySeverity(built.diagnoses)).toStrictEqual({ error: 1, warning: 1, unknown: 0 });
  });
});

describe('exit codes', () => {
  it('exits 0 when healthy', () => {
    expect(exitCodeForHealth(report([component({ name: 'a' })]))).toBe(ExitCode.OK);
  });

  it('exits 0 when degraded, because Ferret is genuinely usable', () => {
    // An absent pgvector should not fail a CI job that does not use semantic
    // search.
    const degraded = report([component({ name: 'pgvector', status: DependencyStatus.DEGRADED, required: false })]);
    expect(exitCodeForHealth(degraded)).toBe(ExitCode.OK);
  });

  it('exits non-zero for a degraded system under --strict', () => {
    const degraded = report([component({ name: 'pgvector', status: DependencyStatus.DEGRADED, required: false })]);
    expect(exitCodeForHealth(degraded, true)).toBe(ExitCode.DEPENDENCY);
  });

  it('attributes the code to what must be fixed', () => {
    // Deterministic classification: the code says which kind of problem it is,
    // so a script can act without parsing text.
    const configuration = report([
      component({
        name: 'database-configured',
        area: HealthArea.CONFIGURATION,
        status: DependencyStatus.UNAVAILABLE,
      }),
    ]);
    const schema = report([
      component({ name: 'postgres-schema', area: HealthArea.SCHEMA, status: DependencyStatus.UNAVAILABLE }),
    ]);
    const database = report([
      component({ name: 'postgres', area: HealthArea.DATABASE, status: DependencyStatus.UNAVAILABLE }),
    ]);

    expect(exitCodeForHealth(configuration)).toBe(ExitCode.CONFIG);
    expect(exitCodeForHealth(schema)).toBe(ExitCode.STORAGE);
    expect(exitCodeForHealth(database)).toBe(ExitCode.DEPENDENCY);
  });

  it('ignores an optional component when choosing the code', () => {
    const mixed = report([
      component({ name: 'pgvector', area: HealthArea.EXTENSIONS, status: DependencyStatus.UNAVAILABLE, required: false }),
      component({ name: 'postgres', area: HealthArea.DATABASE, status: DependencyStatus.UNAVAILABLE, required: true }),
    ]);
    expect(exitCodeForHealth(mixed)).toBe(ExitCode.DEPENDENCY);
  });
});
