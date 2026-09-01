import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ErrorCode,
  FerretError,
  LOG_LEVELS,
  REDACTED,
  createLogger,
  createNullLogger,
  isLogLevel,
  type LogLevel,
} from '../../src/index.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

interface CapturedLog {
  records: () => Array<Record<string, unknown>>;
}

function captureTo(level: LogLevel) {
  const directory = mkdtempSync(join(tmpdir(), 'ferret-log-'));
  const file = join(directory, 'log.ndjson');
  const fd = openSync(file, 'a');
  const logger = createLogger({ level, destination: fd, base: { component: 'test' } });

  cleanup.push(() => {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    rmSync(directory, { recursive: true, force: true });
  });

  const capture: CapturedLog = {
    records: () =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
  return { logger, capture };
}

describe('log levels', () => {
  it('exposes the documented ladder', () => {
    expect([...LOG_LEVELS]).toStrictEqual([
      'silent',
      'fatal',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
    ]);
  });

  it('recognises valid levels only', () => {
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('chatty')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });
});

describe('createLogger', () => {
  it('emits one NDJSON record per call with severity, timestamp and component', () => {
    const { logger, capture } = captureTo('info');
    logger.info({ operation: 'test.run' }, 'hello');

    const [record] = capture.records();
    expect(record?.level).toBe('info');
    expect(record?.component).toBe('test');
    expect(record?.operation).toBe('test.run');
    expect(record?.msg).toBe('hello');
    expect(typeof record?.time).toBe('string');
    expect(new Date(record?.time as string).toString()).not.toBe('Invalid Date');
  });

  it('is quiet by default: warn suppresses info and below', () => {
    const { logger, capture } = captureTo('warn');
    logger.info({ operation: 'test.emit' }, 'not emitted');
    logger.debug({ operation: 'test.emit' }, 'not emitted');
    logger.warn({ operation: 'test.emit' }, 'emitted');

    expect(capture.records().map((r) => r.msg)).toStrictEqual(['emitted']);
  });

  it('redacts secret-named fields before they reach the stream', () => {
    const { logger, capture } = captureTo('info');
    logger.info({ operation: 'test.connect', database: { host: 'db', password: 'hunter2' } }, 'connecting');

    const raw = JSON.stringify(capture.records());
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain(REDACTED);
    expect(raw).toContain('"host":"db"');
  });

  it('redacts credentials embedded in a message field value', () => {
    const { logger, capture } = captureTo('info');
    logger.error({ operation: 'test.connect', target: 'postgres://ferret:hunter2@db:5432/x' }, 'connection failed');
    expect(JSON.stringify(capture.records())).not.toContain('hunter2');
  });

  it('serializes an error under `err` without leaking its embedded credentials', () => {
    const { logger, capture } = captureTo('info');
    logger.error({ operation: 'test.fail', err: new Error('failed for postgres://u:hunter2@h/db') }, 'boom');

    const [record] = capture.records();
    const err = record?.err as { code: string; message: string };
    expect(err.code).toBe('E_UNKNOWN');
    expect(err.message).not.toContain('hunter2');
  });

  it('inherits and redacts child bindings', () => {
    const { logger, capture } = captureTo('info');
    logger.child({ requestId: 'abc-123', token: 'sensitive' }).info({ operation: 'test.child' }, 'child record');

    const [record] = capture.records();
    expect(record?.requestId).toBe('abc-123');
    expect(record?.token).toBe(REDACTED);
    expect(record?.component).toBe('test');
  });
});

describe('createNullLogger', () => {
  it('accepts every method and returns itself as its own child', () => {
    const logger = createNullLogger();
    expect(logger.level).toBe('silent');
    expect(logger.child({ a: 1 })).toBe(logger);
    expect(() => {
      logger.trace({ operation: 'test.x' }, 'x');
      logger.debug({ operation: 'test.x' }, 'x');
      logger.info({ operation: 'test.x' }, 'x');
      logger.warn({ operation: 'test.x' }, 'x');
      logger.error({ operation: 'test.x' }, 'x');
      logger.fatal({ operation: 'test.x' }, 'x');
    }).not.toThrow();
  });
});

describe('errors in a log record', () => {
  it('keeps the cause chain intact instead of flattening it into one message', () => {
    // Found by dogfooding: `ferret index` against Ferret's own repository with
    // an incomplete configuration. The CLI printed one clear message; the *log
    // line* printed the same sentence three times joined by colons, and a
    // "stack" reading "\ncaused by: \ncaused by: ".
    //
    // `sanitize()` had already produced a redacted plain object with its cause
    // chain, and pino's own `err` serializer then ran over it as well —
    // concatenating every cause's message and synthesising a stack from objects
    // that have none. An operator's log line was strictly worse than the
    // terminal output of the same error, which is the opposite of what
    // structured logging is for.
    const inner = new FerretError(ErrorCode.CONFIG_MISSING, 'missing database');
    const middle = new FerretError(ErrorCode.CONFIG_MISSING, 'missing database', { cause: inner });
    const outer = new FerretError(ErrorCode.CONFIG_MISSING, 'provider failed: missing database', {
      cause: middle,
    });

    const { logger, capture } = captureTo('error');
    logger.error({ err: outer, operation: 'test' }, 'failed');

    const [record] = capture.records();
    const err = record?.['err'] as { message: string; stack?: unknown; cause?: { message: string } };
    expect(err.message).toBe('provider failed: missing database');
    // Not "message: message: message".
    expect(err.message.split('missing database').length - 1).toBe(1);
    // No fabricated stack from objects that never had one.
    expect(err.stack).toBeUndefined();
    // The chain is still there, as structure rather than as prose.
    expect(err.cause?.message).toBe('missing database');
  });
});
