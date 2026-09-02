import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ENTITY_SCHEMA_VERSION } from '../../src/domain/index.js';
import { ErrorCode, FerretError } from '../../src/errors/index.js';
import { readDocument } from '../../src/storage/index.js';

/**
 * EPIC-090's refusals, which all happen before a database connection exists.
 *
 * That is the contract worth pinning: a document that does not parse, does not
 * verify, or names a version this build cannot read never reaches a write path.
 * §8.1 — a partial import is worse than a slow one, because it leaves an index
 * that looks complete.
 */

function digestOf(lines: readonly string[]): string {
  const hash = createHash('sha256');
  for (const line of lines) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

const manifest = {
  kind: 'ferret-export',
  format: 1,
  ferretVersion: '0.1.0',
  entitySchemaVersion: ENTITY_SCHEMA_VERSION,
  exportedAt: '2026-09-02T00:00:00.000Z',
  scope: undefined,
  tables: ['entity'],
};

/** A well-formed document, with a trailer whose digest actually matches. */
function documentOf(rows: readonly unknown[], overrides: Record<string, unknown> = {}): string {
  const body = rows.map((row) => JSON.stringify(row));
  const trailer = {
    kind: 'ferret-export-trailer',
    counts: { entity: rows.length },
    rows: rows.length,
    digest: digestOf(body),
    ...overrides,
  };
  return [JSON.stringify(manifest), ...body, JSON.stringify(trailer)].join('\n');
}

const row = { table: 'entity', row: { id: 'e1', kind: 'file' } };

function refusalFrom(text: string): FerretError {
  try {
    readDocument(text, digestOf);
  } catch (error) {
    return error as FerretError;
  }
  throw new Error('the document was accepted when it should have been refused');
}

describe('a well-formed document is read — AC-1', () => {
  it('returns the manifest, the trailer and the rows', () => {
    const document = readDocument(documentOf([row]), digestOf);

    expect(document.manifest.kind).toBe('ferret-export');
    expect(document.trailer.rows).toBe(1);
    expect(document.rows).toStrictEqual([row]);
  });

  it('reads a document with no rows — AC-15', () => {
    const document = readDocument(documentOf([]), digestOf);

    expect(document.rows).toStrictEqual([]);
    expect(document.trailer.rows).toBe(0);
  });

  it('ignores a trailing newline, which a file written line by line has', () => {
    expect(readDocument(`${documentOf([row])}\n`, digestOf).rows).toHaveLength(1);
  });
});

describe('the manifest is checked first — AC-5, AC-6', () => {
  it('refuses a first line that is not JSON', () => {
    const refusal = refusalFrom('not json at all\n');

    expect(refusal).toBeInstanceOf(FerretError);
    expect(refusal.code).toBe(ErrorCode.SCHEMA_UNSUPPORTED);
    expect(refusal.message).toContain('not JSON');
  });

  it('refuses an unknown kind by name — AC-5', () => {
    const refusal = refusalFrom('{"kind":"some-other-tool","format":1}\n');

    // Named, so an operator who exported from the wrong tool is told which.
    expect(refusal.message).toContain('some-other-tool');
  });

  it('refuses an unknown format version', () => {
    expect(refusalFrom('{"kind":"ferret-export","format":99}\n').message).toContain('manifest');
  });

  it('refuses a newer entity schema version — AC-6', () => {
    // EPIC-002's reasoning for the database and EPIC-006's for the entity
    // envelope: reading a newer envelope under the old meaning applies an
    // interpretation the writer never intended, and quietly.
    const newer = documentOf([row]).replace(
      `"entitySchemaVersion":${String(ENTITY_SCHEMA_VERSION)}`,
      `"entitySchemaVersion":${String(ENTITY_SCHEMA_VERSION + 1)}`,
    );

    const refusal = refusalFrom(newer);
    expect(refusal.message).toContain(String(ENTITY_SCHEMA_VERSION + 1));
    expect(refusal.message).toContain(String(ENTITY_SCHEMA_VERSION));
  });

  it('accepts an older entity schema version — AC-6, the other half', () => {
    // The downgrade path `COMPATIBILITY.md` §7 sends here. Refusing it would
    // close the only route a downgrade has.
    const older = JSON.stringify({ ...manifest, entitySchemaVersion: 0 });
    const body = [JSON.stringify(row)];
    const trailer = JSON.stringify({
      kind: 'ferret-export-trailer',
      counts: { entity: 1 },
      rows: 1,
      digest: digestOf(body),
    });

    expect(
      readDocument([older, ...body, trailer].join('\n'), digestOf).manifest.entitySchemaVersion,
    ).toBe(0);
  });
});

describe('integrity is checked before anything is written — AC-3, AC-4', () => {
  it('refuses a document with no trailer — AC-3', () => {
    const truncated = documentOf([row]).split('\n').slice(0, -1).join('\n');

    const refusal = refusalFrom(truncated);
    expect(refusal.message).toContain('truncated');
    // And it says nothing was imported, because nothing was.
    expect(refusal.message).toContain('Nothing has been imported');
  });

  it('refuses a manifest with nothing after it', () => {
    expect(refusalFrom(`${JSON.stringify(manifest)}\n`).message).toContain('trailer');
  });

  it('refuses a digest that does not match the rows — AC-4', () => {
    const tampered = documentOf([row], { digest: 'f'.repeat(64) });

    const refusal = refusalFrom(tampered);
    expect(refusal.message).toContain('do not hash to the digest');
    expect(refusal.details).toMatchObject({ expected: 'f'.repeat(64) });
  });

  it('refuses a document whose row was edited, even by one character', () => {
    // The digest is what makes an edit in transit detectable, so this is the
    // assertion that the digest covers what it claims to.
    const edited = documentOf([row]).replace('"kind":"file"', '"kind":"fole"');

    expect(refusalFrom(edited).message).toContain('do not hash to the digest');
  });

  it('refuses a trailer whose row count disagrees with the document', () => {
    const body = [JSON.stringify(row)];
    const trailer = JSON.stringify({
      kind: 'ferret-export-trailer',
      counts: { entity: 2 },
      rows: 2,
      digest: digestOf(body),
    });

    expect(refusalFrom([JSON.stringify(manifest), ...body, trailer].join('\n')).message).toContain(
      'carries 1',
    );
  });

  it('refuses a damaged row and names which one', () => {
    const body = ['{not json'];
    const trailer = JSON.stringify({
      kind: 'ferret-export-trailer',
      counts: { entity: 1 },
      rows: 1,
      digest: digestOf(body),
    });

    expect(refusalFrom([JSON.stringify(manifest), ...body, trailer].join('\n')).message).toContain(
      'Row 1',
    );
  });

  it('refuses an empty file', () => {
    expect(refusalFrom('').message).toContain('empty');
    expect(refusalFrom('\n\n').message).toContain('empty');
  });
});

describe('every refusal carries remediation', () => {
  it('says what to do rather than only what went wrong', () => {
    for (const text of ['', 'not json', `${JSON.stringify(manifest)}\n`]) {
      expect(refusalFrom(text).remediation).toContain('Export the index again');
    }
  });
});
