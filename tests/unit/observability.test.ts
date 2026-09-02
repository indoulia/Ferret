import { describe, expect, it } from 'vitest';

import {
  ErrorCode,
  Metric,
  MetricUnit,
  MetricsRegistry,
  Tracer,
  createMetricsRegistry,
  createNullLogger,
  isTraceparent,
  traceparentOf,
  type FerretError,
} from '../../src/index.js';

/**
 * EPIC-092, without a database.
 *
 * Every instrument, every refusal, and the span stack — all pure. The claims
 * that need a real run (a duration per stage, a snapshot in the run journal)
 * are in the integration suite.
 */

const codeOf = (error: unknown): string => (error as FerretError).code;

describe('counters and histograms — AC-1, AC-2', () => {
  it('counts', () => {
    const metrics = new MetricsRegistry();
    metrics.counter('ferret.test.things', MetricUnit.ITEMS);

    metrics.add('ferret.test.things');
    metrics.add('ferret.test.things', 4);

    expect(metrics.snapshot().counters['ferret.test.things']).toStrictEqual({
      unit: 'items',
      total: 5,
    });
  });

  it('records count, sum, min, max and buckets', () => {
    const metrics = new MetricsRegistry();
    metrics.histogram('ferret.test.took_ms', MetricUnit.MILLISECONDS);

    for (const value of [0.5, 5, 50, 5_000]) metrics.observe('ferret.test.took_ms', value);
    const value = metrics.snapshot().histograms['ferret.test.took_ms'];

    expect(value?.count).toBe(4);
    expect(value?.sum).toBe(5_055.5);
    expect(value?.min).toBe(0.5);
    expect(value?.max).toBe(5_000);
    // One observation in each of four duration buckets.
    expect(value?.buckets['<=1']).toBe(1);
    expect(value?.buckets['<=10']).toBe(1);
    expect(value?.buckets['<=100']).toBe(1);
    expect(value?.buckets['<=10000']).toBe(1);
  });

  it('reports zeroes for a histogram that observed nothing, not infinities', () => {
    // `Infinity` is not JSON, and a snapshot that cannot serialise is a snapshot
    // that cannot reach the run journal.
    const metrics = new MetricsRegistry();
    metrics.histogram('ferret.test.unused_ms', MetricUnit.MILLISECONDS);
    const value = metrics.snapshot().histograms['ferret.test.unused_ms'];

    expect(value?.min).toBe(0);
    expect(value?.max).toBe(0);
    expect(JSON.stringify(value)).toContain('"min":0');
  });
});

describe('a unit is not optional — AC-3, AC-4', () => {
  it('refuses the same name with a different unit', () => {
    // `durationMs` and `bytes` read alike in JSON and mean nothing alike, which
    // is how a dashboard claims a 34-millisecond file is 34 megabytes.
    const metrics = new MetricsRegistry();
    metrics.counter('ferret.test.size', MetricUnit.BYTES);

    expect(() => metrics.counter('ferret.test.size', MetricUnit.ITEMS)).toThrow(/already registered/);
  });

  it('accepts the same name with the same unit, so two modules may both declare it', () => {
    const metrics = new MetricsRegistry();
    metrics.counter('ferret.test.size', MetricUnit.BYTES);

    expect(() => metrics.counter('ferret.test.size', MetricUnit.BYTES)).not.toThrow();
  });

  it('refuses a recording on a name nobody registered — AC-4', () => {
    // A metric that appears because somebody mistyped a name is a number nobody
    // can trust.
    const metrics = new MetricsRegistry();

    try {
      metrics.add('ferret.test.typo');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(codeOf(error)).toBe(ErrorCode.USAGE);
    }
  });

  it('refuses a counter recorded as a histogram, and the reverse', () => {
    const metrics = new MetricsRegistry();
    metrics.counter('ferret.test.count', MetricUnit.COUNT);
    metrics.histogram('ferret.test.spread_ms', MetricUnit.MILLISECONDS);

    expect(() => metrics.observe('ferret.test.count', 1)).toThrow(/not a histogram/);
    expect(() => metrics.add('ferret.test.spread_ms')).toThrow(/not a counter/);
  });

  it('registers every declared metric, so a call site cannot be refused for existing', () => {
    const metrics = createMetricsRegistry();

    for (const name of Object.values(Metric)) {
      // Either instrument accepts it; what matters is that the name is known.
      expect(() => {
        try {
          metrics.add(name);
        } catch {
          metrics.observe(name, 1);
        }
      }).not.toThrow();
    }
  });
});

