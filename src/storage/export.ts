import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { VERSION } from '../version.js';
import { ENTITY_SCHEMA_VERSION } from '../domain/index.js';
import { redactString } from '../errors/index.js';
import { redactSecrets } from '../security/index.js';

import type { FerretDatabase } from './entities.js';

/** What the export reads through: the pool, or one snapshot transaction. */
type Reader = Pick<FerretDatabase, 'execute'>;

/**
 * Export — EPIC-089.
 *
 * **A backup and an export are not the same document**, and conflating them is
 * what makes a backup strategy fail when it is needed. A backup is a
 * point-in-time copy restorable into the *same* schema version, and `pg_dump`
 * already does that correctly; an export is a document a *different* version
 * can read, which a dump cannot be — restoring schema 12 into schema 11 fails,
 * and that downgrade is what `Architecture/COMPATIBILITY.md` §7 points here for.
 *
 * So this builds the second and Ferret never wraps the first — EPIC-088 §4's
 * precedent, for its reason: "dropping the database — that is `dropdb`, and
 * Ferret does not wrap it."
 */

/** A table in the document, and the columns that order it. */
interface TableSpec {
  readonly table: string;
  /** Ordering key. Row-value comparison paginates it, so it must be unique. */
  readonly key: readonly string[];
  /** Column holding the owning entity id, when the table has one. */
  readonly scopeColumn?: string;
}

/**
 * Every table EPIC-086 owns, in dependency order.
 *
 * Order matters for the reader, not for the writer: EPIC-090 restores parents
 * before children, and a document that arrives in the order the foreign keys
 * require is one an importer can stream rather than buffer.
 */
export const EXPORT_TABLES: readonly TableSpec[] = [
  { table: 'entity', key: ['id'], scopeColumn: 'id' },
  { table: 'entity_external_id', key: ['entity_id', 'system', 'external_id'], scopeColumn: 'entity_id' },
  { table: 'relationship', key: ['id'] },
  { table: 'evidence', key: ['id'], scopeColumn: 'subject_id' },
  { table: 'evidence_derivation', key: ['evidence_id', 'source_evidence_id'] },
  { table: 'content_blob', key: ['content_hash'] },
  { table: 'derived_artifact', key: ['id'], scopeColumn: 'scope_id' },
  { table: 'identity_alias', key: ['id'] },
  { table: 'index_run', key: ['id'], scopeColumn: 'repository_id' },
];

/** Rows read per round trip. Bounds memory, not the export. */
export const EXPORT_BATCH_ROWS = 500;

/**
 * The columns PostgreSQL computes, which a document must not carry.
 *
 * Found by EPIC-090's importer, which is what an independent reader is for:
 * `SELECT *` includes `search_vector`, a `GENERATED ALWAYS` column that
 * migrations `0007` and `0011` declare — and inserting one is `428C9`, so a
 * document carrying it could not be imported at all. It is also derived data,
 * so exporting it inflates the document with bytes the target recomputes.
 *
 * Read from the catalogue rather than listed here, so a generated column added
 * by a later migration is excluded without anyone remembering to.
 */
export async function generatedColumns(
  reader: Pick<FerretDatabase, 'execute'>,
): Promise<ReadonlySet<string>> {
  return (await columnFacts(reader)).generated;
}

/**
 * What each column is, keyed `table.column`.
 *
 * Two facts, one catalogue read, because both are needed at the same moments:
 *
 * - **generated** — must not be written, and must not be exported (above).
 * - **json** — `jsonb` and `json` columns need a JSON *document*, and a scalar
 *   is where that bites: `attributes` holds an object, which `JSON.stringify`
 *   handles by accident, but `evidence.statement` can hold a bare string and
 *   `typescript` is not valid JSON while `"typescript"` is. PostgreSQL says
 *   `22P02`, which found this.
 */
