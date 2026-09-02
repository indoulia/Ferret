import { randomBytes } from 'node:crypto';

import { destination, pino, stdTimeFunctions, type Logger as PinoLogger } from 'pino';

import { REDACTED, isSecretKey, redact, serializeError } from '../errors/index.js';
import { VERSION } from '../version.js';

export const LOG_LEVELS = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Structured fields attached to a log record. */
export type LogFields = Record<string, unknown>;

/**
 * Fields on an emitted record — EPIC-091 AC-4.
 *
 * `operation` is required, so the convention every one of the existing call
 * sites already followed is now checked by the compiler rather than by review.
 * A dotted, stable `component.verb` name: `index.lifecycle`,
 * `runtime.initialize`, `storage.migrate`. The vocabulary is the existing one
 * and this Epic renames none of it.
 *
 * `child()` bindings are deliberately *not* this type: a binding names a
 * component or a repository, and requiring an operation there would force a
 * meaningless one at every composition point.
 */
export interface OperationFields extends LogFields {
  readonly operation: string;
}

/**
 * One invocation, one id — EPIC-091 §8.
 *
 * Opaque and locally generated: no hostname, no username, no path, nothing
 * time-decodable, and never accepted from outside the process. A
 * client-supplied correlation id is input, and input does not get to name
 * Ferret's records.
 *
 * Not a trace id. EPIC-092 owns tracing and may reuse or replace this field;
 * nothing here defines a propagation format.
 */
export function newInvocationId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The id for this process, minted once.
 *
 * Process-scoped rather than threaded through every construction site, and that
 * is the whole design: a CLI invocation builds a logger in `main` and another
 * in the runtime, and threading an id between them would leave every future
 * third construction site out of the correlation by default. One process is one
 * invocation — a CLI run, or an MCP server's stdio session — so the id that
 * makes records correlatable is the one the process already implies.
 *
 * Two concurrent runs are two processes and therefore two ids, which is AC-3's
 * other half.
 */
const PROCESS_INVOCATION = newInvocationId();

/**
 * The process's invocation id, for a caller that needs to line up with it.
 *
 * EPIC-092 needs it because a trace id is derived from it: a log line's
 * `invocation` and a span's `traceparent` must be greppable against each other,
 * which is the whole reason that Epic subsumed the field rather than adding a
 * second one. Read-only, and still never accepted from outside the process.
 */
export function processInvocationId(): string {
  return PROCESS_INVOCATION;
}

/**
 * Ferret's logging surface.
 *
 * Deliberately narrower than Pino's so the implementation stays replaceable and
 * so every record passes through redaction. Records are NDJSON on stderr;
 * stdout is reserved for command results, which keeps machine-readable
 * diagnostics separable from human output without parsing decorated text.
 */
export interface Logger {
  readonly level: LogLevel;
  child(bindings: LogFields): Logger;
  trace(fields: OperationFields, message: string): void;
  debug(fields: OperationFields, message: string): void;
  info(fields: OperationFields, message: string): void;
  warn(fields: OperationFields, message: string): void;
  error(fields: OperationFields, message: string): void;
  fatal(fields: OperationFields, message: string): void;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** File descriptor to write to. Defaults to stderr. */
  readonly destination?: number;
  /** Fields attached to every record. */
  readonly base?: LogFields;
  /**
   * The invocation id to stamp on every record.
   *
   * Supplied when one process has already minted one — the CLI mints it once in
   * `main` and hands it to the runtime, so the early process logger and the
   * runtime logger describe the same invocation rather than two.
   */
  readonly invocationId?: string;
}

/**
 * Redacts a set of log fields.
 *
 * Top-level keys are checked by name as well as by value: `redact` only
 * inspects key names once it is walking inside an object, so without this a
 * record whose top-level key is itself secret-named would pass straight through.
 */
function sanitize(fields: LogFields): LogFields {
  const output: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'err' || key === 'error') {
      output.err = serializeError(value);
      continue;
    }
    output[key] = isSecretKey(key) ? REDACTED : redact(value);
  }
  return output;
}

class PinoBackedLogger implements Logger {
  readonly level: LogLevel;
  readonly #pino: PinoLogger;

  constructor(instance: PinoLogger, level: LogLevel) {
    this.#pino = instance;
    this.level = level;
  }

  child(bindings: LogFields): Logger {
    return new PinoBackedLogger(this.#pino.child(sanitize(bindings)), this.level);
  }

  trace(fields: OperationFields, message: string): void {
    this.#pino.trace(sanitize(fields), message);
  }

  debug(fields: OperationFields, message: string): void {
    this.#pino.debug(sanitize(fields), message);
  }

  info(fields: OperationFields, message: string): void {
    this.#pino.info(sanitize(fields), message);
  }

  warn(fields: OperationFields, message: string): void {
    this.#pino.warn(sanitize(fields), message);
  }

  error(fields: OperationFields, message: string): void {
    this.#pino.error(sanitize(fields), message);
  }

  fatal(fields: OperationFields, message: string): void {
    this.#pino.fatal(sanitize(fields), message);
  }
}

/**
 * Creates the structured logger.
 *
 * The default level is `warn`: Ferret runs as infrastructure behind an AI
 * client, so a quiet default matters more than verbose progress reporting.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'warn';
  const instance = pino(
    {
      level,
      // Producer and invocation identity — EPIC-091 AC-2, AC-3.
      //
      // Setting `base` at all overrides Pino's default `pid` and `hostname`, so
      // before this a record identified neither the process nor the build:
      // `ferret --version` was knowable and the log's producer version was not,
      // which Governance §21 asks for wherever a change affects
      // reproducibility. `hostname` stays out deliberately — it is host data on
      // every line and nothing needs it to read one invocation.
      //
      // Caller bindings come last so a test can pin any of these.
      base: {
        ferret: VERSION,
        pid: process.pid,
        invocation: options.invocationId ?? PROCESS_INVOCATION,
        ...(options.base ?? {}),
      },
      timestamp: stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      serializers: {
        // Identity, deliberately.
        //
        // `sanitize()` has already turned the error into a redacted plain
        // object with its `cause` chain intact. Pino's default `err`
        // serializer would then run over that object as well, concatenating
        // every cause's message into one line and synthesising a `stack` from
        // objects that have none — producing a log record strictly worse than
        // what the same error prints to the terminal.
        //
        // Redaction happens before this point, so passing the value through
        // cannot leak: what arrives here is already what Ferret is willing to
        // show.
        err: (value: unknown) => value,
      },
    },
    destination({ dest: options.destination ?? 2, sync: true }),
  );
  return new PinoBackedLogger(instance, level);
}

/** A logger that discards every record. Useful for embedding and tests. */
export function createNullLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    level: 'silent',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  return logger;
}
