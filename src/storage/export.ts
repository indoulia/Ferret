import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { VERSION } from '../version.js';
import { ENTITY_SCHEMA_VERSION } from '../domain/index.js';
import { ErrorCode, FerretError, redactString } from '../errors/index.js';
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

/** A table the document deliberately does not carry, and what to do about it. */
export interface ExcludedTable {
  readonly table: string;
  readonly reason: string;
  /** What an operator does instead. Never "nothing" — say so if it is lost. */
  readonly recovery: string;
}

/**
 * Every table in `ferret` that the document does **not** carry — D2, F-45.
 *
 * `EXPORT_TABLES` said what travels and nothing said what does not, so
 * `ferret.embedding` and `ferret.instance` were dropped in silence: a restore
 * lost every vector and minted a fresh identity, and neither the manifest nor
 * the import report mentioned either. The omissions were defensible; the
 * silence was not.
 *
 * This is the other half of the statement, and it is exhaustive by test:
 * `backup-contract.test.ts` asserts against a live schema that every table is
 * either exported or named here, so a table added by a later migration cannot
 * be quietly left out the way `embedding` was.
 */
export const EXPORT_EXCLUSIONS: readonly ExcludedTable[] = [
  {
    table: 'embedding',
    reason:
      'Vectors are not part of the export payload. They are derived data — reproducible from ' +
      'content by the model that made them — and carrying them would tie the document to a ' +
      'target that has pgvector and to one model version.',
    recovery:
      'Regenerate after the restore by re-indexing with an embedding provider configured. ' +
      'Ferret ships no embedding provider today, so until one is wired there is nothing to ' +
      'regenerate and semantic retrieval reports itself unavailable. Vectors are never ' +
      'fabricated to fill the gap.',
  },
  {
    table: 'instance',
    reason:
      'Instance identity is not transferable. A restored index is a second installation, and ' +
      'two installations answering to one identity is a correctness problem that outranks a ' +
      'restored index being able to name itself.',
    recovery:
      'The target keeps the identity its own `ferret init` minted. The source identity in this ' +
      "manifest's `sourceInstanceId` is recorded as provenance in `ferret.instance_restore`, so " +
      'the restore is traceable to the installation that wrote the document.',
  },
  {
    table: 'instance_restore',
    reason:
      'Bookkeeping about the importing installation, not about the index. Carrying it would ' +
      'assert that the target was restored from documents it never saw.',
    recovery: 'Not applicable — it describes the target, and the target writes its own.',
  },
  {
    table: 'schema_migrations',
    reason:
      "The target's own migration ledger. Importing another installation's would claim " +
      'migrations had run here that have not.',
    recovery: 'Not applicable — `ferret init` and `ferret upgrade` own this table.',
  },
  {
    table: 'schema_migration_failures',
    reason: "The target's own record of migrations that failed here.",
    recovery: 'Not applicable — it describes the target.',
  },
  // The four Session & Agent Memory tables — EPIC-109. One decision, stated
  // four times because the contract is per table and a reader checking one
  // should not have to find the others.
  //
  // Named here rather than exported because a scoped export narrows by *entity
  // id*, and a session is not an entity: `session.repository_id` is free text
  // precisely so a session can be recorded outside any repository Ferret has
  // indexed (EPIC-039 AC-3). There is no predicate that answers "which sessions
  // belong to this scope" without first deciding what a scoped export of a
  // session means, and that decision is not in the repository. Carrying them
  // only in a full export and silently dropping them from a scoped one is the
  // exact silence F-45 was about, so they travel in neither until it is made.
  {
    table: 'session',
    reason:
      'Session identity and lifecycle are not part of the export payload. A scoped export narrows by ' +
      'entity id and a session is not an entity, so there is no scope predicate for one; carrying ' +
      'sessions in a full export and dropping them from a scoped export would be an omission the ' +
      'manifest could not describe.',
    recovery:
      'Session context does not survive `ferret export` and `ferret import` — it is lost, and this ' +
      'says so rather than implying otherwise. Use `pg_dump` for a full-fidelity copy of an ' +
      'installation, which EPIC-089 §8.1 already assigns it. Roadmap EPIC-116 decides what a scoped ' +
      'export of a session means; until it does, nothing is exported rather than exported partially.',
  },
  {
    table: 'session_capture',
    reason:
      'The raw transcript of a session, which travels with the session or not at all. Excluded for ' +
      'the same reason `session` is, and additionally the largest and least reconstructable payload ' +
      'in the schema.',
    recovery:
      'Lost on export/import; use `pg_dump`. The transcript is evidence in EPIC-008\'s sense and ' +
      'cannot be regenerated from anything else once the installation is gone.',
  },
  {
    table: 'session_checkpoint',
    reason: 'Derived from a session, and excluded with it — a checkpoint whose session did not travel is dangling.',
    recovery: 'Lost on export/import; use `pg_dump`.',
  },
  {
    table: 'engineering_memory',
    reason:
      'What a session decided and learned. Excluded with its session: a memory names the captures it ' +
      'was drawn from, and importing it without them would carry a claim whose evidence did not ' +
      'arrive — the one thing EPIC-042 exists to prevent.',
    recovery:
      'Lost on export/import; use `pg_dump`. This is the most valuable thing the exclusion costs, ' +
      'and it is the reason EPIC-116 exists rather than a reason to carry it half-formed.',
  },
];

