import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EntityKind, ErrorCode, IntegrityFindingKind, createNullLogger } from '../../../src/index.js';
import {
  EntityStore,
  ExportService,
  ImportService,
  IntegrityService,
  migrate,
  readDocument,
  readExportDocument,
  type ExportRow,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SECRET_SAMPLES } from '../../support/secret-samples.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';
import { runCli } from '../../helpers/cli.js';

/**
 * **F-44 / D1 — an export cannot silently invalidate what it exports.**
 *
 * The defect these tests exist for: export ran `redactSecrets` over every
 * string value and substituted the result, while carrying `content_hash`
 * unchanged. `entity.content_hash` is derived from `attributes`
 * (`domain/entity.ts`), so one rewritten string left the hash describing a row
 * that no longer existed. Measured consequences, both reproduced below:
 *
 * - A restored index reported **itself** damaged — `identity-mismatch`,
 *   `content-hash-mismatch`, `evidence-tampered` — each naming a cause that was
 *   false ("altered outside Ferret") and remediating with "re-read the source",
 *   which is the one thing a restore cannot do.
 * - `sameContent` compares the hash alone, so re-importing that document into
 *   the live index reported `unchanged` and discarded the redaction — meaning
 *   EPIC-090 §8.7's export-then-import scrub silently scrubbed nothing.
 *
 * The contract now: the scanner still runs (EPIC-089 §11), and when it fires
 * the value goes out **as it is** with the finding recorded, or `--strict`
 * refuses. What it never does is emit the modified value.
 *
 * A credential-shaped *path* is the vehicle because it is the reachable case:
 * paths are not redacted at insert, so this is what an ordinary `ferret index`
 * produces. The sample comes from `secret-samples.ts` rather than a literal, so
 * no new credential shape enters this repository.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

/** Reachable without a contrived producer: a filename shaped like a key. */
const SHAPED_PATH = `src/${SECRET_SAMPLES['aws-access-key-id']?.text ?? ''}.txt`;

let source: TestDatabase;
let from: FerretDatabase;
let exporter: ExportService;
let storedHash: string;
let home: string;
let env: NodeJS.ProcessEnv;

