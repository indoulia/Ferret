import { ErrorCode, FerretError } from '../errors/index.js';

/**
 * Counters and histograms — EPIC-092.
 *
 * Four Epics parked metrics here: EPIC-004's "health is point-in-time; no
 * metrics, tracing or history", EPIC-091 §4's "no counters, no histograms",
 * EPIC-095 §4 and EPIC-099 §4. So a run reported counts and one duration for
 * itself, and nothing else could be timed — `verify` could not say which stage
 * was slow, and an operator could not answer whether last week's index was
 * slower than today's.
 *
 * **No dependency**, which is EPIC-091's decision one layer down: it ships
 * NDJSON to stderr and says "redirecting it is the operator's job and the Unix
 * answer", declining a log shipper. A metric is a name, a number and a few
 * labels; it needs no vendor SDK, no exporter pipeline and no background flush.
 * What is adopted is the *format* — see `trace.ts` — not the runtime.
 */

/**
 * What a number means.
 *
 * Declared at registration and **not optional**. `durationMs` and `bytes` read
 * alike in JSON and mean nothing alike, which is how a dashboard ends up
 * claiming a 34-millisecond file is 34 megabytes.
 */
export const MetricUnit = {
  /** A count of events. */
  COUNT: 'count',
  MILLISECONDS: 'ms',
  BYTES: 'bytes',
  /** A count of rows, files, entities — anything enumerable. */
  ITEMS: 'items',
} as const;

export type MetricUnit = (typeof MetricUnit)[keyof typeof MetricUnit];

/**
 * Every metric Ferret records, in one place — EPIC-092 §8.2.
 *
 * Declared here rather than at each call site so the set is greppable and two
 * areas cannot register the same name with different units. A name is
 * `ferret.<area>.<thing>`.
 */
export const Metric = {
  /** How long one index stage took. */
  INDEX_STAGE_MS: 'ferret.index.stage_ms',
  /** How long one file's content stage took. */
  CONTENT_FILE_MS: 'ferret.content.file_ms',
  /** Files the content stage parsed. */
  CONTENT_PARSED: 'ferret.content.parsed',
  /** How long one search took. */
  RETRIEVAL_SEARCH_MS: 'ferret.retrieval.search_ms',
  /** How long one traversal took. */
  RETRIEVAL_TRAVERSE_MS: 'ferret.retrieval.traverse_ms',
  /** One-hop reads a traversal issued — the claim EPIC-050 §13 makes. */
  RETRIEVAL_TRAVERSE_HOPS: 'ferret.retrieval.traverse_hops',
  /** How long a verify sweep took. */
  VERIFY_MS: 'ferret.verify.ms',
} as const;

export type Metric = (typeof Metric)[keyof typeof Metric];

/**
 * Bucket boundaries, in the instrument's own unit.
 *
 * One set for durations and one for counts, rather than per instrument: a
 * bucket boundary nobody chose is worse than a coarse one everybody
 * understands, and these are the magnitudes Ferret's own runs actually span —
 * a parse is single-digit milliseconds and an index run is minutes.
 */
const DURATION_BUCKETS: readonly number[] = Object.freeze([1, 10, 100, 1_000, 10_000, 60_000]);
const COUNT_BUCKETS: readonly number[] = Object.freeze([1, 10, 100, 1_000, 10_000]);

interface Registration {
  readonly unit: MetricUnit;
  readonly histogram: boolean;
}

/** What a histogram observed. */
export interface HistogramValue {
  readonly unit: MetricUnit;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  /** Upper bound to how many observations fell at or below it. */
  readonly buckets: Readonly<Record<string, number>>;
}

export interface CounterValue {
  readonly unit: MetricUnit;
  readonly total: number;
}

/** Everything measured, at one moment — EPIC-092 §8.4. */
export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, CounterValue>>;
  readonly histograms: Readonly<Record<string, HistogramValue>>;
}

/**
 * Instruments, and what they have seen.
 *
 * Per process rather than global-by-import, so a test can hold its own and two
 * runtimes in one process do not share totals. `defaultMetrics()` is the one a
 * caller uses when it has no reason to care.
 */
export class MetricsRegistry {
  readonly #registered = new Map<string, Registration>();
  readonly #counters = new Map<string, number>();
  readonly #histograms = new Map<string, { count: number; sum: number; min: number; max: number; buckets: number[] }>();