/**
 * A value the credential scanner recognises, exported faithfully and reported.
 *
 * Never carries the value, and the row's key is redacted before it is put here:
 * `entity_external_id` is keyed partly on `external_id`, so a key echoed
 * verbatim could republish the very string this is warning about.
 */
export interface CredentialFinding {
  readonly table: string;
  readonly column: string;
  /** The row's key, redacted. Enough to find the row, never enough to leak it. */
  readonly key: string;
  /** Which credential shapes fired, from `SECRET_KINDS`. */
  readonly kinds: readonly string[];
}

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
  /**
   * What the document does **not** carry — D2, F-45.
   *
   * Optional in the type and always written by this build. A document from
   * before D2 has no `excluded`, and `ferret import` says the manifest predates
   * the declaration rather than reporting that nothing was excluded — the two
   * are different claims and only one of them would be true.
   */
  readonly excluded?: readonly ExcludedTable[];
  /**
   * The identity of the installation that wrote this document — D2.
   *
   * Carried as provenance and **never** restored: `ferret.instance` is excluded
   * above, so an import records this alongside the target's own identity rather
   * than replacing it. `undefined` when the source predates migration 0001 or
   * could not be read, which is recorded as `undefined` rather than guessed.
   */
  readonly sourceInstanceId?: string | undefined;
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
  /**
   * Values the credential scanner recognised, exported faithfully — D1, F-44.
   *
   * Here and not in the manifest for the digest's reason: it is knowable only
   * after the rows have gone past. Absent in documents written before D1, and
   * an empty array is the positive statement that the scanner found nothing —
   * which is not the same claim as "this build did not look".
   */
  readonly credentialShaped?: readonly CredentialFinding[];
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
  /** What the scanner recognised. Empty means it looked and found nothing. */
  readonly credentialShaped: readonly CredentialFinding[];
}

export interface ExportOptions {
  /** A repository entity id. Absent exports everything. */
  readonly scope?: string | undefined;
  /** Rows per round trip. */
  readonly batch?: number | undefined;
  /**
   * Refuse rather than write a document carrying a credential-shaped value — D1.
   *
   * The default export is faithful and says what it carried. Strict is for the
   * operator who would rather have no document than one with a credential in
   * it: neither emitting the value (a credential in a cleartext file) nor
   * rewriting it (a hash that no longer describes its row) is acceptable, so
   * the export refuses and names the row.
   */
  readonly strict?: boolean | undefined;
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
      // D2 — the document says what it does not carry, in the line an importer
      // reads first, so "vectors are absent" arrives before any row does.
      excluded: EXPORT_EXCLUSIONS,
      sourceInstanceId: await this.#instanceId(reader),
    };
    await sink(JSON.stringify(manifest));

    const hash = createHash('sha256');
    const counts: Record<string, number> = {};
    const credentialShaped: CredentialFinding[] = [];
    let total = 0;

    for (const spec of EXPORT_TABLES) {
      let written = 0;
      for await (const row of this.#rows(reader, spec, scoped, options.batch ?? EXPORT_BATCH_ROWS)) {
        const carried = Object.fromEntries(
          Object.entries(row).filter(([column]) => !generated.has(`${spec.table}.${column}`)),
        );

        // **D1 — the scanner still runs, and it no longer rewrites.**
        //
        // §11 requires the redactor to apply to an export, and it does: every
        // string value is scanned. What changed is what happens when it fires.
        //
        // It used to substitute the value. `content_hash` is derived from
        // `attributes` (`domain/entity.ts`) and was exported as it stood, so a
        // single rewritten string left the hash describing a row that no longer
        // existed — measured: one credential-shaped file path produced five
        // findings from `ferret verify` on the restored index, including
        // `evidence-tampered`, each naming a cause that was false and each
        // remediating with "re-read the source", which is the one thing a
        // restore cannot do. And `sameContent` compares the hash alone, so
        // re-importing that document into the live index reported `unchanged`
        // and discarded the redaction — meaning EPIC-090 §8.7's
        // export-then-import scrub silently scrubbed nothing.
        //
        // EPIC-087 §8.2 already settles where redaction belongs: "before it
        // lands, never on the way out", because a read-time control is one a
        // new caller can forget. EPIC-089 §8.5 says content is exported as
        // content. EPIC-090 §8.7 wants the *unfiltered* document so the filter
        // that ran is auditable. Governance §6 forbids rewriting source
        // evidence silently. So the row goes out as it is, and the finding is
        // reported rather than applied.
        const finding = findCredentials(spec.table, spec.key, carried);
        if (finding !== undefined) {
          // Strict cannot satisfy both halves of the contract at once — the
          // faithful value is a credential in a cleartext file, and the
          // redacted one is a hash that lies — so it satisfies neither and
          // says so. Thrown mid-stream on purpose: the trailer is never
          // written, so whatever reached the sink is a document `readDocument`
          // refuses as truncated rather than a shorter export that looks whole.
          if (options.strict === true) throw strictRefusal(finding);
          credentialShaped.push(finding);
        }

        const line = JSON.stringify({ table: spec.table, row: carried } satisfies ExportRow);
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
      credentialShaped,
    };
    await sink(JSON.stringify(trailer));

    return { manifest, trailer, counts, digest: trailer.digest, rows: total, credentialShaped };
  }

  /**
   * This installation's identity, for the manifest's `sourceInstanceId` — D2.
   *
   * Absent rather than guessed when it cannot be read. The table is migration
   * 0001's, so the only way to reach this without it is a database mid-bootstrap
   * — and a document that claimed an identity it had not read would be worse
   * than one that admits it has none.
   */
  async #instanceId(reader: Reader): Promise<string | undefined> {
    try {
      const rows = await reader.execute<{ [column: string]: unknown; instance_id: string }>(
        sql`SELECT instance_id FROM ferret.instance LIMIT 1`,
      );
      return rows.rows[0]?.instance_id;
    } catch {
      return undefined;
    }
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

