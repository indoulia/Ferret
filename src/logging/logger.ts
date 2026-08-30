import { destination, pino, stdTimeFunctions, type Logger as PinoLogger } from 'pino';

import { REDACTED, isSecretKey, redact, serializeError } from '../errors/index.js';

export const LOG_LEVELS = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Structured fields attached to a log record. */
export type LogFields = Record<string, unknown>;

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
  trace(fields: LogFields, message: string): void;
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  fatal(fields: LogFields, message: string): void;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** File descriptor to write to. Defaults to stderr. */
  readonly destination?: number;
  /** Fields attached to every record. */
  readonly base?: LogFields;
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

  trace(fields: LogFields, message: string): void {
    this.#pino.trace(sanitize(fields), message);
  }

  debug(fields: LogFields, message: string): void {
    this.#pino.debug(sanitize(fields), message);
  }

  info(fields: LogFields, message: string): void {
    this.#pino.info(sanitize(fields), message);
  }

  warn(fields: LogFields, message: string): void {
    this.#pino.warn(sanitize(fields), message);
  }

  error(fields: LogFields, message: string): void {
    this.#pino.error(sanitize(fields), message);
  }

  fatal(fields: LogFields, message: string): void {
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
      base: { ...(options.base ?? {}) },
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