  /**
   * Declares a counter.
   *
   * Registering twice with the same unit is a no-op, because two modules may
   * legitimately both declare what they record. With a *different* unit it
   * throws: that is the defect §8.2 exists to catch, and catching it at
   * registration is cheaper than reading a wrong number later.
   */
  counter(name: string, unit: MetricUnit): void {
    this.#declare(name, { unit, histogram: false });
    if (!this.#counters.has(name)) this.#counters.set(name, 0);
  }

  histogram(name: string, unit: MetricUnit): void {
    this.#declare(name, { unit, histogram: true });
    if (!this.#histograms.has(name)) {
      const bounds = unit === MetricUnit.MILLISECONDS ? DURATION_BUCKETS : COUNT_BUCKETS;
      this.#histograms.set(name, {
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        buckets: bounds.map(() => 0),
      });
    }
  }

  #declare(name: string, registration: Registration): void {
    const existing = this.#registered.get(name);
    if (existing === undefined) {
      this.#registered.set(name, registration);
      return;
    }
    if (existing.unit === registration.unit && existing.histogram === registration.histogram) return;
    throw new FerretError(ErrorCode.USAGE, `Metric "${name}" is already registered differently`, {
      details: { name, existing, requested: registration },
      remediation: 'One metric name means one instrument and one unit. Declare a new name instead.',
    });
  }

  /**
   * Adds to a counter.
   *
   * An unregistered name throws rather than registering itself. A metric that
   * appears because somebody mistyped a name is a number nobody can trust, and
   * §8.2's greppable set is the property being protected.
   */
  add(name: string, amount = 1): void {
    const registration = this.#require(name, false);
    void registration;
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + amount);
  }

  /** Records one observation. */
  observe(name: string, value: number): void {
    this.#require(name, true);
    const state = this.#histograms.get(name);
    if (state === undefined) return;
    const bounds = this.#registered.get(name)?.unit === MetricUnit.MILLISECONDS ? DURATION_BUCKETS : COUNT_BUCKETS;

    state.count += 1;
    state.sum += value;
    state.min = Math.min(state.min, value);
    state.max = Math.max(state.max, value);
    for (const [index, bound] of bounds.entries()) {
      if (value <= bound) {
        state.buckets[index] = (state.buckets[index] ?? 0) + 1;
        break;
      }
    }
  }

  #require(name: string, histogram: boolean): Registration {
    const registration = this.#registered.get(name);
    if (registration === undefined) {
      throw new FerretError(ErrorCode.USAGE, `Metric "${name}" was never registered`, {
        details: { name },
        remediation: 'Declare the instrument in `Metric` and register it before recording.',
      });
    }
    if (registration.histogram !== histogram) {
      throw new FerretError(ErrorCode.USAGE, `Metric "${name}" is not a ${histogram ? 'histogram' : 'counter'}`, {
        details: { name, registration },
        remediation: histogram ? 'Use add() for a counter.' : 'Use observe() for a histogram.',
      });
    }
    return registration;
  }

  /**
   * Everything measured so far.
   *
   * A plain object, sorted, so two snapshots of the same state serialise
   * identically — which is what makes AC-13's "two runs are comparable" a
   * property rather than a hope. A histogram that observed nothing reports
   * zeroes rather than infinities, because `Infinity` is not JSON.
   */
  snapshot(): MetricsSnapshot {
    const counters: Record<string, CounterValue> = {};
    for (const name of [...this.#counters.keys()].sort()) {
      counters[name] = {
        unit: this.#registered.get(name)?.unit ?? MetricUnit.COUNT,
        total: this.#counters.get(name) ?? 0,
      };
    }

    const histograms: Record<string, HistogramValue> = {};
    for (const name of [...this.#histograms.keys()].sort()) {
      const state = this.#histograms.get(name);
      if (state === undefined) continue;
      const unit = this.#registered.get(name)?.unit ?? MetricUnit.COUNT;
      const bounds = unit === MetricUnit.MILLISECONDS ? DURATION_BUCKETS : COUNT_BUCKETS;
      const buckets: Record<string, number> = {};
      for (const [index, bound] of bounds.entries()) buckets[`<=${String(bound)}`] = state.buckets[index] ?? 0;

      histograms[name] = {
        unit,
        count: state.count,
        sum: state.sum,
        min: state.count === 0 ? 0 : state.min,
        max: state.count === 0 ? 0 : state.max,
        buckets,
      };
    }
    return Object.freeze({ counters: Object.freeze(counters), histograms: Object.freeze(histograms) });
  }
}

/**
 * The registry with every declared instrument already registered.
 *
 * One call site for the whole `Metric` vocabulary, so `add` and `observe` can
 * refuse an unregistered name without every caller remembering to declare.
 */
export function createMetricsRegistry(): MetricsRegistry {
  const registry = new MetricsRegistry();
  registry.histogram(Metric.INDEX_STAGE_MS, MetricUnit.MILLISECONDS);
  registry.histogram(Metric.CONTENT_FILE_MS, MetricUnit.MILLISECONDS);
  registry.counter(Metric.CONTENT_PARSED, MetricUnit.ITEMS);
  registry.histogram(Metric.RETRIEVAL_SEARCH_MS, MetricUnit.MILLISECONDS);
  registry.histogram(Metric.RETRIEVAL_TRAVERSE_MS, MetricUnit.MILLISECONDS);
  registry.histogram(Metric.RETRIEVAL_TRAVERSE_HOPS, MetricUnit.ITEMS);
  registry.histogram(Metric.VERIFY_MS, MetricUnit.MILLISECONDS);
  return registry;
}

let processRegistry: MetricsRegistry | undefined;

/**
 * The process's registry.
 *
 * One process is one invocation — EPIC-091 §3.1 — so the totals a run reports
 * are the process's totals, and a caller with no reason to hold its own uses
 * this.
 */
export function defaultMetrics(): MetricsRegistry {
  processRegistry ??= createMetricsRegistry();
  return processRegistry;
}
