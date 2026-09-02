import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { REDACTED, ErrorCode, FerretError, createLogger, parseConfig, redact, serializeError } from '../../src/index.js';
import { describeConfig } from '../../src/config/index.js';
import { SECRET_KINDS, redactSecrets } from '../../src/security/secrets.js';
import { assertSamplesAreTotal, eachSecretKind } from '../support/secret-samples.js';

/**
 * **Every surface redacts every credential format Ferret can recognise.**
 *
 * The invariant, not the incident. Ferret has two redactors by design —
 * `errors/redact.ts` for anything leaving the process, `security/secrets.ts`
 * for indexed content — and both were correct and both were tested. What
 * nothing tested was the *relationship*: the log list carried six patterns and
 * the ingestion list carried twelve, so a Slack token, a Google API key, an npm
 * token and a Stripe key were values Ferret refused to **store** and printed
 * verbatim to an operator's terminal, a CI transcript and a client's captured
 * stderr.
 *
 * Neither Epic owned that sentence, so neither Epic's suite failed. This file
 * is where sentences like it live.
 *
 * Enumerated from `SECRET_KINDS` and proved total first: a kind added without a
 * sample fails here rather than being quietly uncovered.
 */

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function captureLog(): { logger: ReturnType<typeof createLogger>; raw: () => string } {
  const directory = mkdtempSync(join(tmpdir(), 'ferret-sec-'));
  const file = join(directory, 'log.ndjson');
  const fd = openSync(file, 'a');
  const logger = createLogger({ level: 'trace', destination: fd, base: { component: 'security' } });
  cleanup.push(() => {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { logger, raw: () => readFileSync(file, 'utf8') };
}

describe('the enumeration is total — AC-3', () => {
  it('has a sample for every declared secret kind, and no others', () => {
    // The failing-closed assertion. Every invariant below iterates
    // `SECRET_KINDS`; if that set could shrink unnoticed, they would all keep
    // passing while checking less — the one failure mode a security suite must
    // not have.
    const { kinds } = assertSamplesAreTotal();

    expect(kinds).toBeGreaterThan(0);
    // Reported, so "the suite passed" means something: twelve kinds, not zero.
    process.stderr.write(`[EPIC-100] redaction parity covers ${String(kinds)} credential kinds\n`);
  });

  it('declares at least the kinds that have ever shipped', () => {
    // A floor, so a refactor that empties the list is caught even if it also
    // empties the sample table in step.
    expect(SECRET_KINDS.length).toBeGreaterThanOrEqual(12);
  });
});

describe('every credential kind is masked on every surface — AC-2', () => {
  for (const { kind, sample } of eachSecretKind()) {
    it(`masks a ${kind} in a log record`, () => {
      const { logger, raw } = captureLog();
      logger.info({ operation: 'security.probe', note: sample.text }, 'm');

      const output = raw();
      expect(output, kind).toContain(REDACTED);
      expect(output, kind).not.toContain(sample.secretHalf);
    });

    it(`masks a ${kind} in a serialized error`, () => {
      // The path an error takes to an AI client. EPIC-009's serializer is the
      // one place that guarantee lives, and it must cover what the logger does.
      const serialized = JSON.stringify(
        serializeError(new FerretError(ErrorCode.PROVIDER_INVALID, `failed with ${sample.text}`, { details: {} })),
      );

      expect(serialized, kind).not.toContain(sample.secretHalf);
    });

    it(`masks a ${kind} in rendered configuration`, () => {
      // `describeConfig` is the only supported way to render configuration, and
      // it is what `ferret doctor --show-config` prints.
      const rendered = JSON.stringify(
        describeConfig(parseConfig({ database: { host: sample.text, database: 'd', user: 'u' } })),
      );

      expect(rendered, kind).not.toContain(sample.secretHalf);
    });

    it(`masks a ${kind} through the shared redactor`, () => {
      // The function every surface above funnels through. Asserted directly so
      // a failure names the redactor rather than whichever caller noticed.
      expect(redact(sample.text), kind).not.toContain(sample.secretHalf);
    });
  }
});

describe('the log redactor is a superset of the content redactor — the defect', () => {
  it('recognises everything the ingestion path refuses to store', () => {
    // The single sentence neither EPIC-082 nor EPIC-091 owned, stated as a
    // property rather than as a list. It is the whole reason this file exists.
    for (const { kind, sample } of eachSecretKind()) {
      const stored = redactSecrets(sample.text);
      const printed = redact(sample.text);

      // Ingestion refuses it, so the log path must too. The converse is
      // allowed: over-redacting a log line costs nothing and over-redacting
      // indexed content destroys it.
      if (stored.redacted > 0) {
        expect(String(printed), `${kind}: refused by ingestion, printed by the log path`).not.toContain(
          sample.secretHalf,
        );
      }
    }
  });

  it('never widens the ingestion redactor to match', () => {
    // Parity moves in one direction only. EPIC-082 §4 rejected entropy
    // heuristics because a false positive there destroys data, and a future
    // reading of "parity" that made the two lists literally equal would undo
    // that decision by accident.
    const ordinary = 'the deploy key rotated on Tuesday and the build went green';

    expect(redactSecrets(ordinary).redacted).toBe(0);
  });
});
