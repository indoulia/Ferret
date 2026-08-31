import { sql } from 'drizzle-orm';

import type { CanonicalEntity, CanonicalEvidence } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import {
  Direction,
  HitSource,
  boundedLimit,
  type EntityQuery,
  type Neighbour,
  type RetrievalPort,
  type SearchHit,
  type SearchQuery,
  type TraversalQuery,
} from '../retrieval/index.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';

/**
 * Answering questions against the stored graph.
 *
 * The queries here are raw `sql` templates rather than Drizzle's builder, which
 * TECHNOLOGY-DECISIONS §3 anticipated: full-text and temporal predicates have no
 * builder representation, and half a query in a builder with the interesting
 * half in a template is harder to read than the whole thing in one place.
 *
 * Every value is a bind parameter. Not one string in this file is concatenated
 * into SQL — a search term arrives from an AI client, and a query built by
 * concatenation would be an injection with a very short path from the outside
 * world.
 */

interface EntityRowShape {
  // Drizzle's `execute<T>` requires an index signature, because a raw result set
  // is a bag of columns by name. Naming the columns as well keeps the mapping
  // below honest rather than trusting whatever came back.
  [column: string]: unknown;
  id: string;
  kind: string;
  canonical_key: string;
  schema_version: number;
  source_system: string;
  source_id: string;
  source_url: string | null;
  source_scope: string | null;
  lifecycle: string;
  attributes: Record<string, unknown>;
  unknown_fields: Record<string, unknown>;
  source_observed_at: Date | string | null;
  content_hash: string;
}

/**
 * A timestamp column from a raw query, as an ISO string.
 *
 * `execute` with a raw template bypasses Drizzle's column parsers, so a
 * `timestamptz` arrives as whatever `pg` produced — a `Date` when the driver
 * has a parser registered for the OID, a string when the column came through a
 * subquery or a `UNION` that erased its type. Handling both is cheaper than
 * relying on which.
 */
function instant(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return new Date(value).toISOString();
  return undefined;
}

function toEntity(row: EntityRowShape): CanonicalEntity {
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    canonicalKey: row.canonical_key,
    schemaVersion: row.schema_version,
    source: Object.freeze({
      system: row.source_system,
      id: row.source_id,
      ...(row.source_url === null ? {} : { url: row.source_url }),
      ...(row.source_scope === null ? {} : { scope: row.source_scope }),
    }),
    lifecycle: row.lifecycle,
    attributes: Object.freeze(row.attributes),
    unknownFields: Object.freeze(row.unknown_fields),
    // Deliberately empty: external ids are a second query, and a search result
    // that silently issued one per hit would turn a page of fifty into fifty-one
    // round trips. `getEntity` returns them.
    externalIds: Object.freeze([]),
    sourceObservedAt: instant(row.source_observed_at),
    contentHash: row.content_hash,
  }) as CanonicalEntity;
}

const ENTITY_COLUMNS = sql`e.id, e.kind, e.canonical_key, e.schema_version, e.source_system,
  e.source_id, e.source_url, e.source_scope, e.lifecycle, e.attributes, e.unknown_fields,
  e.source_observed_at, e.content_hash`;

