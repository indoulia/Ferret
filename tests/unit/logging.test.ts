import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
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
    logger.info({}, 'not emitted');
    logger.debug({}, 'not emitted');
    logger.warn({}, 'emitted');

    expect(capture.records().map((r) => r.msg)).toStrictEqual(['emitted']);
  });

  it('redacts secret-named fields before they reach the stream', () => {
    const { logger, capture } = captureTo('info');
    logger.info({ database: { host: 'db', password: 'hunter2' } }, 'connecting');

    const raw = JSON.stringify(capture.records());
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain(REDACTED);
    expect(raw).toContain('"host":"db"');
  });

  it('redacts credentials embedded in a message field value', () => {
    const { logger, capture } = captureTo('info');
    logger.error({ target: 'postgres://ferret:hunter2@db:5432/x' }, 'connection failed');
    expect(JSON.stringify(capture.records())).not.toContain('hunter2');
  });

  it('serializes an error under `err` without leaking its embedded credentials', () => {
    const { logger, capture } = captureTo('info');
    logger.error({ err: new Error('failed for postgres://u:hunter2@h/db') }, 'boom');

    const [record] = capture.records();
    const err = record?.err as { code: string; message: string };
    expect(err.code).toBe('E_UNKNOWN');
    expect(err.message).not.toContain('hunter2');
  });

  it('inherits and redacts child bindings', () => {
    const { logger, capture } = captureTo('info');
    logger.child({ requestId: 'abc-123', token: 'sensitive' }).info({}, 'child record');

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
      logger.trace({}, 'x');
      logger.debug({}, 'x');
      logger.info({}, 'x');
      logger.warn({}, 'x');
      logger.error({}, 'x');
      logger.fatal({}, 'x');
    }).not.toThrow();
  });
});