export interface ColumnFacts {
  readonly generated: ReadonlySet<string>;
  readonly json: ReadonlySet<string>;
  /**
   * Every column the target actually has, keyed `table.column`.
   *
   * The allowlist an importer writes against. A column name in a document is
   * *input* — the document may have been written anywhere, by anything — and it
   * reaches the statement as an identifier, which no parameter can carry. The
   * catalogue is the only authority on what a column may be called, so it is
   * read once here rather than trusted per row.
   */
  readonly known: ReadonlySet<string>;
}

export async function columnFacts(reader: Pick<FerretDatabase, 'execute'>): Promise<ColumnFacts> {
  const rows = await reader.execute<{
    [column: string]: unknown;
    table_name: string;
    column_name: string;
    is_generated: string;
    data_type: string;
  }>(
    sql`SELECT table_name, column_name, is_generated, data_type
          FROM information_schema.columns
         WHERE table_schema = 'ferret'`,
  );

  const generated = new Set<string>();
  const json = new Set<string>();
  const known = new Set<string>();
  for (const row of rows.rows) {
    const key = `${row.table_name}.${row.column_name}`;
    known.add(key);
    if (row.is_generated === 'ALWAYS') generated.add(key);
    if (row.data_type === 'jsonb' || row.data_type === 'json') json.add(key);
  }
  return { generated, json, known };
}

/**
 * The document's first line. EPIC-090 reads this before anything else.
 *
 * Carries only what is knowable *before* the rows: the versions an importer
 * refuses on, the instant, the scope. The counts and the digest are knowable
 * only afterwards, so they are a {@link ExportTrailer} — see §8.2.
 */
export interface ExportManifest {
  readonly kind: 'ferret-export';
  /** The format's own version, separate from the schema's. */
  readonly format: 1;
  readonly ferretVersion: string;
  readonly entitySchemaVersion: number;
  readonly exportedAt: string;
  readonly scope: string | undefined;
  readonly tables: readonly string[];
}

/**
 * The document's last line.
 *
 * A digest belongs here and not in the manifest, and the reason is not
 * stylistic: a digest over the rows cannot be computed before the rows, so a
 * manifest that carried one would force either buffering the whole export or
 * scanning the index twice. An importer cannot check a digest before reading
 * the rows either way, so a header digest buys nothing and costs a second pass.
 * A truncated export is then detectable by the trailer's absence, which is the
 * failure a header digest was supposed to catch.
 */
export interface ExportTrailer {
  readonly kind: 'ferret-export-trailer';
  readonly counts: Readonly<Record<string, number>>;
  readonly rows: number;
  /** Over every row line written, in the order written. */
  readonly digest: string;
}

export interface ExportRow {
  readonly table: string;
  readonly row: Readonly<Record<string, unknown>>;
}

export interface ExportResult {
  readonly manifest: ExportManifest;
  readonly trailer: ExportTrailer;
  readonly counts: Readonly<Record<string, number>>;
  readonly digest: string;
  readonly rows: number;
}

export interface ExportOptions {
  /** A repository entity id. Absent exports everything. */
  readonly scope?: string | undefined;
  /** Rows per round trip. */
  readonly batch?: number | undefined;
}

/** Where a line goes. A function rather than a stream, so a test can collect. */
export type ExportSink = (line: string) => void | Promise<void>;

function quoted(name: string): ReturnType<typeof sql.raw> {
  // Every name here is a literal from `EXPORT_TABLES`, never a caller's input.
  return sql.raw(`"${name}"`);
}

function joined(names: readonly string[]): ReturnType<typeof sql.raw> {
  return sql.raw(names.map((name) => `"${name}"`).join(', '));
}

/**
 * An id set as **one** parameter.
 *
 * `ARRAY[$1, $2, ...]` is the shape `embeddings.ts` uses, and it binds one
 * parameter per id — which PostgreSQL caps at 65 535, so a scope containing
 * more entities than that would fail to export at all. `string_to_array` binds
 * a single parameter whatever the size. Safe because every value here is an
 * entity id: a UUID is hex and dashes, so a comma cannot appear in one, and a
 * scope that is not a UUID fails the cast rather than being silently mis-split.
 */