describe('spans — AC-5 to AC-8', () => {
  const tracer = (): Tracer => new Tracer({ invocation: 'a1b2c3d4e5f60718', logger: createNullLogger() });

  it('records a duration for work that took time — AC-5', async () => {
    const trace = tracer();

    await trace.span('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    expect(trace.recorded).toHaveLength(1);
    expect(trace.recorded[0]?.durationMs).toBeGreaterThan(0);
    expect(trace.recorded[0]?.failed).toBe(false);
  });

  it('names its parent without the caller passing one — AC-6', async () => {
    const trace = tracer();

    await trace.span('outer', async () => {
      await trace.span('inner', () => Promise.resolve());
    });

    const inner = trace.recorded.find((one) => one.name === 'inner');
    const outer = trace.recorded.find((one) => one.name === 'outer');

    expect(inner?.parentSpanId).toBe(outer?.spanId);
    expect(outer?.parentSpanId).toBeUndefined();
  });

  it('does not make siblings each other’s parents — AC-8', async () => {
    const trace = tracer();

    await trace.span('parent', async () => {
      await trace.span('first', () => Promise.resolve());
      await trace.span('second', () => Promise.resolve());
    });

    const parent = trace.recorded.find((one) => one.name === 'parent');
    const first = trace.recorded.find((one) => one.name === 'first');
    const second = trace.recorded.find((one) => one.name === 'second');

    expect(first?.parentSpanId).toBe(parent?.spanId);
    expect(second?.parentSpanId).toBe(parent?.spanId);
    expect(second?.parentSpanId).not.toBe(first?.spanId);
  });

  it('records a failed span and rethrows — AC-7', async () => {
    // An observability layer that swallows an error is worse than no
    // observability, and EPIC-093 already decides what is survivable.
    const trace = tracer();

    await expect(
      trace.span('boom', () => Promise.reject(new Error('the stage failed'))),
    ).rejects.toThrow('the stage failed');

    expect(trace.recorded[0]?.name).toBe('boom');
    expect(trace.recorded[0]?.failed).toBe(true);
  });

  it('unwinds the stack after a failure, so the next span is not its child', async () => {
    const trace = tracer();

    await trace.span('outer', async () => {
      await trace.span('fails', () => Promise.reject(new Error('x'))).catch(() => undefined);
      await trace.span('after', () => Promise.resolve());
    });

    const outer = trace.recorded.find((one) => one.name === 'outer');
    const after = trace.recorded.find((one) => one.name === 'after');

    expect(after?.parentSpanId).toBe(outer?.spanId);
  });

  it('records a duration into a histogram when one is named', async () => {
    const metrics = createMetricsRegistry();
    const trace = new Tracer({ invocation: 'a1b2c3d4e5f60718', metrics });

    await trace.span('stage', () => Promise.resolve(), { metric: Metric.INDEX_STAGE_MS });

    expect(metrics.snapshot().histograms[Metric.INDEX_STAGE_MS]?.count).toBe(1);
  });
});

describe('W3C trace context — AC-9, AC-10', () => {
  it('produces a valid traceparent', () => {
    const value = traceparentOf('0123456789abcdef0123456789abcdef', '0123456789abcdef');

    expect(value).toBe('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
    expect(isTraceparent(value)).toBe(true);
  });

  it('rejects a malformed one', () => {
    for (const bad of [
      '00-tooshort-0123456789abcdef-01',
      '01-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      '00-0123456789ABCDEF0123456789abcdef-0123456789abcdef-01',
      'nonsense',
    ]) {
      expect(isTraceparent(bad), bad).toBe(false);
    }
  });

  it('derives the trace id from the invocation id — AC-9', () => {
    // EPIC-091 invited this: "If EPIC-092 adopts W3C trace context, this field is
    // renamed or subsumed." The invocation id is the high half, so a log line's
    // `invocation` and a span's `traceparent` stay greppable against each other.
    const trace = new Tracer({ invocation: 'a1b2c3d4e5f60718' });

    expect(trace.traceId).toMatch(/^a1b2c3d4e5f60718[0-9a-f]{16}$/);
    expect(trace.traceId).toHaveLength(32);
  });

  it('shares one trace id across every span in the process — AC-10', async () => {
    const trace = new Tracer({ invocation: 'a1b2c3d4e5f60718' });

    await trace.span('one', () => Promise.resolve());
    await trace.span('two', async () => {
      await trace.span('three', () => Promise.resolve());
    });

    expect(new Set(trace.recorded.map((one) => one.traceId)).size).toBe(1);
    expect(trace.recorded[0]?.traceId).toBe(trace.traceId);
  });

  it('produces a valid traceparent for every span it records', async () => {
    const trace = new Tracer({ invocation: 'ffffffffffffffff' });
    await trace.span('one', () => Promise.resolve());

    for (const span of trace.recorded) {
      expect(isTraceparent(traceparentOf(span.traceId, span.spanId))).toBe(true);
    }
  });
});

describe('a snapshot is stable to serialise — AC-11', () => {
  it('serialises identically for identical state', () => {
    const build = (): MetricsRegistry => {
      const metrics = createMetricsRegistry();
      metrics.add(Metric.CONTENT_PARSED, 3);
      metrics.observe(Metric.CONTENT_FILE_MS, 12);
      return metrics;
    };

    expect(JSON.stringify(build().snapshot())).toBe(JSON.stringify(build().snapshot()));
  });

  it('sorts names, so two runs compare by eye as well as by equality', () => {
    const metrics = new MetricsRegistry();
    metrics.counter('ferret.test.z', MetricUnit.COUNT);
    metrics.counter('ferret.test.a', MetricUnit.COUNT);
    metrics.add('ferret.test.z');
    metrics.add('ferret.test.a');

    expect(Object.keys(metrics.snapshot().counters)).toStrictEqual(['ferret.test.a', 'ferret.test.z']);
  });

  it('freezes what it returns', () => {
    const snapshot = createMetricsRegistry().snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.counters)).toBe(true);
  });

  it('is empty but well-formed with no instruments', () => {
    const snapshot = new MetricsRegistry().snapshot();

    expect(snapshot).toStrictEqual({ counters: {}, histograms: {} });
  });
});

describe('metric names are Ferret’s own — EPIC-092 §11', () => {
  it('declares every name under one prefix, so the set is greppable', () => {
    for (const name of Object.values(Metric)) {
      expect(name).toMatch(/^ferret\.[a-z]+\.[a-z_]+$/);
    }
  });

  it('declares each name once', () => {
    const names = Object.values(Metric);

    expect(new Set(names).size).toBe(names.length);
  });
});