export class RetrievalStore implements RetrievalPort {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  /**
   * Exact structured retrieval.
   *
   * Deterministic and unranked. *Which files does this repository contain* has
   * a right answer, and returning a relevance-ordered approximation of it would
   * be worse than returning nothing — a caller cannot tell the difference
   * between "these are the files" and "these are probably the files".
   */
  async findEntities(query: EntityQuery): Promise<readonly CanonicalEntity[]> {
    const limit = boundedLimit(query.limit);
    const offset = query.offset ?? 0;

    const conditions = [sql`true`];
    if (query.kind !== undefined) conditions.push(sql`e.kind = ${query.kind}`);
    if (query.kinds !== undefined && query.kinds.length > 0) {
      conditions.push(sql`e.kind = ANY(${sql.raw('ARRAY[')}${sql.join(query.kinds.map((k) => sql`${k}`), sql`, `)}${sql.raw(']::text[]')})`);
    }
    if (query.sourceSystem !== undefined) conditions.push(sql`e.source_system = ${query.sourceSystem}`);
    if (query.scope !== undefined) conditions.push(sql`e.source_scope = ${query.scope}`);
    if (query.lifecycle !== undefined) conditions.push(sql`e.lifecycle = ${query.lifecycle}`);

    for (const [key, value] of Object.entries(query.attributes ?? {})) {
      // The key is a bind parameter too. An attribute name reaching a query as
      // interpolated text would be an injection through a field nobody thinks of
      // as user input.
      conditions.push(sql`e.attributes->>${key} = ${value}`);
    }

    if (query.externalId !== undefined) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ferret.entity_external_id x
         WHERE x.entity_id = e.id AND x.system = ${query.externalId.system} AND x.external_id = ${query.externalId.id}
      )`);
    }

    try {
      const rows = await this.#db.execute<EntityRowShape>(sql`
        SELECT ${ENTITY_COLUMNS}
          FROM ferret.entity e
         WHERE ${sql.join(conditions, sql` AND `)}
         ORDER BY e.kind, e.source_id
         LIMIT ${limit} OFFSET ${offset}
      `);
      return rows.rows.map(toEntity);
    } catch (error) {
      throw classifyDatabaseError(error, 'retrieval.findEntities');
    }
  }

  async getEntity(id: string): Promise<CanonicalEntity | undefined> {
    try {
      const rows = await this.#db.execute<EntityRowShape>(sql`
        SELECT ${ENTITY_COLUMNS} FROM ferret.entity e WHERE e.id = ${id} LIMIT 1
      `);
      const row = rows.rows[0];
      if (row === undefined) return undefined;

      const ids = await this.#db.execute<{ system: string; external_id: string; url: string | null }>(sql`
        SELECT system, external_id, url FROM ferret.entity_external_id WHERE entity_id = ${id}
      `);
      return Object.freeze({
        ...toEntity(row),
        externalIds: Object.freeze(
          ids.rows.map((external) =>
            Object.freeze({
              system: external.system,
              id: external.external_id,
              ...(external.url === null ? {} : { url: external.url }),
            }),
          ),
        ),
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'retrieval.getEntity');
    }
  }

  /**
   * What is connected to an entity, as of an instant.
   *
   * The `at` predicate is the reason relationships carry valid time at all.
   * Half-open intervals: `valid_from <= at < valid_to`, so an interval that
   * ended at exactly the instant asked about does *not* match — the same
   * convention EPIC-007 uses everywhere, and mixing the two is how a worktree
   * appears to be on two branches for one instant.
   */
  async neighbours(query: TraversalQuery): Promise<readonly Neighbour[]> {
    const limit = boundedLimit(query.limit);
    const direction = query.direction ?? Direction.BOTH;
    const at = query.at ?? new Date().toISOString();

    const typeFilter =
      query.types === undefined || query.types.length === 0
        ? sql`true`
        : sql`r.type = ANY(${sql.raw('ARRAY[')}${sql.join(query.types.map((t) => sql`${t}`), sql`, `)}${sql.raw(']::text[]')})`;

    // Half-open, so an edge that ended at T was not true *at* T. Asking for
    // history drops the bound entirely rather than widening it: a caller who
    // wants every assertion ever made has no instant to reason about.
    const temporal =
      query.includeHistorical === true
        ? sql`true`
        : sql`r.valid_from <= ${at}::timestamptz AND (r.valid_to IS NULL OR r.valid_to > ${at}::timestamptz)`;

    const outward = sql`
      SELECT ${ENTITY_COLUMNS}, r.type AS rel_type, 'out' AS rel_direction, r.valid_from, r.valid_to, r.metadata AS rel_metadata
        FROM ferret.relationship r
        JOIN ferret.entity e ON e.id = r.to_id
       WHERE r.from_id = ${query.from} AND ${typeFilter} AND ${temporal}`;

    const inward = sql`
      SELECT ${ENTITY_COLUMNS}, r.type AS rel_type, 'in' AS rel_direction, r.valid_from, r.valid_to, r.metadata AS rel_metadata
        FROM ferret.relationship r
        JOIN ferret.entity e ON e.id = r.from_id
       WHERE r.to_id = ${query.from} AND ${typeFilter} AND ${temporal}`;

    const body =
      direction === Direction.OUT
        ? outward
        : direction === Direction.IN
          ? inward
          : sql`${outward} UNION ALL ${inward}`;

    try {
      const rows = await this.#db.execute<
        EntityRowShape & {
          rel_type: string;
          rel_direction: 'in' | 'out';
          valid_from: Date | string;
          valid_to: Date | string | null;
          rel_metadata: Record<string, unknown> | null;
        }
      >(
        sql`SELECT * FROM (${body}) neighbours ORDER BY rel_type, valid_from DESC, source_id LIMIT ${limit}`,
      );

      return rows.rows.map((row) => ({
        entity: toEntity(row),
        relationshipType: row.rel_type,
        direction: row.rel_direction,
        validFrom: instant(row.valid_from) ?? new Date(0).toISOString(),
        validTo: instant(row.valid_to) ?? null,
        metadata: row.rel_metadata ?? {},
      }));
    } catch (error) {
      throw classifyDatabaseError(error, 'retrieval.neighbours');
    }
  }

  /**
   * Full-text retrieval over what things are called and what was said about
   * them.
   *
   * `websearch_to_tsquery` rather than `plainto_tsquery`: it understands quoted
   * phrases, `or`, and `-exclusion`, which is what a person types without being
   * told a syntax. It also never throws on malformed input — `plainto_tsquery`
   * and `to_tsquery` both do, and a search box that can be crashed by a stray
   * parenthesis is a search box that will be.
   *
   * Entity names and evidence statements are searched together because they
   * answer the same question from different angles: a commit's message is on the
   * commit, but a sentence extracted from a document exists only as evidence.
   */
  async search(query: SearchQuery): Promise<readonly SearchHit[]> {
    const limit = boundedLimit(query.limit);
    const text = query.text.trim();
    if (text.length === 0) {
      throw new FerretError(ErrorCode.USAGE, 'A search needs something to search for', {
        details: {},
        remediation: 'Pass a non-empty query.',
      });
    }
    if (text.length > 1024) {
      // A search term arrives from an AI client. Parsing an unbounded one is
      // work an attacker gets for free.
      throw new FerretError(ErrorCode.USAGE, 'Search text is longer than Ferret will parse', {
        details: { length: text.length, maximum: 1024 },
        remediation: 'Search for something shorter.',
      });
    }

    const kindFilter =
      query.kinds === undefined || query.kinds.length === 0
        ? sql`true`
        : sql`e.kind = ANY(${sql.raw('ARRAY[')}${sql.join(query.kinds.map((k) => sql`${k}`), sql`, `)}${sql.raw(']::text[]')})`;
    const systemFilter =
      query.sourceSystem === undefined ? sql`true` : sql`e.source_system = ${query.sourceSystem}`;

    const entityMatches = sql`
      SELECT ${ENTITY_COLUMNS},
             'entity'::text AS hit_source,
             NULL::uuid AS evidence_id,
             ts_rank(e.search_vector, q.query) AS score,
             ts_headline('english',
                         coalesce(e.attributes->>'name', '') || ' ' ||
                         coalesce(e.attributes->>'path', '') || ' ' ||
                         coalesce(e.attributes->>'message', '') || ' ' ||
                         coalesce(e.attributes->>'shortName', '') || ' ' || e.source_id,
                         q.query,
                         'MaxFragments=1,MaxWords=20,MinWords=5') AS highlight
        FROM ferret.entity e, websearch_to_tsquery('english', ${text}) AS q(query)
       WHERE e.search_vector @@ q.query AND ${kindFilter} AND ${systemFilter}`;

    const evidenceMatches = sql`
      SELECT ${ENTITY_COLUMNS},
             'evidence'::text AS hit_source,
             ev.id AS evidence_id,
             ts_rank(ev.search_vector, q.query) AS score,
             ts_headline('english', coalesce(ev.statement #>> '{}', ''), q.query,
                         'MaxFragments=1,MaxWords=20,MinWords=5') AS highlight
        FROM ferret.evidence ev
        JOIN ferret.entity e ON e.id = ev.subject_id, websearch_to_tsquery('english', ${text}) AS q(query)
       WHERE ev.search_vector @@ q.query AND ${kindFilter} AND ${systemFilter}`;

    // An abbreviated object id — how every person and every tool refers to a
    // commit.
    //
    // Full-text search matches whole lexemes, so `b9559ab` never matches the
    // token `b9559ab55755eee...`: the commit is indexed, findable by its full
    // forty characters, and unreachable by the seven anyone actually has. Found
    // by asking Ferret for the commit at the top of its own history.
    //
    // Seven is Git's own abbreviation floor. The pattern is safe because the
    // test admits only hexadecimal — `%` and `_` are LIKE wildcards, and a
    // pattern built from caller text would otherwise be caller-controlled
    // matching. The value is still a bind parameter; the regex is what makes
    // the *pattern* trustworthy, not the binding.
    const abbreviated = /^[0-9a-f]{7,40}$/i.test(text) ? text.toLowerCase() : undefined;
    const objectIdMatches =
      abbreviated === undefined
        ? undefined
        : sql`
      SELECT ${ENTITY_COLUMNS},
             'entity'::text AS hit_source,
             NULL::uuid AS evidence_id,
             -- Ranked above every ranked hit: an exact identifier prefix is not
             -- a guess about relevance, it is the thing that was asked for.
             1.0::real AS score,
             e.source_id AS highlight
        FROM ferret.entity e
       WHERE (e.source_id LIKE ${`${abbreviated}%`} ESCAPE '\\'
              OR e.attributes->>'sha' LIKE ${`${abbreviated}%`} ESCAPE '\\')
         AND ${kindFilter} AND ${systemFilter}`;

    const textual =
      query.includeEvidence === false ? entityMatches : sql`${entityMatches} UNION ALL ${evidenceMatches}`;
    const body = objectIdMatches === undefined ? textual : sql`${objectIdMatches} UNION ALL ${textual}`;

    try {
      const rows = await this.#db.execute<
        EntityRowShape & { hit_source: string; evidence_id: string | null; score: number; highlight: string | null }
      >(sql`
        SELECT * FROM (
          -- One row per entity per evidence record. A commit found both by its
          -- object id and by its message is one hit with the better score, not
          -- the same commit listed twice.
          SELECT DISTINCT ON (id, evidence_id) *
            FROM (${body}) hits
           ORDER BY id, evidence_id, score DESC
        ) deduped
         ORDER BY score DESC, kind, source_id
         LIMIT ${limit}`);

      const hits: SearchHit[] = [];
      for (const row of rows.rows) {
        const evidence =
          row.evidence_id === null ? undefined : await this.#readEvidence(row.evidence_id);
        hits.push({
          source: row.hit_source === 'evidence' ? HitSource.EVIDENCE : HitSource.ENTITY,
          entity: toEntity(row),
          evidence,
          score: Number(row.score),
          highlight: row.highlight ?? undefined,
        });
      }
      return hits;
    } catch (error) {
      throw classifyDatabaseError(error, 'retrieval.search');
    }
  }

  async #readEvidence(id: string): Promise<CanonicalEvidence | undefined> {
    const rows = await this.#db.execute<{
      id: string;
      subject_id: string;
      field: string | null;
      statement: unknown;
      method: string;
      producer: string;
      producer_version: string;
      source_system: string;
      source_id: string | null;
      source_url: string | null;
      locator: unknown;
      source_content_hash: string | null;
      confidence: string | null;
      completeness: string;
      authority: number;
      observed_at: Date | string | null;
      permission_scope: string | null;
      integrity_hash: string;
      redacted: boolean;
      [column: string]: unknown;
    }>(sql`SELECT * FROM ferret.evidence WHERE id = ${id} LIMIT 1`);

    const row = rows.rows[0];
    if (row === undefined) return undefined;

    return Object.freeze({
      id: row.id,
      subjectId: row.subject_id,
      field: row.field ?? undefined,
      statement: row.statement,
      method: row.method,
      producer: row.producer,
      producerVersion: row.producer_version,
      sourceSystem: row.source_system,
      sourceId: row.source_id ?? undefined,
      sourceUrl: row.source_url ?? undefined,
      locator: row.locator ?? undefined,
      sourceContentHash: row.source_content_hash ?? undefined,
      confidence: row.confidence === null ? undefined : Number(row.confidence),
      completeness: row.completeness,
      authority: row.authority,
      observedAt: instant(row.observed_at),
      // Provenance is a separate table and a separate question; `EvidenceStore`
      // answers it properly. A search hit does not need the chain, and fetching
      // it per hit would make a page of fifty into a hundred round trips.
      derivedFrom: Object.freeze([]),
      permissionScope: row.permission_scope ?? undefined,
      integrityHash: row.integrity_hash,
      redacted: row.redacted,
    }) as CanonicalEvidence;
  }
}
