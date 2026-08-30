import { describe, expect, it } from 'vitest';

import {
  ErrorCode,
  FerretError,
  REDACTED,
  isErrorCode,
  serializeError,
  toFerretError,
} from '../../src/index.js';
import { ExitCode, exitCodeFor } from '../../src/cli/exit-codes.js';

describe('FerretError', () => {
  it('carries a stable code, remediation and retryability', () => {
    const error = new FerretError(ErrorCode.CONFIG_INVALID, 'bad config', {
      remediation: 'fix it',
      retryable: true,
      details: { field: 'port' },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FerretError');
    expect(error.code).toBe('E_CONFIG_INVALID');
    expect(error.remediation).toBe('fix it');
    expect(error.retryable).toBe(true);
    expect(error.toJSON().details).toStrictEqual({ field: 'port' });
  });

  it('defaults to not retryable and freezes its details', () => {
    const error = new FerretError(ErrorCode.UNKNOWN, 'boom');
    expect(error.retryable).toBe(false);
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it('redacts credentials in the message at construction', () => {
    const error = new FerretError(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      'cannot reach postgres://ferret:hunter2@db:5432/ferretdb',
    );
    expect(error.message).not.toContain('hunter2');
    expect(error.toJSON().message).not.toContain('hunter2');
  });

  it('redacts credentials in details when serializing', () => {
    const error = new FerretError(ErrorCode.CONFIG_INVALID, 'bad', {
      details: { database: { host: 'db', password: 'hunter2' } },
    });
    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain('hunter2');
    expect(serialized).toContain(REDACTED);
    expect(serialized).toContain('"host":"db"');
  });

  it('serializes a cause chain', () => {
    const root = new FerretError(ErrorCode.UNKNOWN, 'root cause');
    const wrapper = new FerretError(ErrorCode.INITIALIZATION_FAILED, 'wrapper', { cause: root });
    expect(wrapper.toJSON().cause?.code).toBe('E_UNKNOWN');
    expect(wrapper.toJSON().cause?.message).toBe('root cause');
  });

  it('omits absent optional fields rather than emitting undefined', () => {
    const serialized = new FerretError(ErrorCode.UNKNOWN, 'plain').toJSON();
    expect(Object.keys(serialized).sort()).toStrictEqual(['code', 'message', 'retryable']);
  });

  it('recognises its own instances', () => {
    expect(FerretError.is(new FerretError(ErrorCode.UNKNOWN, 'x'))).toBe(true);
    expect(FerretError.is(new Error('x'))).toBe(false);
  });
});

describe('serializeError', () => {
  it('classifies a plain Error as unknown rather than swallowing it', () => {
    const serialized = serializeError(new Error('plain failure'));
    expect(serialized.code).toBe('E_UNKNOWN');
    expect(serialized.message).toBe('plain failure');
  });

  it('redacts credentials in a plain Error message', () => {
    expect(serializeError(new Error('postgres://u:secretpw@h/db'))).toMatchObject({
      message: `postgres://u:${REDACTED}@h/db`,
    });
  });

  it('handles a thrown non-error without losing the failure', () => {
    const serialized = serializeError('just a string');
    expect(serialized.code).toBe('E_UNKNOWN');
    expect(serialized.message).toBe('just a string');
    expect(serializeError(42).message).toContain('Non-error value thrown');
  });

  it('preserves a recognised code carried on a plain error', () => {
    const error = Object.assign(new Error('nope'), { code: ErrorCode.USAGE });
    expect(serializeError(error).code).toBe('E_USAGE');
  });
});

describe('toFerretError', () => {
  it('returns FerretError instances unchanged', () => {
    const original = new FerretError(ErrorCode.USAGE, 'x');
    expect(toFerretError(original)).toBe(original);
  });

  it('wraps anything else with the requested fallback code', () => {
    const wrapped = toFerretError(new Error('boom'), ErrorCode.INITIALIZATION_FAILED);
    expect(wrapped.code).toBe('E_INITIALIZATION_FAILED');
    expect(wrapped.cause).toBeInstanceOf(Error);
  });
});

describe('isErrorCode', () => {
  it('accepts known codes and rejects everything else', () => {
    expect(isErrorCode('E_USAGE')).toBe(true);
    expect(isErrorCode('E_NOT_A_CODE')).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
  });
});

describe('exitCodeFor', () => {
  it.each([
    [ErrorCode.USAGE, ExitCode.USAGE],
    [ErrorCode.CONFIG_INVALID, ExitCode.CONFIG],
    [ErrorCode.CONFIG_MISSING, ExitCode.CONFIG],
    [ErrorCode.DEPENDENCY_UNAVAILABLE, ExitCode.DEPENDENCY],
    [ErrorCode.DEPENDENCY_UNSUPPORTED, ExitCode.DEPENDENCY],
    [ErrorCode.NOT_IMPLEMENTED, ExitCode.NOT_IMPLEMENTED],
    [ErrorCode.INTERRUPTED, ExitCode.INTERRUPTED],
    [ErrorCode.UNKNOWN, ExitCode.ERROR],
  ])('maps %s to exit code %i', (code, expected) => {
    expect(exitCodeFor(code)).toBe(expected);
  });

  it('maps every declared error code to a defined exit code', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(Object.values(ExitCode)).toContain(exitCodeFor(code));
    }
  });
});
