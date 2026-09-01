import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { REDACTED, VERSION, createLogger, redact, type LogLevel } from '../../src/index.js';
import { SECRET_KINDS } from '../../src/security/secrets.js';

/**
 * EPIC-091 — what a record carries, and what it must never carry.
 *
 * The Epic is not "build structured logging": a logger has existed since
 * EPIC-001 and 32 modules import it. These are the gaps §2 measured — a record
 * that identified neither the build nor the invocation, and a log path that
 * printed four credential formats the ingestion path refuses to store.
 */

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function captureTo(level: LogLevel, base: Record<string, unknown> = { component: 'test' }) {
  const directory = mkdtempSync(join(tmpdir(), 'ferret-slog-'));
  const file = join(directory, 'log.ndjson');
  const fd = openSync(file, 'a');
  const logger = createLogger({ level, destination: fd, base });

  cleanup.push(() => {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    logger,
    records: (): Array<Record<string, unknown>> =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: (): string => readFileSync(file, 'utf8'),
  };
}

describe('a record identifies its producer and its invocation — AC-1, AC-2, AC-3', () => {
  it('carries the level, an ISO time, a message, the component and the operation', () => {
    const { logger, records } = captureTo('info');
    logger.info({ operation: 'demo.run', repo: 'x' }, 'hello');

    const [record] = records();
    expect(record?.['level']).toBe('info');
    expect(record?.['msg']).toBe('hello');
    expect(record?.['component']).toBe('test');
    expect(record?.['operation']).toBe('demo.run');
    expect(String(record?.['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('carries the Ferret version and the process id — AC-2', () => {
    // Setting `base` at all overrode Pino's defaults, so a record identified
    // neither the process nor the build: `ferret --version` was knowable and
    // the log's producer version was not (Governance §21).
    const { logger, records } = captureTo('info');
    logger.info({ operation: 'demo.run' }, 'hello');

    const [record] = records();
    expect(record?.['ferret']).toBe(VERSION);
    expect(record?.['pid']).toBe(process.pid);
  });

  it('carries no hostname', () => {
    // Host data on every line, and nothing needs it to read one invocation.
    const { logger, records } = captureTo('info');
    logger.info({ operation: 'demo.run' }, 'hello');

    expect(records()[0]).not.toHaveProperty('hostname');
  });

  it('gives every record of one process the same invocation id — AC-3', () => {
    const { logger, records } = captureTo('info');
    logger.info({ operation: 'a.one' }, 'one');
    logger.child({ component: 'child' }).info({ operation: 'a.two' }, 'two');

    const [first, second] = records();
    expect(first?.['invocation']).toBeTypeOf('string');
    expect(second?.['invocation']).toBe(first?.['invocation']);
  });

  it('keeps the invocation id stable across two loggers in one process', () => {
    // A CLI invocation builds one logger in `main` and another in the runtime.
    // Threading an id between them would leave the next construction site out.
    const first = captureTo('info');
    const second = captureTo('info');
    first.logger.info({ operation: 'a.one' }, 'one');
    second.logger.info({ operation: 'a.two' }, 'two');

    expect(second.records()[0]?.['invocation']).toBe(first.records()[0]?.['invocation']);
  });

  it('lets a caller pin the id, so a session can name itself', () => {
    const { logger, records } = captureTo('info');
    const pinned = createLogger({ level: 'info', invocationId: 'fixed-id' });
    expect(pinned.level).toBe('info');
    logger.info({ operation: 'a.one' }, 'one');

    expect(records()[0]?.['invocation']).not.toBe('fixed-id');
  });

  it('carries an opaque id — no host, user, path or decodable time', () => {
    const { logger, records } = captureTo('info');
    logger.info({ operation: 'a.one' }, 'one');

    // Hex, fixed width, and nothing else. A correlation key, not a trace id and
    // not an identifier anyone should try to read.
    expect(String(records()[0]?.['invocation'])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the log path redacts everything the ingestion path refuses to store — AC-9', () => {
  /**
   * Synthetic instances of every kind EPIC-082 declares.
   *
   * Keyed by kind so the loop below can fail by name. The two lookbehind kinds
   * are supplied in the shape their pattern expects, since they match only the
   * secret half of a larger string.
   */
  const SAMPLES: Readonly<Record<string, string>> = {
    'private-key': '-----BEGIN RSA PRIVATE KEY-----\nMIIEbogusbogusbogus\n-----END RSA PRIVATE KEY-----',
    'aws-access-key-id': 'AKIAQRSTUVWXYZ234567',
    'github-token': `ghp_${'a'.repeat(36)}`,
    'github-fine-grained-token': `github_pat_${'b'.repeat(30)}`,
    'slack-token': 'xoxb-1234567890-abcdefghijkl',
    'google-api-key': `AIza${'C'.repeat(35)}`,
    'openai-api-key': `sk-${'d'.repeat(24)}`,
    'stripe-key': `sk_live_${'e'.repeat(20)}`,
    'npm-token': `npm_${'f'.repeat(36)}`,
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'url-credential': 'postgres://ferret:supersecretvalue@db:5432/x',
    'assigned-secret': 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY',
  };

  it('has a sample for every kind EPIC-082 declares', () => {
    // The guard that makes the loop below meaningful. A kind added to
    // `security/secrets.ts` fails here until a sample exists for it, and then
    // fails the next test until the log path catches up — which is the only
    // durable form of parity.
    expect(SECRET_KINDS.map((kind) => kind.kind).sort()).toStrictEqual(Object.keys(SAMPLES).sort());
  });

  for (const { kind } of SECRET_KINDS) {
    it(`masks a ${kind} in a log field value, under an innocuous key`, () => {
      const sample = SAMPLES[kind] as string;
      const { logger, raw } = captureTo('trace');
      logger.info({ operation: 'demo.run', note: sample }, 'm');

      const output = raw();
      // Masked rather than merely absent: `[redacted]` present proves the value
      // was recognised, not that the record failed to be written.
      expect(output, kind).toContain(REDACTED);
      // The secret half only — `url-credential` and `assigned-secret` leave the
      // scheme, host and keyword in place by design.
      const secretHalf =
        kind === 'url-credential'
          ? 'supersecretvalue'
          : kind === 'assigned-secret'
            ? 'wJalrXUtnFEMIK7MDENGbPxRfiCY'
            : sample.split('\n')[0] === sample
              ? sample
              : 'MIIEbogusbogusbogus';
      expect(output, kind).not.toContain(secretHalf);
    });
  }

  it('leaves an ordinary value that merely resembles one alone', () => {
    // The near-miss half. Over-redaction on the log path is cosmetic, but a
    // redactor that eats every hex string teaches people to stop reading logs.
    const { logger, raw } = captureTo('trace');
    logger.info(
      { operation: 'demo.run', branch: 'feature/AIza-experiment', sha: 'b9559ab55755eee0', count: 'npm_' },
      'm',
    );

    const output = raw();
    expect(output).toContain('feature/AIza-experiment');
    expect(output).toContain('b9559ab55755eee0');
  });

  it('redacts a secret-named key even when the value matches no pattern — AC-10', () => {
    // The regression EPIC-001 caught before merge: `redact` only inspects key
    // names once it is walking inside an object, so a top-level secret-named
    // key passed straight through.
    const { logger, records, raw } = captureTo('info');
    logger.info({ operation: 'demo.run', token: 'not-a-recognised-format' }, 'm');

    expect(records()[0]?.['token']).toBe(REDACTED);
    expect(raw()).not.toContain('not-a-recognised-format');
  });

  it('applies the same parity to the shared redactor, not only to the logger', () => {
    // `redact` is used by errors and by configuration introspection too, so the
    // parity must live in the redactor rather than in the logging call path.
    expect(redact('xoxb-1234567890-abcdefghijkl')).toBe(REDACTED);
  });
});

describe('operation is required — AC-4', () => {
  it('does not compile without one', () => {
    const { logger } = captureTo('info');

    // @ts-expect-error operation is required on every emitted record — EPIC-091 AC-4.
    logger.info({ repo: 'x' }, 'no operation');
  });

  it('is not required on a child binding', () => {
    // A binding names a component or a repository. Requiring an operation there
    // would force a meaningless one at every composition point.
    const { logger, records } = captureTo('info');
    logger.child({ component: 'storage' }).info({ operation: 'storage.connect' }, 'c');

    expect(records()[0]?.['component']).toBe('storage');
  });
});