function digestOf(lines: readonly string[]): string {
  const hash = createHash('sha256');
  for (const line of lines) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** Collects a document as the lines the sink was handed. */
async function exportTo(options: Parameters<ExportService['exportDocument']>[1] = {}): Promise<{
  lines: string[];
  result: Awaited<ReturnType<ExportService['exportDocument']>> | undefined;
  error: unknown;
}> {
  const lines: string[] = [];
  try {
    const result = await exporter.exportDocument((line) => void lines.push(line), options);
    return { lines, result, error: undefined };
  } catch (error) {
    return { lines, result: undefined, error };
  }
}

/** The exported `attributes.path`, when the row has one as a string. */
function pathOf(row: ExportRow): string | undefined {
  const attributes = (row.row as { attributes?: unknown }).attributes;
  if (typeof attributes !== 'object' || attributes === null) return undefined;
  const path = (attributes as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

function fileRow(lines: readonly string[]): ExportRow | undefined {
  return lines
    .map((line) => JSON.parse(line) as { table?: string; row?: Record<string, unknown> })
    .filter((parsed): parsed is ExportRow => parsed.table === 'entity' && parsed.row !== undefined)
    .find((parsed) => pathOf(parsed) === SHAPED_PATH);
}

describeDb(`export fidelity (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    source = await createTestDatabase('fidelity-src');
    await migrate(source.pool, { logger });
    from = drizzle(source.pool);
    exporter = new ExportService(from);

    const entities = new EntityStore(from);
    const repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/fidelity' },
        attributes: { path: '/fidelity' },
      })
    ).entity;

    // Through `EntityStore`, so `content_hash` is the hash the product derives
    // rather than one this test made up. That is the whole point: the assertion
    // is about the relationship between the hash and the row.
    const file = await entities.upsert({
      kind: EntityKind.FILE,
      source: { system: 'git', id: SHAPED_PATH, scope: repository.id },
      attributes: { path: SHAPED_PATH },
    });
    storedHash = file.entity.contentHash;

    home = mkdtempSync(join(tmpdir(), 'ferret-fidelity-home-'));
    env = { ...source.env, FERRET_CONFIG: join(home, 'config.json') };
    writeFileSync(join(home, 'config.json'), '{}\n', 'utf8');
  }, 120_000);

  afterAll(async () => {
    rmSync(home, { recursive: true, force: true });
    await source.drop();
  });

  it('carries the value as it is, under the hash that describes it', async () => {
    const { lines, result } = await exportTo();
    expect(result).toBeDefined();

    const row = fileRow(lines);
    // The row is findable *by* the unmodified path, which is already the
    // assertion: before D1 the exported path was `[redacted: …]` and this
    // lookup found nothing.
    expect(row, 'the exported row does not carry the path the index holds').toBeDefined();
    expect(row?.row['content_hash']).toBe(storedHash);
  });

  it('emits no redacted substitution anywhere in the document', async () => {
    const { lines } = await exportTo();

    // The specific failure: `redactSecrets` replaces a match with
    // `[redacted: <kind>]`. Not one may appear in a faithful document, because
    // every one of them is a value whose hash no longer describes it.
    expect(lines.join('\n')).not.toContain('[redacted:');
  });

  it('reports what it carried rather than staying silent about it', async () => {
    const { result } = await exportTo();

    const findings = result?.credentialShaped ?? [];
    expect(findings.length).toBeGreaterThan(0);
    const finding = findings.find((one) => one.table === 'entity');
    expect(finding?.kinds).toContain('aws-access-key-id');
    // The trailer carries it too, so the statement travels with the document
    // rather than living only in the process that wrote it.
    expect(result?.trailer.credentialShaped?.length).toBe(findings.length);
  });

  it('names the row in a finding without republishing the value', async () => {
    const { result } = await exportTo();
    const secret = SECRET_SAMPLES['aws-access-key-id']?.text ?? '';

    // `entity_external_id` is keyed partly on `external_id`, so a key echoed
    // verbatim could republish the very string the finding warns about. Every
    // finding is checked, not just the one this fixture produces.
    for (const finding of result?.credentialShaped ?? []) {
      expect(finding.key, 'a finding echoed the credential it is reporting').not.toContain(secret);
    }
  });

  it('refuses in strict mode, and writes no trailer to refuse with', async () => {
    const { lines, result, error } = await exportTo({ strict: true });

    expect(result).toBeUndefined();
    expect((error as { code?: string }).code).toBe(ErrorCode.EXPORT_REFUSED);
    // Thrown mid-stream, so whatever reached the sink has no trailer and
    // `readDocument` refuses it as truncated rather than accepting a shorter
    // document that looks whole.
    expect(lines.some((line) => line.includes('ferret-export-trailer'))).toBe(false);
    expect(() => readDocument(`${lines.join('\n')}\n`, digestOf)).toThrow(/truncated/i);
  });

  it('says which guarantee it could not keep, and how to proceed', async () => {
    const { error } = await exportTo({ strict: true });
    const failure = error as { message: string; remediation?: string; details?: Record<string, unknown> };

    // A refusal that does not say why is a crash with better manners.
    expect(failure.message).toContain('entity');
    expect(failure.message).toContain('content hash');
    expect(failure.details?.['kinds']).toContain('aws-access-key-id');
    expect(failure.remediation).toContain('EPIC-087');
  });

  it('leaves no file behind when a strict export refuses — through the CLI', async () => {
    const out = join(home, 'strict.ndjson');
    const initialised = await runCli(['init', '--json'], { env });
    expect(initialised.code, initialised.stderr).toBe(0);

    const refused = await runCli(['export', '--strict', '--out', out, '--json'], { env });
    expect(refused.code, refused.stdout).not.toBe(0);
    // A half-written strict export is exactly the file whose contents the
    // operator asked not to have on disk. "Nothing there" is the right answer,
    // not "a document `ferret import` will refuse".
    expect(existsSync(out), 'a refused strict export left a partial document').toBe(false);

    // And the same index exports faithfully without `--strict`, so the refusal
    // is a choice the operator makes rather than a dead end.
    const faithful = await runCli(['export', '--out', out, '--json'], { env });
    expect(faithful.code, faithful.stderr).toBe(0);
    expect(readExportDocument(readFileSync(out, 'utf8')).trailer).toBeDefined();
  });

  it('restores into an index that does not report itself tampered with', async () => {
    // The measured consequence of the old behaviour, as an assertion: one
    // rewritten path produced five findings on the restored index — an
    // identity mismatch, two content-hash mismatches and two tampered evidence
    // records — every one of them false.
    const target = await createTestDatabase('fidelity-dst');
    try {
      await migrate(target.pool, { logger });
      const into = drizzle(target.pool);

      const { lines } = await exportTo();
      const document = readDocument(`${lines.join('\n')}\n`, digestOf);
      const report = await new ImportService(into).importDocument(document, { apply: true });
      expect(report.applied).toBe(true);

      const sweep = await new IntegrityService(into).sweep();
      const lying = sweep.findings.filter(
        (finding) =>
          finding.kind === IntegrityFindingKind.CONTENT_HASH_MISMATCH ||
          finding.kind === IntegrityFindingKind.IDENTITY_MISMATCH ||
          finding.kind === IntegrityFindingKind.EVIDENCE_TAMPERED,
      );
      expect(lying, `the restored index reported ${String(lying.length)} integrity finding(s)`).toStrictEqual([]);
    } finally {
      await target.drop();
    }
  }, 180_000);

  it('reports unchanged only because the rows really are unchanged', async () => {
    // The other half of the old defect. Re-importing into the index that still
    // holds the originals reported `unchanged` for rows whose content the
    // document had rewritten — `sameContent` compares `content_hash` alone, so
    // the redaction was discarded and the operator was told nothing changed.
    // Now the two genuinely agree, and the row is checked rather than the count.
    const { lines } = await exportTo();
    const document = readDocument(`${lines.join('\n')}\n`, digestOf);
    const report = await new ImportService(from).importDocument(document, { apply: true });

    const entity = report.tables.find((table) => table.table === 'entity');
    expect(entity?.written).toBe(0);
    expect(entity?.conflicting).toBe(0);
    expect(entity?.unchanged).toBeGreaterThan(0);

    // The discriminating assertion, and the one the old behaviour fails: an
    // `unchanged` verdict must mean the document and the row agree on the
    // *content*, not merely on the hash. Before D1 the document said
    // `[redacted: …]` and the row said the path, `sameContent` compared the
    // hash alone, and the import reported `unchanged` — so the redaction the
    // export had applied was silently thrown away and the operator was told
    // nothing had changed.
    const rows = await source.pool.query<{ path: string; content_hash: string }>(
      `SELECT attributes->>'path' AS path, content_hash FROM ferret.entity WHERE kind = 'file'`,
    );
    const kept = rows.rows.find((row) => row.path === SHAPED_PATH);
    expect(kept?.content_hash).toBe(storedHash);

    const carried = fileRow(lines);
    expect(carried, 'the document does not carry the row it reported unchanged').toBeDefined();
    expect(carried === undefined ? undefined : pathOf(carried)).toBe(kept?.path);
  });
});
