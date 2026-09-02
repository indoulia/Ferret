import { sql } from 'drizzle-orm';

import { ENTITY_SCHEMA_VERSION } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';
import {
  EXPORT_TABLES,
  columnFacts,
  isExportManifest,
  isExportTrailer,
  type ColumnFacts,
  type ExportManifest,
  type ExportRow,
  type ExportTrailer,
} from './export.js';

/**
 * Import — EPIC-090.
 *
 * EPIC-089 wrote a format and validated it with a reader whose author was the
 * writer's, which its §16 recorded as the weaker guarantee. This is the reader
 * written against the format, and that is most of the value here.
 *
 * **Nothing is written until the whole document has been read.** The digest
 * lives in the trailer, so integrity is only knowable at the end — which means
 * two passes. That is the right way round: a partial import is worse than a
 * slow one, because it leaves an index that looks complete.
 */

/** What happened to one row. */
export const ImportOutcome = {
  WRITTEN: 'written',
  /** Already present, byte for byte. EPIC-080's idempotence, inherited. */
  UNCHANGED: 'unchanged',
  /** Present with a different content hash — §8.4 does not adjudicate. */
  CONFLICTING: 'conflicting',
  /** A parent row is absent, so the foreign key would fail. */
  ORPHANED: 'orphaned',
} as const;

export type ImportOutcome = (typeof ImportOutcome)[keyof typeof ImportOutcome];

export interface ImportTableReport {
  readonly table: string;
  readonly written: number;
  readonly unchanged: number;
  readonly conflicting: number;
  readonly orphaned: number;
  /** Ids whose parent was absent, so a diagnosis names the row. */
  readonly orphans: readonly string[];
  readonly failure?: string | undefined;
}

export interface ImportReport {
  readonly manifest: ExportManifest;
  readonly trailer: ExportTrailer;
  readonly tables: readonly ImportTableReport[];
  /** True when rows were written; false for a plan — §8.1, EPIC-088's shape. */
  readonly applied: boolean;
}

export interface ImportOptions {
  /** False plans and writes nothing. The default. */
  readonly apply?: boolean | undefined;
}

/** How many orphan ids a report names before it stops listing them. */
export const MAX_REPORTED_ORPHANS = 20;

function refuse(message: string, details: Record<string, unknown> = {}): FerretError {
  return new FerretError(ErrorCode.SCHEMA_UNSUPPORTED, message, {
    details,
    remediation:
      'Export the index again with the Ferret version that wrote this document, or import it into a build that understands its format.',
  });
}

/**
 * A document read and checked, before anything is written.
 *
 * Produced by {@link readDocument} and consumed by {@link ImportService}. The
 * split is the contract: a document that does not parse, does not verify, or
 * names a version this build cannot read never reaches a write path at all.
 */
export interface CheckedDocument {
  readonly manifest: ExportManifest;
  readonly trailer: ExportTrailer;
  readonly rows: readonly ExportRow[];
}

/**
 * Parses and verifies a document.
 *
 * Every refusal here happens before a database connection is used, so an
 * unreadable document costs nothing and reports precisely.
 */
export function readDocument(text: string, digestOf: (lines: readonly string[]) => string): CheckedDocument {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw refuse('The document is empty.');

  let head: unknown;
  try {
    head = JSON.parse(lines[0] ?? '');
  } catch {
    throw refuse('The first line is not JSON, so this is not a Ferret export.');
  }

  // §8.2 — the manifest is checked first, and an unknown one is refused by
  // name rather than parsed optimistically.
  if (!isExportManifest(head)) {
    const kind = (head as { kind?: unknown }).kind;
    throw refuse(
      `The first line is not a Ferret export manifest${typeof kind === 'string' ? ` (kind "${kind}")` : ''}.`,
      { firstLineKind: typeof kind === 'string' ? kind : undefined },
    );
  }
  const manifest = head;

  // Newer than this build understands. EPIC-002 gives the reason for the
  // database schema and EPIC-006 for the entity envelope: reading a newer
  // envelope under the old meaning applies an interpretation the writer never
  // intended, and quietly. An *older* version is accepted — that is the
  // downgrade path `COMPATIBILITY.md` §7 sends here.
  if (manifest.entitySchemaVersion > ENTITY_SCHEMA_VERSION) {
    throw refuse(
      `The document was written with entity schema version ${String(manifest.entitySchemaVersion)}, and this Ferret understands up to ${String(ENTITY_SCHEMA_VERSION)}.`,
      { documentSchemaVersion: manifest.entitySchemaVersion, supported: ENTITY_SCHEMA_VERSION },
    );
  }

  let tail: unknown;
  try {
    tail = lines.length > 1 ? JSON.parse(lines[lines.length - 1] ?? '') : undefined;
  } catch {
    tail = undefined;
  }

  // §8.1 — no trailer means the document is truncated. EPIC-089 put the digest
  // at the end precisely so this case is detectable rather than silent.
  if (!isExportTrailer(tail)) {
    throw refuse(
      'The document has no trailer, so it was truncated. Nothing has been imported; re-export it.',
      { linesRead: lines.length },
    );
  }
  const trailer = tail;

  const body = lines.slice(1, -1);
  const digest = digestOf(body);
  if (digest !== trailer.digest) {
    throw refuse(
      'The document rows do not hash to the digest its trailer records, so it was altered or damaged in transit. Nothing has been imported.',
      { expected: trailer.digest, actual: digest },
    );
  }
  if (body.length !== trailer.rows) {
    throw refuse(
      `The trailer records ${String(trailer.rows)} row(s) and the document carries ${String(body.length)}.`,
      { expected: trailer.rows, actual: body.length },
    );
  }

  const rows: ExportRow[] = [];
  for (const [index, line] of body.entries()) {
    try {
      rows.push(JSON.parse(line) as ExportRow);
    } catch {
      throw refuse(`Row ${String(index + 1)} is not JSON, so the document is damaged.`, {
        row: index + 1,
      });
    }
  }

  return { manifest, trailer, rows };
}

