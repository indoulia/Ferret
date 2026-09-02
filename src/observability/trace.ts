import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { Logger } from '../logging/index.js';

import { MetricUnit, type MetricsRegistry } from './metrics.js';

/**
 * Spans — EPIC-092 §8.3.
 *
 * EPIC-091 left this as an invitation rather than a boundary: "The invocation id
 * in §3.1 is a correlation key for reading stderr, **not** a trace id … If
 * EPIC-092 adopts W3C trace context, this field is renamed or subsumed, and this
 * paragraph is why that is cheap." It was cheap.
 *
 * **The format is adopted; the runtime is not.** `traceparent` is 55 characters
 * this file produces in four lines, so an operator's own collector reading
 * Ferret's NDJSON inherits a standard identifier rather than a Ferret
 * invention — while nothing here opens a socket, speaks OTLP or runs a flush
 * thread. EPIC-092 §8.1.
 */

/** W3C trace-context version, and the only one this produces. */
const TRACE_VERSION = '00';
/** Sampled. Every span is recorded — EPIC-092 §8.3 says why, and what would change it. */
const TRACE_FLAGS = '01';

/**
 * The process's trace id: EPIC-091's invocation id, widened to 16 bytes.
 *
 * The invocation id is 8 bytes and a trace id is 16, so it is the high half and
 * the rest is random once per process. That keeps a log line's `invocation` and
 * a span's `traceparent` greppable against each other — which is the whole
 * reason to subsume the field rather than add a second one.
 *
 * Never accepted from outside the process. EPIC-091 §8 forbids taking a
 * correlation id from a caller, and joining a client's trace would need that
 * rule revisited by whoever owns it — §16 records that.
 */
function traceIdFrom(invocation: string): string {
  // 16 hex from the invocation and 16 random: a trace id is **16 bytes**, which
  // is 32 hex characters. Found by test — with 4 random bytes the id was 24
  // characters and every `traceparent` this file produced would have been
  // rejected by its own validator.
  const high = invocation.replace(/[^0-9a-f]/gi, '').slice(0, 16).padEnd(16, '0');
  return `${high}${randomBytes(8).toString('hex')}`.slice(0, 32);
}

export interface SpanRecord {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly durationMs: number;
  readonly failed: boolean;
}

/**
 * Opens and closes spans, and knows which is inside which.
 *
 * Parent/child comes from a **stack**, so a nested `await` inside a stage is a
 * child without the caller threading anything. One tracer per process, for the
 * same reason there is one invocation id.
 */
export class Tracer {
  readonly #traceId: string;
  readonly #stack: string[] = [];
  readonly #logger: Logger | undefined;
  readonly #metrics: MetricsRegistry | undefined;
  readonly #recorded: SpanRecord[] = [];

  constructor(options: {
    readonly invocation: string;
    readonly logger?: Logger;
    readonly metrics?: MetricsRegistry;
  }) {
    this.#traceId = traceIdFrom(options.invocation);
    this.#logger = options.logger;
    this.#metrics = options.metrics;
  }

  get traceId(): string {
    return this.#traceId;
  }

  /** Spans this tracer has closed, for a test or a snapshot to read. */
  get recorded(): readonly SpanRecord[] {
    return [...this.#recorded];
  }

  /**
   * Times `work`, records it, and returns what it returned.
   *
   * **A span that throws is recorded as failed and rethrows.** An observability
   * layer that swallows an error is worse than no observability, and EPIC-093
   * already decides which failures are survivable — this is not the place to
   * make that call again.
   *
   * `metric` is optional: a stage that wants its duration in a histogram as well
   * as a span names one, and one that only wants the span does not.
   */
  async span<T>(
    name: string,
    work: () => Promise<T>,
    options: { readonly metric?: string } = {},
  ): Promise<T> {
    const spanId = randomBytes(8).toString('hex');
    const parentSpanId = this.#stack[this.#stack.length - 1];
    this.#stack.push(spanId);
    const started = performance.now();
    let failed = false;

    try {
      return await work();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // `finally` rather than duplicating the close in both paths, so a failed
      // span is recorded on exactly the same code path as a successful one and
      // cannot drift from it.
      this.#stack.pop();
      const durationMs = performance.now() - started;
      const record: SpanRecord = {
        name,
        traceId: this.#traceId,
        spanId,
        parentSpanId,
        durationMs,
        failed,
      };
      this.#recorded.push(record);

      if (options.metric !== undefined && this.#metrics !== undefined) {
        this.#metrics.observe(options.metric, durationMs);
      }
      // A log record, which is how metrics inherit EPIC-091's redaction, its
      // level gate and its NDJSON framing — EPIC-092 §8.5. `debug`, because a
      // span per file at `info` would drown the messages an operator reads.
      this.#logger?.debug(
        {
          operation: 'trace.span',
          span: name,
          traceparent: traceparentOf(this.#traceId, spanId),
          ...(parentSpanId === undefined ? {} : { parentSpan: parentSpanId }),
          durationMs: Math.round(durationMs * 100) / 100,
          ...(failed ? { failed: true } : {}),
        },
        `${name} took ${durationMs.toFixed(1)}ms`,
      );
    }
  }
}

/**
 * A W3C trace-context header value.
 *
 * `version-traceid-spanid-flags`, lowercase hex, fixed widths — the grammar in
 * four lines, which is §8.1's whole argument for taking the format and
 * declining the SDK.
 */
export function traceparentOf(traceId: string, spanId: string): string {
  return `${TRACE_VERSION}-${traceId}-${spanId}-${TRACE_FLAGS}`;
}

/** True when a string is a `traceparent` this Epic would produce. */
export function isTraceparent(value: string): boolean {
  return /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(value);
}

/** The unit a span's duration is recorded in, named so a caller cannot guess wrong. */
export const SPAN_DURATION_UNIT = MetricUnit.MILLISECONDS;