function idArray(ids: readonly string[], type: 'uuid' | 'text'): ReturnType<typeof sql> {
  return sql`string_to_array(${ids.join(',')}, ',')::${sql.raw(type)}[]`;
}

/**
 * Streams the index as NDJSON.
 *
 * Keyset pagination rather than a server-side cursor: `pg-cursor` is a
 * dependency Ferret does not have, and `WHERE (key) > (last) ORDER BY (key)`
 * gives the same bounded memory using the primary key index the table already
 * has. The digest is computed as rows go past, so nothing is assembled.
 */
export class ExportService {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  /**
   * Writes the whole document: manifest, rows, trailer.
   *
   * One pass. Nothing is buffered and nothing is read twice — see
   * {@link ExportTrailer} for why the digest is at the end.
   */
  async exportDocument(sink: ExportSink, options: ExportOptions = {}): Promise<ExportResult> {
    // One snapshot for the whole document.
    //
    // Without this the tables are read one after another and a concurrent index
    // run can land between two of them — producing a document with an
    // `evidence` row whose subject is absent, which EPIC-090 would have to
    // refuse. `repeatable read` gives every statement in the transaction the
    // same snapshot, so the document is a point in time rather than a mixture
    // of two. `read only` because it is, and saying so lets PostgreSQL refuse
    // a write that should never be attempted here.
    return this.#db.transaction(async (tx) => this.#write(tx, sink, options), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  async #write(
    reader: Reader,
    sink: ExportSink,
    options: ExportOptions,
  ): Promise<ExportResult> {
    const scoped = options.scope === undefined ? undefined : await this.#closure(reader, options.scope);
    const generated = await generatedColumns(reader);

    const manifest: ExportManifest = {
      kind: 'ferret-export',
      format: 1,
      ferretVersion: VERSION,
      entitySchemaVersion: ENTITY_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      scope: options.scope,
      tables: EXPORT_TABLES.map((spec) => spec.table),
    };
    await sink(JSON.stringify(manifest));

    const hash = createHash('sha256');
    const counts: Record<string, number> = {};
    let total = 0;

    for (const spec of EXPORT_TABLES) {
      let written = 0;
      for await (const row of this.#rows(reader, spec, scoped, options.batch ?? EXPORT_BATCH_ROWS)) {
        const carried = Object.fromEntries(
          Object.entries(row).filter(([column]) => !generated.has(`${spec.table}.${column}`)),
        );
        // The second line of defence, over each *value* rather than over the
        // assembled line. §8.4's first line is that a `${env:...}` reference is
        // stored as the reference and never resolved, and every producer that
        // carries untrusted text redacts before it writes.
        //
        // Over the line it was not a second line of defence but a way to lose a
        // backup. `redactSecrets` fails closed on size, replacing its whole
        // input with a sentence — and `JSON.stringify` costs six characters for
        // one stored byte of a control character, so a row far inside every
        // storage bound serialized past the scan limit, stopped being JSON, and
        // was written with a digest computed over the replacement. The trailer
        // then verified a document `ferret import` refuses as damaged.
        //
        // Per value, the framing can never be what is replaced.
        const line = JSON.stringify({ table: spec.table, row: redactRow(carried) } satisfies ExportRow);
        hash.update(line);
        hash.update('\n');
        await sink(line);
        written += 1;
        total += 1;
      }
      counts[spec.table] = written;
    }

    const trailer: ExportTrailer = {
      kind: 'ferret-export-trailer',
      counts,
      rows: total,
      digest: hash.digest('hex'),
    };
    await sink(JSON.stringify(trailer));

    return { manifest, trailer, counts, digest: trailer.digest, rows: total };
  }

