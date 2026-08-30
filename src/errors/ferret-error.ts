import { ErrorCode, isErrorCode } from './codes.js';
import { redact, redactString } from './redact.js';

/** Redacted, machine-readable representation of an error. */
export interface SerializedError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly remediation?: string;
  readonly cause?: SerializedError;
}

export interface FerretErrorOptions {
  /** Structured, redactable context. Never put raw credentials here. */
  readonly details?: Record<string, unknown>;
  /** Concrete action the operator or agent can take. */
  readonly remediation?: string;
  /** Whether repeating the operation unchanged could succeed. */
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * The single structured error type crossing Ferret's public boundary.
 *
 * Every error surfaced to a human, a log or an AI client is serialized through
 * {@link toJSON}, which redacts before emitting. Callers therefore cannot leak
 * a credential by forgetting to redact at the call site.
 */
export class FerretError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly remediation: string | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: FerretErrorOptions = {}) {
    super(redactString(message), options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'FerretError';
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.remediation = options.remediation;
    this.retryable = options.retryable ?? false;
    Error.captureStackTrace?.(this, FerretError);
  }

  /** Redacted representation safe for logs, CLI output and AI clients. */
  toJSON(): SerializedError {
    const details = redact(this.details) as Record<string, unknown>;
    const serialized: {
      code: ErrorCode;
      message: string;
      retryable: boolean;
      details?: Record<string, unknown>;
      remediation?: string;
      cause?: SerializedError;
    } = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (Object.keys(details).length > 0) serialized.details = details;
    if (this.remediation !== undefined) serialized.remediation = this.remediation;
    if (this.cause !== undefined) serialized.cause = serializeError(this.cause);
    return serialized;
  }

  static is(value: unknown): value is FerretError {
    return value instanceof FerretError;
  }
}

/**
 * Converts any thrown value into a redacted {@link SerializedError}.
 *
 * Unknown errors are classified as {@link ErrorCode.UNKNOWN} rather than being
 * swallowed or reported as success.
 */
export function serializeError(value: unknown): SerializedError {
  if (value instanceof FerretError) return value.toJSON();

  if (value instanceof Error) {
    const code = isErrorCode((value as { code?: unknown }).code)
      ? ((value as unknown as { code: ErrorCode }).code)
      : ErrorCode.UNKNOWN;
    const serialized: { code: ErrorCode; message: string; retryable: boolean; cause?: SerializedError } = {
      code,
      message: redactString(value.message === '' ? value.name : value.message),
      retryable: false,
    };
    if (value.cause !== undefined) serialized.cause = serializeError(value.cause);
    return serialized;
  }

  return {
    code: ErrorCode.UNKNOWN,
    message: redactString(typeof value === 'string' ? value : `Non-error value thrown: ${typeof value}`),
    retryable: false,
  };
}

/** Normalizes any thrown value into a {@link FerretError}. */
export function toFerretError(value: unknown, fallbackCode: ErrorCode = ErrorCode.UNKNOWN): FerretError {
  if (value instanceof FerretError) return value;
  const message = value instanceof Error ? value.message : `Non-error value thrown: ${typeof value}`;
  return new FerretError(fallbackCode, message, { cause: value });
}