/**
 * Writes a checked document.
 *
 * Rows go through the same tables EPIC-089 read, in the order the manifest
 * names — which EPIC-089 §8.6 chose so parents arrive before children and an
 * importer can stream rather than buffer.
 */
export class ImportService {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  async importDocument(document: CheckedDocument, options: ImportOptions = {}): Promise<ImportReport> {
    const apply = options.apply === true;
    const byTable = new Map<string, ExportRow[]>();
    for (const row of document.rows) {
      const existing = byTable.get(row.table);
      if (existing === undefined) byTable.set(row.table, [row]);
      else existing.push(row);
    }

    // A document written before EPIC-089 excluded generated columns still
    // carries `search_vector`, and inserting one is `428C9`. Read from the
    // target's own catalogue, so an old document imports into a new build.
    const facts = await columnFacts(this.#db);

    const tables: ImportTableReport[] = [];
    // The manifest's order, not the document's: a hand-concatenated document
    // could interleave tables, and a child written before its parent fails on a
    // foreign key that the order exists to prevent.
    for (const spec of EXPORT_TABLES) {
      const rows = byTable.get(spec.table) ?? [];
      if (rows.length === 0) {
        tables.push({ table: spec.table, written: 0, unchanged: 0, conflicting: 0, orphaned: 0, orphans: [] });
        continue;
      }
      tables.push(await this.#table(spec.table, spec.key, rows, apply, facts));
    }

    return { manifest: document.manifest, trailer: document.trailer, tables, applied: apply };
  }

  /**
   * One table, one transaction — EPIC-088 §8.5's grain, for its reason: a
   * failure on one table does not roll back a table that succeeded, and the
   * report can describe what happened at that granularity.
   */
  async #table(
    table: string,
    key: readonly string[],
    rows: readonly ExportRow[],
    apply: boolean,
    facts: ColumnFacts,
  ): Promise<ImportTableReport> {
    let written = 0;
    let unchanged = 0;
    let conflicting = 0;
    const orphans: string[] = [];

    try {
      const run = async (tx: Pick<FerretDatabase, 'execute'>): Promise<void> => {
        for (const row of rows) {
          const writable = Object.fromEntries(
            Object.entries(row.row).filter(([column]) => !facts.generated.has(`${table}.${column}`)),
          );
          const verdict = await this.#row(tx, table, key, writable, apply, facts, table);
          if (verdict === ImportOutcome.WRITTEN) written += 1;
          else if (verdict === ImportOutcome.UNCHANGED) unchanged += 1;
          else if (verdict === ImportOutcome.CONFLICTING) conflicting += 1;
          else if (orphans.length < MAX_REPORTED_ORPHANS) orphans.push(identify(key, row.row));
          else orphans.push('…');
        }
      };

      if (apply) await this.#db.transaction(async (tx) => run(tx));
      else await run(this.#db);
    } catch (error) {
      return {
        table,
        written,
        unchanged,
        conflicting,
        orphaned: orphans.length,
        orphans,
        failure: classifyDatabaseError(error, `import.${table}`).message,
      };
    }

    return {
      table,
      written,
      unchanged,
      conflicting,
      orphaned: orphans.filter((one) => one !== '…').length,
      orphans,
    };
  }

  async #row(
    tx: Pick<FerretDatabase, 'execute'>,
    table: string,
    key: readonly string[],
    row: Readonly<Record<string, unknown>>,
    apply: boolean,
    facts: ColumnFacts,
    tableName: string,
  ): Promise<ImportOutcome> {
    const columns = Object.keys(row);
    const where = sql.join(
      key.map((column) => sql`${sql.raw(`"${column}"`)} = ${row[column] ?? null}`),
      sql` AND `,
    );

    const existing = await tx.execute<Record<string, unknown>>(
      sql`SELECT * FROM ferret.${sql.raw(`"${table}"`)} WHERE ${where} LIMIT 1`,
    );
    const present = existing.rows[0];

    if (present !== undefined) {
      // §8.4 — present and identical is `unchanged`; present and different is a
      // disagreement between two installations, which this Epic reports and
      // does not adjudicate. Choosing a winner is the merge problem §4
      // excludes, and `--overwrite` is deliberately not offered.
      return sameContent(present, row) ? ImportOutcome.UNCHANGED : ImportOutcome.CONFLICTING;
    }

    if (!apply) return ImportOutcome.WRITTEN;

    // A savepoint per row, so a foreign-key violation is one row's problem
    // rather than the table's. Without it the first orphan aborts the
    // transaction and every row after it fails for a reason that is not its own.
    const savepoint = 'ferret_import_row';
    await tx.execute(sql`SAVEPOINT ${sql.raw(savepoint)}`);
    try {
      await tx.execute(
        sql`INSERT INTO ferret.${sql.raw(`"${table}"`)} (${sql.raw(columns.map((c) => `"${c}"`).join(', '))})
            VALUES (${sql.join(
              columns.map((column) => sql`${normalise(row[column], facts.json.has(`${tableName}.${column}`))}`),
              sql`, `,
            )})`,
      );
      await tx.execute(sql`RELEASE SAVEPOINT ${sql.raw(savepoint)}`);
      return ImportOutcome.WRITTEN;
    } catch (error) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT ${sql.raw(savepoint)}`);
      // §8.6 — a foreign key failure is the document's shape, not the
      // operator's mistake: a scoped export can legitimately reference an
      // entity outside its scope. Anything else is a real failure and is
      // raised.
      if (isForeignKeyViolation(error)) return ImportOutcome.ORPHANED;
      throw error;
    }
  }
}

/**
 * `23503` — foreign key violation.
 *
 * Walked down the `cause` chain: the driver's error is wrapped by Drizzle, so
 * the SQLSTATE is not on the object the `catch` receives. Checking only the top
 * level made every orphan a table-wide failure instead of one reported row.
 */
function isForeignKeyViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === '23503') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A row's key, for a report that names which row rather than how many. */
function identify(key: readonly string[], row: Readonly<Record<string, unknown>>): string {
  return key.map((column) => comparable(row[column]) || '?').join(':');
}

/**
 * `jsonb` and `timestamptz` arrive from JSON as an object and a string.
 *
 * The driver serialises a plain object as a Postgres record rather than JSON,
 * so a `jsonb` column needs the text. A timestamp string is left alone —
 * PostgreSQL parses ISO-8601, and converting it here would add a round trip
 * through the local timezone for no gain.
 */
function normalise(value: unknown, json: boolean): unknown {
  if (value === null || value === undefined) return null;
  // A JSON column needs a JSON *document*, and a scalar is where that bites:
  // `typescript` is not valid JSON, `"typescript"` is. PostgreSQL says
  // `22P02`, which is how this was found.
  if (json) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * Whether a stored row is the same fact as an incoming one.
 *
 * `content_hash` when the table has one — that is what it is for, and EPIC-006
 * derives it from everything a change could alter. Otherwise every shared
 * column, because a table without a hash (a join row) is its own key.
 *
 * `last_indexed_at` is excluded on both paths: it records when Ferret last
 * *looked*, and comparing it would make every import a conflict.
 */
function sameContent(stored: Record<string, unknown>, incoming: Readonly<Record<string, unknown>>): boolean {
  if ('content_hash' in stored && 'content_hash' in incoming) {
    return String(stored['content_hash']) === String(incoming['content_hash']);
  }
  for (const [column, value] of Object.entries(incoming)) {
    if (column === 'last_indexed_at' || column === 'last_checked_at' || column === 'first_indexed_at') continue;
    if (!(column in stored)) continue;
    if (comparable(stored[column]) !== comparable(value)) return false;
  }
  return true;
}

function comparable(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // A symbol or a function cannot appear in JSON-parsed data, so this is the
  // branch that says so rather than stringifying it into nonsense.
  return '';
}