  /**
   * The entity ids contained in a scope, transitively.
   *
   * Iterative rather than a recursive CTE, for EPIC-050's reason: a frontier
   * traversal is filterable a layer at a time, and the containment chain here
   * is short — repository → file → file_version — so the loop terminates in
   * three round trips on the shape Git writes.
   */
  async #closure(reader: Reader, scope: string): Promise<ReadonlySet<string>> {
    const seen = new Set<string>([scope]);
    let frontier = [scope];

    while (frontier.length > 0) {
      const rows = await reader.execute<{ [column: string]: unknown; id: string }>(
        // `source_scope` is `text`, not `uuid` — it holds a parent's id for a
        // file or a version and a repository *path* for a repository, so the
        // column cannot be typed narrower and the array must match it.
        sql`SELECT id FROM ferret.entity WHERE source_scope = ANY(${idArray(frontier, 'text')})`,
      );
      const next: string[] = [];
      for (const row of rows.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        next.push(row.id);
      }
      frontier = next;
    }

    return seen;
  }

  async *#rows(
    reader: Reader,
    spec: TableSpec,
    scoped: ReadonlySet<string> | undefined,
    batch: number,
  ): AsyncGenerator<Record<string, unknown>> {
    let after: unknown[] | undefined;

    for (;;) {
      const predicates = [sql`TRUE`];
      if (after !== undefined) {
        predicates.push(sql`(${joined(spec.key)}) > (${sql.join(after.map((value) => sql`${value}`), sql`, `)})`);
      }
      if (scoped !== undefined) {
        predicates.push(this.#scopePredicate(spec, scoped));
      }

      const rows = await reader.execute<Record<string, unknown>>(
        sql`SELECT * FROM ferret.${quoted(spec.table)}
             WHERE ${sql.join(predicates, sql` AND `)}
             ORDER BY ${joined(spec.key)}
             LIMIT ${batch}`,
      );

      if (rows.rows.length === 0) return;
      for (const row of rows.rows) yield row;

      const last = rows.rows[rows.rows.length - 1];
      after = spec.key.map((column) => last?.[column]);
      if (rows.rows.length < batch) return;
    }
  }

  /**
   * How a table narrows to a scope.
   *
   * A table with no `scopeColumn` narrows through its foreign keys instead —
   * a relationship is exported only when **both** ends are in scope, and a
   * derivation edge only when both records are. An edge with one end outside
   * the scope is dropped rather than exported dangling: EPIC-090 would have to
   * refuse it, and a document that cannot be imported is not an export.
   */
  #scopePredicate(spec: TableSpec, scoped: ReadonlySet<string>): ReturnType<typeof sql> {
    const ids = [...scoped];

    if (spec.scopeColumn !== undefined) {
      const column = quoted(spec.scopeColumn);
      // `index_run.repository_id` is nullable, and a run that names no
      // repository belongs to no scope.
      return sql`${column} = ANY(${idArray(ids, 'uuid')})`;
    }

    if (spec.table === 'relationship') {
      return sql`from_id = ANY(${idArray(ids, 'uuid')}) AND to_id = ANY(${idArray(ids, 'uuid')})`;
    }
    if (spec.table === 'evidence_derivation') {
      return sql`evidence_id IN (SELECT id FROM ferret.evidence WHERE subject_id = ANY(${idArray(ids, 'uuid')}))
             AND source_evidence_id IN (SELECT id FROM ferret.evidence WHERE subject_id = ANY(${idArray(ids, 'uuid')}))`;
    }
    if (spec.table === 'content_blob') {
      // A blob is in scope when a `file_version` in scope names it. The same
      // anti-join EPIC-088 prunes by, read the other way round.
      return sql`content_hash IN (
                   SELECT attributes->>'contentHash'
                     FROM ferret.entity
                    WHERE kind = 'file_version'
                      AND id = ANY(${idArray(ids, 'uuid')})
                      AND attributes->>'contentHash' IS NOT NULL)`;
    }
    if (spec.table === 'identity_alias') {
      return sql`actor_id = ANY(${idArray(ids, 'uuid')})`;
    }

    return sql`TRUE`;
  }
}

