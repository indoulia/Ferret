import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_INGEST_PAGE_LIMIT,
  INGEST_PRODUCER,
  SOURCE_CONNECTOR_CONTRACT_VERSION,
  SourceIngestor,
  ingestSources,
  type AcquiredRecord,
  type AcquisitionPage,
  type AcquisitionRequest,
  type IngestDependencies,
  type IngestReport,
  type NormalizationContext,
  type SourceConnector,
  type SourceContribution,
} from '../../../src/index.js';
import { EntityKind } from '../../../src/domain/index.js';
import { ErrorCode, FerretError } from '../../../src/errors/index.js';
import { createNullLogger } from '../../../src/logging/index.js';
import { createTestOperationContext } from '../../../src/providers/sdk/testing.js';
import {
  EntityStore,
  EvidenceStore,
  MigrationPolicy,
  RelationshipStore,
  SyncCursorStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * A source larger than one bounded pass is still ingested completely.
 *
 * The defect this suite exists for: {@link DEFAULT_INGEST_PAGE_LIMIT} bounded a
 * pass, and a bounded pass persisted nothing about where it had stopped. The
 * next pass therefore asked the source for its *first* page again, under the
 * same `since`, and re-read the same prefix. A source holding more than
 * `pageLimit × pageSize` records could never be read past that prefix, however
 * many times ingestion ran — while every pass wrote rows, reported records and
 * looked like progress.
 *
 * Everything below crosses that boundary deliberately. The source serves
 * {@link TOTAL_RECORDS} records over {@link TOTAL_PAGES} pages against the
 * default bound of {@link DEFAULT_INGEST_PAGE_LIMIT}, so the old
 * implementation stops permanently at record
 * `DEFAULT_INGEST_PAGE_LIMIT × PAGE_SIZE` and the completeness assertion fails
 * rather than passing on a fixture too small to tell.
 *
 * Against real PostgreSQL, because the continuation is *stored* state: it lives
 * in the same derived-artefact row the window does, and `SyncCursorStore`
 * replaces that row's metadata rather than merging into it — which is what
 * makes a finished window clear a continuation instead of leaving one behind.
 * A cursor fake that keeps a JavaScript object proves neither.
 */

const runnable = databaseAvailable();
const suite = runnable ? describe : describe.skip;

if (!runnable) {
  process.stderr.write(`\n[ingest-continuation] SKIPPING: ${SKIP_REASON}\n\n`);
}

/** Records per page, as the source chooses to serve them. */
const PAGE_SIZE = 5;
/** Pages the source holds: comfortably past the default bound. */
const TOTAL_PAGES = 25;
const TOTAL_RECORDS = PAGE_SIZE * TOTAL_PAGES;
/** What one bounded pass can reach. The old implementation stopped here for ever. */
const OLD_CEILING = DEFAULT_INGEST_PAGE_LIMIT * PAGE_SIZE;

// ---------------------------------------------------------------------------
// A source that pages, and that honours the cursor it was handed.
// ---------------------------------------------------------------------------

interface LedgerScript {
  readonly total: number;
  /** Throw when a request arrives for this offset. */
  readonly failAtOffset?: number;
  /** Answer `unchanged` when a request arrives for this offset. */
  readonly unchangedAtOffset?: number;
}

/**
 * A ledger of entries, paged by offset.
 *
 * The cursor is the offset of the next unread entry, which is the simplest
 * thing a real paging source does and — the part that matters — is *stateless*
 * on the connector's side. A fixture that paged from an internal counter would
 * advance whether or not the ingestor handed the cursor back, and would report
 * complete ingestion for an implementation that had lost its place.
 */
class LedgerConnector implements SourceConnector {
  readonly connectorId = 'fixture.source.ledger';
  readonly contractVersion = SOURCE_CONNECTOR_CONTRACT_VERSION;
  readonly system = 'ledger';
  readonly systemOfRecord = true;
  /** Every request, in order, so what was asked for is observable. */
  readonly asked: AcquisitionRequest[] = [];

  constructor(private readonly script: LedgerScript) {}

  identify(resource: string) {
    return { system: this.system, instance: 'ledger.example.com', resource: resource.trim() };
  }

  acquire(request: AcquisitionRequest): Promise<AcquisitionPage> {
    this.asked.push(request);
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    if (!Number.isInteger(offset) || offset < 0) {
      return Promise.reject(new FerretError(ErrorCode.SOURCE_UNAVAILABLE, `Not a ledger cursor: ${String(request.cursor)}`));
    }
    if (this.script.failAtOffset === offset) {
      return Promise.reject(new FerretError(ErrorCode.SOURCE_UNAVAILABLE, 'The ledger refused the connection'));
    }
    if (this.script.unchangedAtOffset === offset) {
      return Promise.resolve({ records: [], unchanged: true });
    }

    const size = request.pageSize ?? PAGE_SIZE;
    const next = Math.min(offset + size, this.script.total);
    const records: AcquiredRecord[] = [];
    for (let index = offset; index < next; index += 1) records.push(entryRecord(index));

    return Promise.resolve({
      records,
      ...(next >= this.script.total ? {} : { cursor: String(next) }),
      checkpoint: { readTo: next },
    });
  }

  normalize(records: readonly AcquiredRecord[], context: NormalizationContext): SourceContribution {
    const entities = records.map((record) =>
      context.emitter.entity({
        kind: EntityKind.DOCUMENT,
        source: { id: record.id, scope: context.sourceEntityId },
        attributes: { title: record.metadata.title ?? record.id, location: record.id },
      }),
    );
    return {
      entities,
      relationships: entities.map((document, index) =>
        context.emitter.relationship({
          fromId: document.id,
          type: 'document_describes_entity',
          toId: context.sourceEntityId,
          sourceId: records[index]?.id ?? '',
        }),
      ),
      evidence: entities.map((document, index) =>
        context.emitter.about(document, 'title', records[index]?.metadata.title ?? ''),
      ),
    };
  }
}

function entryRecord(index: number): AcquiredRecord {
  const id = `entry-${String(index).padStart(4, '0')}`;
  return {
    id,
    kind: 'entry',
    payload: { index },
    metadata: { title: `Entry ${String(index)}`, updatedAt: '2026-09-01T00:00:00.000Z' },
  };
}

// ---------------------------------------------------------------------------

suite('large-source ingestion continues rather than restarting', () => {
  let database: TestDatabase;
  let handle: FerretDatabase;
  let deps: IngestDependencies;

  beforeAll(async () => {
    database = await createTestDatabase('ingestcont');
    handle = drizzle(database.pool);
    await migrate(database.pool, { policy: MigrationPolicy.AUTO, logger: createNullLogger() });
    deps = {
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      cursors: new SyncCursorStore(handle, database.pool),
      logger: createNullLogger(),
    };
  }, 600_000);

  afterAll(async () => {
    await database?.drop();
  });

  /** The position row as it actually sits in the database. */
  async function storedPosition(scopeId: string): Promise<Record<string, unknown> | undefined> {
    const cursor = await new SyncCursorStore(handle, database.pool).read(scopeId);
    return cursor?.position;
  }

  /** Every entry id written under this source, read back from the entity table. */
  async function ingestedIds(scopeId: string): Promise<string[]> {
    const { rows } = await database.pool.query<{ source_id: string }>(
      `select source_id from ferret.entity where source_scope = $1 and kind = $2 order by source_id`,
      [scopeId, EntityKind.DOCUMENT],
    );
    return rows.map((row) => row.source_id);
  }

  /** Run passes until the window closes, so "how many passes" is measured. */
  async function drain(
    connector: SourceConnector,
    resource: string,
    limit = 20,
  ): Promise<IngestReport[]> {
    const reports: IngestReport[] = [];
    for (let pass = 0; pass < limit; pass += 1) {
      const report = await new SourceIngestor(connector, deps).ingest({ resource }, createTestOperationContext());
      reports.push(report);
      if (report.continuation === undefined) return reports;
    }
    throw new Error(`the window never closed in ${String(limit)} passes`);
  }

  it('reads a source larger than one bounded pass to the end, omitting nothing', async () => {
    const connector = new LedgerConnector({ total: TOTAL_RECORDS });
    const reports = await drain(connector, 'general');
    const scopeId = reports[0]?.sourceEntityId ?? '';

    // The premise. If the source were not bigger than a bounded pass, nothing
    // below would distinguish the fix from the defect.
    expect(TOTAL_RECORDS).toBeGreaterThan(OLD_CEILING);

    // Pass one is exactly the old implementation's whole life: bounded, and
    // then repeated for ever. Here it is the first of several.
    expect(reports[0]?.truncated).toBe(true);
    expect(reports[0]?.counts.pages).toBe(DEFAULT_INGEST_PAGE_LIMIT);
    expect(reports[0]?.counts.records).toBe(OLD_CEILING);
    expect(reports[0]?.cursorAdvancedTo).toBeUndefined();
    expect(reports[0]?.continuation).toBe(String(OLD_CEILING));

    // Pass two resumes from where pass one stopped and finishes the source.
    expect(reports).toHaveLength(2);
    expect(reports[1]?.resumedFrom).toBe(String(OLD_CEILING));
    expect(reports[1]?.truncated).toBe(false);
    expect(reports[1]?.continuation).toBeUndefined();
    expect(reports[1]?.cursorAdvancedTo).toBeDefined();
    expect(reports[1]?.counts.records).toBe(TOTAL_RECORDS - OLD_CEILING);

    // The assertion the old implementation fails: every record is in the
    // database, not just the first `pageLimit × pageSize` of them.
    const ids = await ingestedIds(scopeId);
    expect(ids).toHaveLength(TOTAL_RECORDS);
    expect(ids[0]).toBe('entry-0000');
    expect(ids.at(-1)).toBe(`entry-${String(TOTAL_RECORDS - 1).padStart(4, '0')}`);
    // Named explicitly, because "the count is right" and "nothing was skipped"
    // are different claims when two passes each wrote a contiguous run.
    expect(ids).toStrictEqual(
      Array.from({ length: TOTAL_RECORDS }, (_, index) => `entry-${String(index).padStart(4, '0')}`),
    );

    // The source was asked for each page exactly once across the whole window:
    // no page re-read, and none skipped.
    expect(connector.asked.map((request) => request.cursor ?? '0')).toStrictEqual(
      Array.from({ length: TOTAL_PAGES }, (_, index) => String(index * PAGE_SIZE)),
    );
  });

  it('progresses the stored position, and clears the continuation when the window closes', async () => {
    const connector = new LedgerConnector({ total: TOTAL_RECORDS });
    const first = await new SourceIngestor(connector, deps).ingest(
      { resource: 'progress' },
      createTestOperationContext(),
    );
    const scopeId = first.sourceEntityId;

    // Before continuation: a page cursor and a window start, and *no*
    // `syncedAt` — the window has not closed, so there is nothing to ask from.
    const midway = await storedPosition(scopeId);
    expect(midway?.['pageCursor']).toBe(String(OLD_CEILING));
    expect(typeof midway?.['passStartedAt']).toBe('string');
    expect(midway?.['syncedAt']).toBeUndefined();
    expect(midway?.['checkpoint']).toStrictEqual({ readTo: OLD_CEILING });

    const second = await new SourceIngestor(connector, deps).ingest(
      { resource: 'progress' },
      createTestOperationContext(),
    );

    // After: the continuation is gone and the window has closed at the instant
    // it *opened*, not at the instant the last pass ran — so the next window
    // covers everything edited while this one was still being read.
    const after = await storedPosition(scopeId);
    expect(after?.['pageCursor']).toBeUndefined();
    expect(after?.['passStartedAt']).toBeUndefined();
    expect(after?.['syncedAt']).toBe(midway?.['passStartedAt']);
    expect(second.cursorAdvancedTo).toBe(midway?.['passStartedAt']);
    expect(after?.['checkpoint']).toStrictEqual({ readTo: TOTAL_RECORDS });

    // The third pass is incremental: it asks from the closed window, from the
    // beginning, with no continuation in hand.
    const third = await new SourceIngestor(new LedgerConnector({ total: TOTAL_RECORDS }), deps).ingest(
      { resource: 'progress' },
      createTestOperationContext(),
    );
    expect(third.since).toBe(second.cursorAdvancedTo);
    expect(third.resumedFrom).toBeUndefined();
  });

  it('writes each record once however many passes the window took', async () => {
    const resource = 'idempotence';
    const before = await drain(new LedgerConnector({ total: TOTAL_RECORDS }), resource);
    const scopeId = before[0]?.sourceEntityId ?? '';
    const created = before.reduce((sum, report) => sum + report.writes.entitiesCreated, 0);
    expect(created).toBe(TOTAL_RECORDS + 1); // + the source entity itself

    // A full re-read of the same source, crossing the boundary again. Nothing
    // is created and nothing is updated: the ids are derived from the record
    // ids, so the same input twice is one row — and a continuation does not
    // change that, because it changes *where* a pass reads, not *what* it emits.
    const again = await drain(new LedgerConnector({ total: TOTAL_RECORDS }), resource);
    for (const report of again) {
      expect(report.writes.entitiesCreated).toBe(0);
      expect(report.writes.entitiesUpdated).toBe(0);
      expect(report.writes.evidenceRecorded).toBe(0);
    }
    expect(await ingestedIds(scopeId)).toHaveLength(TOTAL_RECORDS);
  });

  it('does not move the stored position when a pass fails mid-window', async () => {
    const resource = 'failure';
    const connector = new LedgerConnector({ total: TOTAL_RECORDS });
    const first = await new SourceIngestor(connector, deps).ingest(
      { resource },
      createTestOperationContext(),
    );
    const scopeId = first.sourceEntityId;
    const beforeFailure = await storedPosition(scopeId);

    // The continuation pass throws part-way through, after it has already read
    // pages the previous one had not. Nothing it read is allowed to move the
    // position: resuming past a page that failed would make the gap permanent,
    // which is the same defect one layer along.
    const failing = new LedgerConnector({ total: TOTAL_RECORDS, failAtOffset: OLD_CEILING + PAGE_SIZE * 2 });
    const outcomes = await ingestSources(
      [{ connector: failing, options: { resource } }],
      deps,
      createTestOperationContext(),
    );

    expect(outcomes[0]?.status).toBe('failed');
    expect(await storedPosition(scopeId)).toStrictEqual(beforeFailure);

    // And the window still closes afterwards: a failure costs a pass, not the
    // source.
    const recovered = await drain(new LedgerConnector({ total: TOTAL_RECORDS }), resource);
    expect(recovered.at(-1)?.continuation).toBeUndefined();
    expect(await ingestedIds(scopeId)).toHaveLength(TOTAL_RECORDS);
  });

  it('leaves the position untouched when a pass is cancelled mid-window', async () => {
    const resource = 'cancellation';
    const connector = new LedgerConnector({ total: TOTAL_RECORDS });
    const first = await new SourceIngestor(connector, deps).ingest(
      { resource },
      createTestOperationContext(),
    );
    const beforeAbort = await storedPosition(first.sourceEntityId);

    const controller = new AbortController();
    controller.abort();
    await expect(
      new SourceIngestor(new LedgerConnector({ total: TOTAL_RECORDS }), deps).ingest(
        { resource },
        { logger: createNullLogger(), signal: controller.signal },
      ),
    ).rejects.toThrow();

    expect(await storedPosition(first.sourceEntityId)).toStrictEqual(beforeAbort);
  });

  it('keeps the continuation when a source claims "unchanged" mid-window', async () => {
    const resource = 'contradiction';
    const first = await new SourceIngestor(new LedgerConnector({ total: TOTAL_RECORDS }), deps).ingest(
      { resource },
      createTestOperationContext(),
    );
    expect(first.continuation).toBe(String(OLD_CEILING));

    // A source answering "nothing changed" to a request that carries a cursor
    // has contradicted itself: the tail is precisely what it was asked about.
    // Believing it would close the window over records nobody has read.
    const second = await new SourceIngestor(
      new LedgerConnector({ total: TOTAL_RECORDS, unchangedAtOffset: OLD_CEILING }),
      deps,
    ).ingest({ resource }, createTestOperationContext());

    expect(second.unchanged).toBe(true);
    expect(second.continuation).toBe(String(OLD_CEILING));
    expect(second.cursorAdvancedTo).toBeUndefined();
    expect((await storedPosition(first.sourceEntityId))?.['pageCursor']).toBe(String(OLD_CEILING));

    const recovered = await drain(new LedgerConnector({ total: TOTAL_RECORDS }), resource);
    expect(await ingestedIds(first.sourceEntityId)).toHaveLength(TOTAL_RECORDS);
    expect(recovered.at(-1)?.cursorAdvancedTo).toBeDefined();
  });

  it('discards a continuation on a full read', async () => {
    const resource = 'full';
    const first = await new SourceIngestor(new LedgerConnector({ total: TOTAL_RECORDS }), deps).ingest(
      { resource },
      createTestOperationContext(),
    );
    expect(first.continuation).toBeDefined();

    // `--full` means "read everything the source will return", which cannot
    // mean "starting from page twenty-one". It restarts, and leaves no
    // continuation for the next pass to trip over.
    const full = await new SourceIngestor(new LedgerConnector({ total: OLD_CEILING }), deps).ingest(
      { resource, full: true, pageLimit: TOTAL_PAGES },
      createTestOperationContext(),
    );
    expect(full.resumedFrom).toBeUndefined();
    expect(full.since).toBeUndefined();
    expect(full.counts.records).toBe(OLD_CEILING);
    expect(full.continuation).toBeUndefined();
    expect((await storedPosition(first.sourceEntityId))?.['pageCursor']).toBeUndefined();
  });

  it('leaves a source smaller than the bound exactly as it was', async () => {
    const connector = new LedgerConnector({ total: PAGE_SIZE * 3 });
    const report = await new SourceIngestor(connector, deps).ingest(
      { resource: 'small' },
      createTestOperationContext(),
    );

    // One pass, no truncation, no continuation, the window closed at this
    // pass's own start — the behaviour every small fixture has always asserted.
    expect(report.truncated).toBe(false);
    expect(report.resumedFrom).toBeUndefined();
    expect(report.continuation).toBeUndefined();
    expect(report.counts.pages).toBe(3);
    expect(report.counts.records).toBe(PAGE_SIZE * 3);
    expect(report.cursorAdvancedTo).toBeDefined();

    const position = await storedPosition(report.sourceEntityId);
    expect(position?.['syncedAt']).toBe(report.cursorAdvancedTo);
    expect(position?.['pageCursor']).toBeUndefined();
    expect(await ingestedIds(report.sourceEntityId)).toHaveLength(PAGE_SIZE * 3);
  });

  it('files the continuation under the connector producer', async () => {
    const report = await new SourceIngestor(new LedgerConnector({ total: TOTAL_RECORDS }), deps).ingest(
      { resource: 'producer' },
      createTestOperationContext(),
    );
    const cursor = await new SyncCursorStore(handle, database.pool).read(report.sourceEntityId);
    expect(cursor?.producer).toBe(INGEST_PRODUCER);
  });

  it('persists nothing for a dry run, continuation included', async () => {
    const report = await new SourceIngestor(new LedgerConnector({ total: TOTAL_RECORDS }), deps).ingest(
      { resource: 'dry', dryRun: true },
      createTestOperationContext(),
    );

    expect(report.truncated).toBe(true);
    expect(report.continuation).toBeUndefined();
    expect(report.cursorAdvancedTo).toBeUndefined();
    expect(await storedPosition(report.sourceEntityId)).toBeUndefined();
  });
});