/** How deep a JSON value is walked when scanning. Beyond this it is left alone. */
const MAX_SCAN_DEPTH = 12;

/**
 * Whether a row carries a credential-shaped value — D1, and it changes nothing.
 *
 * Walks into objects and arrays, because `attributes` and `metadata` are
 * `jsonb`: a secret in a nested field is a secret. The row itself is never
 * touched — that is the whole difference from what this replaced.
 *
 * `redactSecrets` is used as the oracle rather than a second pattern list, so
 * "what the export reports" and "what every other surface redacts" cannot
 * drift apart. It is also idempotent (measured), which is why a value already
 * redacted at insert produces no finding here: only a producer that skipped
 * insert-time redaction reaches this.
 */
function findCredentials(
  table: string,
  key: readonly string[],
  row: Readonly<Record<string, unknown>>,
): CredentialFinding | undefined {
  for (const [column, value] of Object.entries(row)) {
    const kinds = scanValue(value, 1);
    if (kinds.length > 0) {
      return {
        table,
        column,
        // Redacted, because `entity_external_id` is keyed partly on
        // `external_id`: a key echoed verbatim could republish the string this
        // finding exists to warn about. Printed output, so the same rule as
        // `backupCommandFor`.
        key: redactSecrets(key.map((name) => keyPart(row[name])).join(':')).text,
        kinds,
      };
    }
  }
  return undefined;
}

/** One column of a row's key, as text. Never `[object Object]`. */
function keyPart(value: unknown): string {
  if (value === null || value === undefined) return '?';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  // Every `TableSpec.key` is a text, uuid or integer column, so this branch is
  // unreachable today and says so rather than stringifying into nonsense.
  return '?';
}

function scanValue(value: unknown, depth = 0): readonly string[] {
  if (typeof value === 'string') return Object.keys(redactSecrets(value).found);
  if (depth >= MAX_SCAN_DEPTH || value === null || typeof value !== 'object') return [];
  // A Date or a Buffer has no string leaves to scan, and walking one with
  // `Object.entries` would produce a map of numeric keys.
  if (value instanceof Date || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return [];
  const found = new Set<string>();
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    for (const kind of scanValue(item, depth + 1)) found.add(kind);
  }
  return [...found];
}

/**
 * The strict refusal — D1.
 *
 * Names the table, the column and the row, and says which of the two
 * guarantees could not be kept. `EXPORT_REFUSED` rather than a generic failure
 * so a caller can tell "this index cannot be exported strictly" from "the
 * database went away".
 */
function strictRefusal(finding: CredentialFinding): FerretError {
  return new FerretError(
    ErrorCode.EXPORT_REFUSED,
    `Strict export refused: ${finding.table}.${finding.column} carries a ${finding.kinds.join(', ')} ` +
      `shape (row ${finding.key}). A faithful export would write that value into a cleartext ` +
      'document; a redacted one would carry a content hash that no longer describes its row. ' +
      'Strict mode satisfies neither, so it exports nothing.',
    {
      details: {
        table: finding.table,
        column: finding.column,
        row: finding.key,
        kinds: finding.kinds,
      },
      remediation:
        'Remove the credential at its source and re-index so insert-time redaction covers it ' +
        '(EPIC-087 §8.2), then export again. To take the document as it stands — faithful, with ' +
        'the value in it, and the finding recorded in the trailer — run `ferret export` without ' +
        '`--strict`.',
    },
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
