import { sql, type SQL } from 'drizzle-orm';

import type { CanonicalEntity, CanonicalEvidence } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import {
  Direction,
  HitSource,
  DEFAULT_LIMIT,
  WithheldTally,
  WithholdReason,
  boundedLimit,
  includedRepositories,
  visibleEntities,
  withholds,
  type AccessContext,
  type EntityQuery,
  type Neighbour,
  type RetrievalPort,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
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

/**
 * An abbreviated Git object id, or `undefined` if the text is not one.
 *
 * Seven is Git's own abbreviation floor; forty is a full SHA-1. Admitting only
 * hexadecimal is what makes the resulting `LIKE` pattern safe: `%` and `_` are
 * wildcards, so a pattern built from arbitrary caller text would be
 * caller-controlled matching. The value is still bound as a parameter — the
 * test is what makes the *pattern* trustworthy, not the binding.
 */
/**
 * The permission predicate, as SQL — EPIC-058 AC-5.
 *
 * A `WHERE` clause rather than a filter after assembly, because Governance §12
 * says authorization is evaluated *before* protected information enters a
 * result. A protected row is therefore never read: it cannot leak through a
 * highlight, a log line, an error message or a half-built hit.
 *
 * Unscoped rows are visible to everyone — everything Ferret indexes today is
 * unscoped, and a default that hid it would be a different product rather than a
 * safer one. Scoped rows require the token, which makes a provider that sets one
 * protected from the moment it does.
 */
function permissionPredicate(column: SQL, access: AccessContext): SQL {
  if (access.permittedScopes.length === 0) return sql`${column} IS NULL`;
  return sql`(${column} IS NULL OR ${column} = ANY(${sql.raw('ARRAY[')}${sql.join(
    access.permittedScopes.map((scope) => sql`${scope}`),
    sql`, `,
  )}${sql.raw(']::text[]')}))`;
}

/**
 * The repository-scope predicate, as SQL.
 *
 * Only the *inclusion* half is expressible here, and only for repositories: an
 * empty `include` means everything (EPIC-009's documented default), and
 * exclusion plus the worktree and session dimensions are evaluated by EPIC-009's
 * own evaluator in the core, so include/exclude precedence stays that model's
 * rule rather than becoming a second copy of it in SQL.
 *
 * Narrowing here as well as in the core is not redundancy — it keeps a caller
 * restricted to one repository from paging through another repository's rows and
 * discarding them, which would turn a `LIMIT 50` into fifty withheld hits and an
 * empty answer.
 */
function scopePredicate(access: AccessContext): SQL {
  const repositories = includedRepositories(access);
  if (repositories.length === 0) return sql`true`;
  return sql`(e.source_scope IS NULL OR e.source_scope = ANY(${sql.raw('ARRAY[')}${sql.join(
    repositories.map((scope) => sql`${scope}`),
    sql`, `,
  )}${sql.raw(']::text[]')}))`;
}

function abbreviatedObjectId(text: string): string | undefined {
  return /^[0-9a-f]{7,40}$/i.test(text) ? text.toLowerCase() : undefined;
}

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
  async findEntities(query: EntityQuery, access: AccessContext): Promise<readonly CanonicalEntity[]> {
    const limit = boundedLimit(query.limit);
    const offset = query.offset ?? 0;

    // EPIC-058. The scope predicate is first so it reads as the gate it is
    // rather than as one filter among several.
    const conditions = [scopePredicate(access)];
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
      return visibleEntities(rows.rows.map(toEntity), (entity) => entity, access, new WithheldTally());
    } catch (error) {
      throw classifyDatabaseError(error, 'retrieval.findEntities');
    }
  }

  /**
   * Entities a caller named rather than described — EPIC-055's exact strategy.
   *
   * An object id prefix, a path, or a Ferret entity id. All three have a single
   * right answer, so the result is unranked and every hit carries the same
   * score: ordering by relevance would imply a judgement that was never made.
   *
   * The planner decides *when* this runs. This decides only what an identifier
   * matches, which is why the three shapes are handled together — a caller who
   * pasted something has not told Ferret which kind of thing it is.
   */
  async byIdentifier(term: string, access: AccessContext, limit = DEFAULT_LIMIT): Promise<readonly SearchHit[]> {
    const bounded = boundedLimit(limit);
    const abbreviated = abbreviatedObjectId(term);

    // A path is compared exactly rather than by prefix. `src/` would otherwise
    // match every file beneath it and turn a key into a directory listing,
    // which is a different question with a different answer.
    const conditions = [
      sql`e.id::text = ${term}`,
      sql`e.attributes->>'path' = ${term}`,
      ...(abbreviated === undefined
        ? []
        : [
            sql`e.source_id LIKE ${`${abbreviated}%`}`,
            sql`e.attributes->>'sha' LIKE ${`${abbreviated}%`}`,
          ]),
    ];

    try {
      const rows = await this.#db.execute<EntityRowShape>(sql`
        SELECT ${ENTITY_COLUMNS}
          FROM ferret.entity e
         WHERE (${sql.join(conditions, sql` OR `)}) AND ${scopePredicate(access)}
         ORDER BY e.kind, e.source_id
         LIMIT ${bounded}
      `);

      const identified = rows.rows.map((row) => ({
        source: HitSource.ENTITY,
        entity: toEntity(row),
        evidence: undefined,
        // Identical across the result set, deliberately. These matched a key;
        // none of them is a better match than another.
        score: 1,
        highlight: row.source_id,
      }));
      return visibleEntities(identified, (hit) => hit.entity, access, new WithheldTally());
    } catch (error) {
      throw classifyDatabaseError(error, 'retrieval.byIdentifier');
    }
  }

  async getEntity(id: string, access: AccessContext): Promise<CanonicalEntity | undefined> {
    try {
      const rows = await this.#db.execute<EntityRowShape>(sql`
        SELECT ${ENTITY_COLUMNS} FROM ferret.entity e
         WHERE e.id = ${id} AND ${scopePredicate(access)} LIMIT 1
      `);
      const row = rows.rows[0];
      if (row === undefined) return undefined;
      // Withheld and absent are the same answer here, deliberately. `undefined`
      // for "you may not see it" and `undefined` for "it does not exist" is what
      // stops an exact lookup being used to probe for the existence of something
      // protected.
      if (withholds(access, toEntity(row)) !== undefined) return undefined;

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
  async neighbours(query: TraversalQuery, access: AccessContext): Promise<readonly Neighbour[]> {
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
       WHERE r.from_id = ${query.from} AND ${typeFilter} AND ${temporal} AND ${scopePredicate(access)}`;

    const inward = sql`
      SELECT ${ENTITY_COLUMNS}, r.type AS rel_type, 'in' AS rel_direction, r.valid_from, r.valid_to, r.metadata AS rel_metadata
        FROM ferret.relationship r
        JOIN ferret.entity e ON e.id = r.from_id
       WHERE r.to_id = ${query.from} AND ${typeFilter} AND ${temporal} AND ${scopePredicate(access)}`;

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

      const reached = rows.rows.map((row) => ({
        entity: toEntity(row),
        relationshipType: row.rel_type,
        direction: row.rel_direction,
        validFrom: instant(row.valid_from) ?? new Date(0).toISOString(),
        validTo: instant(row.valid_to) ?? null,
        metadata: row.rel_metadata ?? {},
      }));
      // EPIC-049 states the relationship table has no `permission_scope` and did
      // not add one, so an edge is as visible as the entity it reaches. Filtering
      // on the reached entity is therefore the whole control available, and §4 of
      // this Epic's specification declines to add the column.
      return visibleEntities(reached, (neighbour) => neighbour.entity, access, new WithheldTally());
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
  async search(query: SearchQuery, access: AccessContext): Promise<SearchResult> {
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

    // Relaxing turns AND into OR, and does it by rewriting a tsquery PostgreSQL
    // itself produced rather than by building one from the caller's text. The
    // input has already been through `websearch_to_tsquery`, so the value being
    // rewritten contains only lexemes and operators the parser emitted —
    // assembling a `to_tsquery` string from raw input would be injection into a
    // query language, and `to_tsquery` additionally throws on malformed input,
    // which a search box can be made to do with one stray parenthesis.
    //
    // Ranking still favours documents matching more terms, so the strict answer
    // stays on top when it exists.
    //
    // Wrapped in a subselect because only a function call may stand alone in a
    // `FROM` clause; `replace(...)::tsquery` is a scalar expression and needs a
    // select around it. Both branches take the same shape so the two call sites
    // below do not have to know which one they were given.
    const tsquery =
      query.relax === true
        ? sql`(SELECT replace(websearch_to_tsquery('english', ${text})::text, ' & ', ' | ')::tsquery) AS q(query)`
        : sql`(SELECT websearch_to_tsquery('english', ${text})) AS q(query)`;

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
        FROM ferret.entity e, ${tsquery}
       WHERE e.search_vector @@ q.query AND ${kindFilter} AND ${systemFilter}
         AND ${scopePredicate(access)}`;

    const evidenceMatches = sql`
      SELECT ${ENTITY_COLUMNS},
             'evidence'::text AS hit_source,
             ev.id AS evidence_id,
             ts_rank(ev.search_vector, q.query) AS score,
             ts_headline('english', coalesce(ev.statement #>> '{}', ''), q.query,
                         'MaxFragments=1,MaxWords=20,MinWords=5') AS highlight
        FROM ferret.evidence ev
        JOIN ferret.entity e ON e.id = ev.subject_id, ${tsquery}
       WHERE ev.search_vector @@ q.query AND ${kindFilter} AND ${systemFilter}
         AND ${scopePredicate(access)}
         -- EPIC-058 AC-2, and the leak this Epic exists to close. Full-text
         -- search covers evidence statements, and this branch used to select
         -- permission_scope onto the hit and never consult it, so a protected
         -- observation's content was matched by a query and returned verbatim.
         AND ${permissionPredicate(sql`ev.permission_scope`, access)}`;

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
    const abbreviated = abbreviatedObjectId(text);
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
       WHERE (e.source_id LIKE ${`${abbreviated}%`}
              OR e.attributes->>'sha' LIKE ${`${abbreviated}%`})
         AND ${kindFilter} AND ${systemFilter} AND ${scopePredicate(access)}`;

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

      const tally = new WithheldTally();
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

      // The scope and exclusion dimensions SQL cannot express — worktree,
      // session, and glob path exclusion — plus the count of what went.
      const visible = visibleEntities(hits, (hit) => hit.entity, access, tally);
      tally.add(WithholdReason.PERMISSION, await this.#countProtected(query, access));
      return { hits: visible, withheld: tally.report };
    } catch (error) {
      throw classifyDatabaseError(error, 'retrieval.search');
    }
  }

  /**
   * How many evidence matches the caller may not see — EPIC-058 AC-10.
   *
   * A separate query, and one that selects **no content**: `count(*)` over the
   * same text predicate with the permission predicate negated. So the answer is
   * exact and no protected statement, path or attribute is ever read — which is
   * the property AC-5 is about, and a windowed count over the main query would
   * have broken it to save a round trip.
   *
   * Skipped entirely when nothing could be protected, which is the common case:
   * a caller holding no scope only needs this if scoped rows exist at all, and
   * the `evidence_permission_idx` partial scan answers that cheaply.
   *
   * The count is a deliberate, bounded disclosure — it says an answer is short
   * without saying what is missing. Specification §16 records that this is a
   * decision rather than a finding.
   */
  async #countProtected(query: SearchQuery, access: AccessContext): Promise<number> {
    if (query.includeEvidence === false) return 0;
    const text = query.text.trim();
    if (text.length === 0) return 0;

    try {
      const rows = await this.#db.execute<{ withheld: string | number }>(sql`
        SELECT count(*) AS withheld
          FROM ferret.evidence ev
          JOIN ferret.entity e ON e.id = ev.subject_id,
               websearch_to_tsquery('english', ${text}) AS q(query)
         WHERE ev.search_vector @@ q.query
           AND ev.permission_scope IS NOT NULL
           AND NOT ${permissionPredicate(sql`ev.permission_scope`, access)}`);
      return Number(rows.rows[0]?.withheld ?? 0);
    } catch (error) {
      throw classifyDatabaseError(error, 'retrieval.search.withheld');
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
