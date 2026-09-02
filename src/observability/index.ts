/**
 * Metrics and tracing — EPIC-092.
 *
 * Core, and deliberately dependency-free: a metric is a name, a number and a
 * unit; a span is a name, two instants and a parent. EPIC-091 shipped NDJSON to
 * stderr rather than a log shipper, and this is the same decision one layer up —
 * the *format* is adopted (W3C trace context) and the runtime is not.
 */

export {
  Metric,
  MetricUnit,
  MetricsRegistry,
  createMetricsRegistry,
  defaultMetrics,
  type CounterValue,
  type HistogramValue,
  type MetricsSnapshot,
} from './metrics.js';

export {
  SPAN_DURATION_UNIT,
  Tracer,
  isTraceparent,
  traceparentOf,
  type SpanRecord,
} from './trace.js';
