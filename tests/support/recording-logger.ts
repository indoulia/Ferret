import type { LogFields, LogLevel, Logger } from '../../src/index.js';

export interface LogRecord {
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly fields: LogFields;
  readonly message: string;
}

/**
 * A logger that keeps what it was given.
 *
 * Used to assert what Ferret does and does not say. The production logger
 * redacts on the way out; this one records the *input* deliberately, so a test
 * asserting "the password never appears" is checking the redaction rather than
 * being flattered by it.
 */
export class RecordingLogger implements Logger {
  readonly level: LogLevel = 'trace';
  readonly records: LogRecord[] = [];
  readonly #bindings: LogFields;

  constructor(bindings: LogFields = {}, sink?: LogRecord[]) {
    this.#bindings = bindings;
    if (sink !== undefined) this.records = sink;
  }

  child(bindings: LogFields): Logger {
    return new RecordingLogger({ ...this.#bindings, ...bindings }, this.records);
  }

  #write(level: Exclude<LogLevel, 'silent'>, fields: LogFields, message: string): void {
    this.records.push({ level, fields: { ...this.#bindings, ...fields }, message });
  }

  trace(fields: LogFields, message: string): void {
    this.#write('trace', fields, message);
  }
  debug(fields: LogFields, message: string): void {
    this.#write('debug', fields, message);
  }
  info(fields: LogFields, message: string): void {
    this.#write('info', fields, message);
  }
  warn(fields: LogFields, message: string): void {
    this.#write('warn', fields, message);
  }
  error(fields: LogFields, message: string): void {
    this.#write('error', fields, message);
  }
  fatal(fields: LogFields, message: string): void {
    this.#write('fatal', fields, message);
  }

  /** Every record serialized, for "this string never appears anywhere" assertions. */
  dump(): string {
    return JSON.stringify(this.records);
  }
}