/** True when the line is a manifest this build understands. */
export function isExportManifest(value: unknown): value is ExportManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ExportManifest>;
  return candidate.kind === 'ferret-export' && candidate.format === 1;
}

/** True when the line is the trailer. Its absence means a truncated document. */
export function isExportTrailer(value: unknown): value is ExportTrailer {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<ExportTrailer>).kind === 'ferret-export-trailer'
  );
}

/**
 * Reads a document back.
 *
 * Here so AC-3 can round-trip, and **not** an importer: EPIC-090 owns writing
 * rows, and §16 records that a format validated only by its own writer is a
 * format nobody has validated.
 */
export function readExportDocument(text: string): {
  readonly manifest: ExportManifest | undefined;
  readonly trailer: ExportTrailer | undefined;
  readonly rows: readonly ExportRow[];
  /** Recomputed over the row lines, for comparison with the trailer's. */
  readonly digest: string;
} {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const first: unknown = lines[0] === undefined ? undefined : JSON.parse(lines[0]);
  const manifest = isExportManifest(first) ? first : undefined;

  const tail = lines[lines.length - 1];
  const last: unknown = tail === undefined || lines.length < 2 ? undefined : JSON.parse(tail);
  const trailer = isExportTrailer(last) ? last : undefined;

  const body = lines.slice(manifest === undefined ? 0 : 1, trailer === undefined ? undefined : -1);
  const hash = createHash('sha256');
  for (const line of body) {
    hash.update(line);
    hash.update('\n');
  }

  return {
    manifest,
    trailer,
    rows: body.map((line) => JSON.parse(line) as ExportRow),
    digest: hash.digest('hex'),
  };
}

/** How deep a JSON value is walked when redacting. Beyond this it is left alone. */
const MAX_REDACTION_DEPTH = 12;

/**
 * A row with every string in it scanned for credentials.
 *
 * Walks into objects and arrays, because `attributes` and `metadata` are
 * `jsonb`: a secret in a nested field is a secret. Structure is preserved
 * exactly — only string leaves can change — so whatever this returns still
 * serializes to the same shape the importer expects.
 */
function redactRow(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, redactValues(value, 1)]));
}

function redactValues(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value).text;
  if (depth >= MAX_REDACTION_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactValues(item, depth + 1));
  // Anything that is not a plain object is carried through untouched. No column
  // is binary today, and walking a `Buffer` with `Object.entries` would turn it
  // into a map of numeric keys — an export that silently rewrote the value it
  // was copying, which is the failure this whole function exists to end.
  if (value instanceof Date || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactValues(item, depth + 1)]),
  );
}

/**
 * The command an operator wants for a real backup — §8.1, AC-14.
 *
 * The URL is redacted, because this string is *printed* — to a terminal, into a
 * CI log, and inside a `--json` envelope that says `ok: true` at exit 0, which
 * is not output anything treats as sensitive. A PostgreSQL URL conventionally
 * carries the password, so passing `FERRET_DATABASE_URL` through unchanged
 * published it (EPIC-106 §11 says the opposite, and EPIC-003 and EPIC-091 both
 * require the redaction).
 *
 * The operator loses nothing: `pg_dump` reads `PGPASSWORD` and `~/.pgpass`, and
 * the host, port and database — everything needed to identify the target — are
 * still there.
 */
export function backupCommandFor(databaseUrl: string | undefined): string {
  const target = redactString(databaseUrl ?? '$FERRET_DATABASE_URL');
  return `pg_dump --format=custom --schema=ferret --file=ferret-backup.dump "${target}"`;
}
