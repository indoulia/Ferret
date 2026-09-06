import { performance } from 'node:perf_hooks';

import { sql, type SQL } from 'drizzle-orm';

import { Metric, defaultMetrics, type MetricsRegistry } from '../observability/index.js';

import type { CanonicalEntity, CanonicalEvidence } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import {
  Direction,
  HitSource,
  DEFAULT_LIMIT,
  SCOPE_SEPARATOR,
  WithheldTally,
  WithholdReason,
  boundedLimit,
  boundedOffset,
  traverseFrom,
  includedRepositories,
  overfetchLimit,
  rank,
  scopeDescendantPattern,
  visibleEntities,
  withholds,
  type AccessContext,
  type EntityQuery,
  type EntityResult,
  type Neighbour,
  type NeighbourResult,
  type ReferenceCompleteness,
  type RetrievalPort,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type TraversalQuery,
  type TraversalResult,
} from '../retrieval/index.js';

import { CONTEXT_RELATES_TO_CONTEXT, DURABLE_CONTEXT_KIND } from '../context/index.js';

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
/**
 * `ts_rank`'s normalisation flag `32` — EPIC-056 §8.1.
 *
 * Returns `rank / (rank + 1)`, a monotone map onto `[0, 1)`. Order within one
 * query is unchanged by construction; what changes is that the number can be
 * compared between queries, which is the whole of what EPIC-052/053 §4 deferred
 * here.
 *
 * Flag `1` — divide by the logarithm of document length — is deliberately not
 * added. It would rank a long file below a short symbol name for the same term,
 * and a file's body being long is not evidence that the file is less relevant.
 *
 * `sql.raw` because it is a literal in this file and not caller input; a bind
 * parameter here would leave PostgreSQL inferring the type of an argument that
 * selects a function's behaviour.
 */
const RANK_NORMALIZATION = sql.raw('32');

/**
 * A full-text query that matches any term, where that rewrite is provably safe.
 *
 * Extracted so the merger's candidate search (EPIC-126) shares this expression
 * rather than carrying a second copy of it. It is subtle and it has been wrong
 * before — F-65, recorded at the call site above — and Governance §5 is exactly
 * about not having two of it.
 *
 * A shape carrying negation, alternation or grouping keeps the strict query,
 * which narrows what relaxation applies to rather than widening it.
 */
export function relaxedTsQuery(text: string): SQL {
  return sql`(SELECT CASE
                 WHEN strict.query::text ~ '[!|()]' THEN strict.query
                 ELSE replace(strict.query::text, ' & ', ' | ')::tsquery
               END
                 FROM (SELECT websearch_to_tsquery('english', ${text}) AS query) strict)`;
}


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
  // Empty grants dropped here for the same reason `scopeGrants` denies them: a
  // blank entry would become `LIKE ':%'` and grant every scoped row.
  const grants = access.permittedScopes.filter((scope) => scope.length > 0);
  if (grants.length === 0) return sql`${column} IS NULL`;
  // Exact match or a descendant — EPIC-083. The same rule `scopeGrants`
  // implements, and `permission-scope-parity.test.ts` drives both from one table
  // of cases so the SQL and the checker cannot disagree.
  const descendants = sql.join(
    grants.map((scope) => sql`${column} LIKE ${scopeDescendantPattern(scope)}`),
    sql` OR `,
  );
  return sql`(${column} IS NULL OR ${column} = ANY(${sql.raw('ARRAY[')}${sql.join(
    grants.map((scope) => sql`${scope}`),
    sql`, `,
  )}${sql.raw(']::text[]')}) OR ${descendants})`;
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

/**
 * The `hit_source` literal a union branch selected, as the enum.
 *
 * Total over the literals rather than a ternary. The ternary it replaces read
 * `=== 'evidence' ? EVIDENCE : ENTITY`, which silently labelled EPIC-087's
 * content branch an entity hit — and would have done the same to the next one.
 */
function hitSourceOf(literal: string): HitSource {
  switch (literal) {
    case 'evidence':
      return HitSource.EVIDENCE;
    case 'content':
      return HitSource.CONTENT;
    default:
      return HitSource.ENTITY;
  }
}

function abbreviatedObjectId(text: string): string | undefined {
  return /^[0-9a-f]{7,40}$/i.test(text) ? text.toLowerCase() : undefined;
}

/**
 * The edges a reference answer is made of — F-27.
 *
 * Named here rather than imported from `src/code/`: `code_symbol` is a
 * *registered* kind, and storage may not depend on the module that registers it
 * — the boundary `src/code/entity.ts` documents and `boundaries.test.ts`
 * enforces. So the strings are duplicated on purpose, and duplication that
 * cannot be checked is how a constant goes quietly stale: `code-reference-truth`
 * asserts this set equals `{SYMBOL,FILE}_REFERENCES_SYMBOL` as registered, so
 * renaming an edge there fails here rather than silently switching the verdict
 * off.
 *
 * Exported for that test alone, and deliberately **not** added to
 * `storage/index.ts` — a barrel export no production path reaches is the dead
 * control `control-reachability.test.ts` exists to catch.
 */
export const REFERENCE_EDGE_TYPES: ReadonlySet<string> = new Set([
  'symbol_references_symbol',
  'file_references_symbol',
]);

/**
 * Entity kinds that can be an end of a reference edge.
 *
 * `file_references_symbol` and `symbol_references_symbol`, so: a file or a
 * symbol. Nothing else can be short of references, and this is what keeps the
 * verdict off the traversals that are not about them — a commit's neighbours, a
 * branch's, a developer's. Without it an unfiltered query, which is the default
 * every caller takes, paid two extra round trips to be told about a graph it was
 * never asking after.
 */
export const REFERENCE_ENDPOINT_KINDS: ReadonlySet<string> = new Set(['code_symbol', 'file']);

/**
 * Unresolved reasons that could have hidden an edge to a symbol Ferret holds.
 *
 * Everything except `not-found`, and the exclusion is the whole judgement: if no
 * declaration Ferret holds carries the name, the reference cannot have been an
 * edge to one. The other three are refusals over candidates that *do* exist —
 * including `imported`, which is the one it would be easy to wave through, since
 * an import names a symbol the repository very probably declares.
 *
 * A **derived rule needs a control against its own reach** — Batch 6's lesson,
 * bought by stripping `PWD` from every child process. Here the reach is the
 * other way: a new `UnresolvedReason` added later would be silently treated as
 * an absence and quietly shrink the verdict. `code-reference-truth` enumerates
 * `UnresolvedReason` against this set and fails when one appears in neither
 * half, so the next reason is classified deliberately rather than by default.
 */
export const REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'ambiguous',
  'receiver-unknown',
  'imported',
]);

/**
 * Whether this query is asking something a reference verdict answers.
 *
 * Two gates, and both are needed. A type filter that names a reference edge is
 * an explicit ask and settles it. With no filter — the default — the subject's
 * kind decides: only a file or a symbol is an end of a reference edge, so a
 * commit's neighbours get no verdict and pay nothing for it.
 */
function namesReferenceType(types: readonly string[] | undefined): boolean {
  return types !== undefined && types.some((type) => REFERENCE_EDGE_TYPES.has(type));
}

function excludesReferences(types: readonly string[] | undefined): boolean {
  // An empty array is not a filter — `#neighbours` reads it as "every type".
  return types !== undefined && types.length > 0 && !namesReferenceType(types);
}

export class RetrievalStore implements RetrievalPort {
  readonly #db: FerretDatabase;
  /**
   * Where reads are measured — EPIC-092 §8.6.
   *
   * Optional and defaulted, so every existing caller keeps working. Retrieval is
   * instrumented because EPIC-050 §13 makes a claim about query counts that
   * nothing measured.
   */
  readonly #metrics: MetricsRegistry | undefined;

  constructor(db: FerretDatabase, metrics: MetricsRegistry = defaultMetrics()) {
    this.#db = db;
    this.#metrics = metrics;
  }

  /**
   * Exact structured retrieval.
   *
   * Deterministic and unranked. *Which files does this repository contain* has
   * a right answer, and returning a relevance-ordered approximation of it would
   * be worse than returning nothing — a caller cannot tell the difference
   * between "these are the files" and "these are probably the files".
   */
  async findEntities(query: EntityQuery, access: AccessContext): Promise<EntityResult> {
    const limit = boundedLimit(query.limit);
    const offset = boundedOffset(query.offset);

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
      // One more than asked, so "is there another" is answered by the database
      // rather than inferred from the length of a list permission filtering has
      // already shortened. That inference is what reported `truncated: false`
      // over a cut answer.
      //
      // `e.id` last makes the ordering **total**. `(kind, source_id)` is not
      // unique: no constraint says it is, and one kind ties in practice — a
      // `code_symbol`'s source id is the symbol's *name*, so every name declared
      // in two files is a tie, and Ferret's own index holds 178 such groups.
      // PostgreSQL is then free to order tied rows differently between two
      // executions of the same query, which is invisible within one page and
      // corrupting across a boundary: a row that moves between one request and
      // the next is returned twice or skipped entirely. EPIC-118 pages this
      // query, so the tiebreak is what makes "every file in this repository" an
      // answer rather than an approximation.
      const rows = await this.#db.execute<EntityRowShape>(sql`
        SELECT ${ENTITY_COLUMNS}
          FROM ferret.entity e
         WHERE ${sql.join(conditions, sql` AND `)}
         ORDER BY e.kind, e.source_id, e.id
         LIMIT ${limit + 1} OFFSET ${offset}
      `);
      const more = rows.rows.length > limit;
      const tally = new WithheldTally();
      const entities = visibleEntities(
        rows.rows.slice(0, limit).map(toEntity),
        (entity) => entity,
        access,
        tally,
      );
      return { entities, withheld: tally.report, more };
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
  async neighbours(query: TraversalQuery, access: AccessContext): Promise<NeighbourResult> {
    // The public one-hop read, and it now carries what it drops. The tally used
    // to be constructed here and discarded, so a caller at depth 1 — the
    // default, and every existing caller — learned neither that rows had been
    // withheld nor that the bound had cut the hop.
    const tally = new WithheldTally();
    const page = await this.#neighbours(query, access, tally);
    // F-27. `truncated: false` and `withheld: 0` over a reference query was an
    // affirmative claim of completeness across a graph Ferret had refused to
    // finish resolving. Only asked when the query could return a reference edge,
    // so the common traversal pays nothing.
    const references = await this.#referenceCompleteness(query, access);
    return {
      neighbours: page.neighbours,
      withheld: tally.report,
      more: page.more,
      ...(references === undefined ? {} : { references }),
    };
  }

  /**
   * How much of the reference graph in this subject's repository resolved — F-27.
   *
   * Reads the counts EPIC-035 §12 persists on each `file` entity and aggregates
   * them over the subject's repository. Per-file is where they live and it is the
   * only place they *can* live: an unresolved reference has no target by
   * definition, so it cannot be attributed to the symbol whose inbound list is
   * being asked for. The honest scope is therefore "the repository this answer
   * came from", and the honest statement is that any of those refusals could
   * have been an edge here.
   *
   * Under the caller's scope grants, so a caller restricted to one repository is
   * not told how much of another failed to resolve.
   */
  async #referenceCompleteness(
    query: TraversalQuery,
    access: AccessContext,
  ): Promise<ReferenceCompleteness | undefined> {
    // A type filter that names no reference edge settles it without touching the
    // database at all — the cheapest gate, and the one most queries take.
    if (excludesReferences(query.types)) return undefined;

    const subject = await this.#subjectScopeOf(query.from);
    if (subject === undefined) return undefined;
    // With no filter the subject's kind decides. Only a file or a symbol is an
    // end of a reference edge, so a commit's neighbours are not asked after one.
    // An explicit ask is honoured whatever the subject is: the caller named the
    // edge type, and answering "no verdict" to that would be its own small lie.
    if (!namesReferenceType(query.types) && !REFERENCE_ENDPOINT_KINDS.has(subject.kind)) {
      return undefined;
    }
    const root = subject.root;

    const rows = await this.#db.execute<{
      files: number | string;
      extracted: number | string | null;
      resolved: number | string | null;
      by_reason: Record<string, number | string> | null;
    }>(sql`
      WITH measured AS (
        SELECT e.attributes->'referenceResolution' AS resolution
          FROM ferret.entity e
         WHERE e.kind = 'file'
           AND (e.source_scope = ${root} OR e.source_scope LIKE ${scopeDescendantPattern(root)})
           AND e.attributes->'referenceResolution' IS NOT NULL
           AND ${scopePredicate(access)}
      )
      SELECT
        (SELECT count(*) FROM measured) AS files,
        (SELECT coalesce(sum((resolution->>'extracted')::bigint), 0) FROM measured) AS extracted,
        (SELECT coalesce(sum((resolution->>'resolved')::bigint), 0) FROM measured) AS resolved,
        (SELECT coalesce(jsonb_object_agg(reason, tally), '{}'::jsonb)
           FROM (SELECT pair.key AS reason, sum(pair.value::bigint) AS tally
                   FROM measured,
                        LATERAL jsonb_each_text(coalesce(resolution->'unresolved', '{}'::jsonb)) AS pair
                  GROUP BY pair.key) reasons) AS by_reason
    `);

    const row = rows.rows[0];
    if (row === undefined) return undefined;

    const filesMeasured = Number(row.files ?? 0);
    const byReason: Record<string, number> = {};
    let total = 0;
    let refused = 0;
    // Sorted, so two reads of the same index compare equal — the idiom
    // `WithheldTally` already sets for the same reason.
    for (const reason of Object.keys(row.by_reason ?? {}).sort()) {
      const count = Number((row.by_reason ?? {})[reason] ?? 0);
      if (count <= 0) continue;
      byReason[reason] = count;
      total += count;
      if (REFUSAL_REASONS.has(reason)) refused += count;
    }

    return Object.freeze({
      // Zero measured files is `unknown`, not `complete`: an index built before
      // F-27, or one whose content stage never ran, has earned no verdict.
      completeness: filesMeasured === 0 ? 'unknown' : refused > 0 ? 'incomplete' : 'complete',
      extracted: Number(row.extracted ?? 0),
      resolved: Number(row.resolved ?? 0),
      unresolved: Object.freeze({ total, refused, byReason: Object.freeze(byReason) }),
      filesMeasured,
    } satisfies ReferenceCompleteness);
  }

  /**
   * What an entity is, and which repository it belongs to.
   *
   * One row for both, because both gates need it and two lookups for one row
   * would be the round trip this narrowing exists to save.
   *
   * A `file`'s `source_scope` *is* the repository id; a `code_symbol`'s is
   * `` `${repositoryScope}:${path}` `` (`symbolScope`, EPIC-034), so the first
   * segment is the repository either way. An entity with no scope is its own —
   * a repository is the case that matters.
   */
  async #subjectScopeOf(id: string): Promise<{ kind: string; root: string } | undefined> {
    const rows = await this.#db.execute<{ kind: string; source_scope: string | null }>(
      sql`SELECT kind, source_scope FROM ferret.entity WHERE id = ${id} LIMIT 1`,
    );
    const row = rows.rows[0];
    if (row === undefined) return undefined;
    if (row.source_scope === null) return { kind: row.kind, root: id };
    const [root] = row.source_scope.split(SCOPE_SEPARATOR);
    if (root === undefined || root.length === 0) return undefined;
    return { kind: row.kind, root };
  }

  async #neighbours(
    query: TraversalQuery,
    access: AccessContext,
    tally: WithheldTally,
  ): Promise<{ neighbours: readonly Neighbour[]; more: boolean }> {
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
        // One more than the bound, so the cut is a fact rather than an
        // inference. The limit is applied here in SQL and the walk counts rows
        // in TypeScript, so without this a frontier node whose neighbours were
        // cut in the database was indistinguishable from one that had no more.
        sql`SELECT * FROM (${body}) neighbours ORDER BY rel_type, valid_from DESC, source_id LIMIT ${limit + 1}`,
      );

      const more = rows.rows.length > limit;
      const reached = rows.rows.slice(0, limit).map((row) => ({
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
      return {
        neighbours: visibleEntities(reached, (neighbour) => neighbour.entity, access, tally),
        more,
      };
    } catch (error) {
      throw classifyDatabaseError(error, 'retrieval.neighbours');
    }
  }


  /**
   * Multi-hop traversal — EPIC-050.
   *
   * EPIC-007's validation recorded five limitations and every one of them is
   * here: traversal was one hop, so "which release contains the fix for FER-12"
   * had to be walked by the caller, with its own visited set and its own depth
   * bound and no way to be told a path existed but was truncated.
   *
   * **An iterative frontier, not a recursive CTE, and that is a security
   * decision rather than a style one.** `neighbours` filters twice: in SQL
   * through `scopePredicate`, and in TypeScript through `visibleEntities` for
   * the dimensions SQL cannot express — worktree, session and glob path
   * exclusion. A CTE can carry the first and not the second, so a walk would
   * expand *through* a node the caller may not see and return what lies beyond
   * it. That is a caller learning a relationship exists by receiving its far
   * end. One level at a time, each filtered by both before it is expanded, is
   * the only shape that closes it — and it is the shape
   * `EvidenceStore.provenanceOf` already uses.
   *
   * Breadth-first, so `depth` means what a reader expects and the first path
   * found is a shortest one. Cycle protection is a **visited set**, not a path
   * check: the graph is walked, not the set of walks, so `A → B → A` yields `B`
   * once and stops. Ferret's edges are genuinely cyclic — merge commits through
   * `commit_parent_of_commit`, a rename undone through
   * `entity_supersedes_entity` — and EPIC-007 made cycle protection a
   * precondition of this Epic existing.
   */
  async traverse(query: TraversalQuery, access: AccessContext): Promise<TraversalResult> {
    // EPIC-092 §8.6. EPIC-050 §13 claims "one indexed lookup per frontier node"
    // and nothing measured it; `traverse_hops` is that claim as a number.
    const startedAt = performance.now();
    let hops = 0;
    // The walk itself is core and pure — `retrieval/traverse.ts` — and it takes
    // the one-hop read as a function. That is the security property rather than
    // a testing convenience: every hop is filtered by `#neighbours`, which
    // carries both the SQL predicate and the TypeScript one, so nothing is
    // reachable transitively that is not reachable directly. EPIC-050 §8.3.
    const tally = new WithheldTally();
    const result = await traverseFrom(
      async (from, limit) => {
        hops += 1;
        return this.#neighbours({ ...query, from, limit }, access, tally);
      },
      {
        from: query.from,
        ...(query.depth === undefined ? {} : { depth: query.depth }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      },
    );
    this.#metrics?.observe(Metric.RETRIEVAL_TRAVERSE_MS, performance.now() - startedAt);
    this.#metrics?.observe(Metric.RETRIEVAL_TRAVERSE_HOPS, hops);
    // The tally is filled by the hops above, so it can only be read once they
    // have run — which is why it is attached here rather than passed in.
    //
    // F-27, and it bites harder here than at one hop: an unresolved reference at
    // hop 1 also removes everything reachable only through it.
    const references = await this.#referenceCompleteness(query, access);
    return {
      ...result,
      withheld: tally.report,
      ...(references === undefined ? {} : { references }),
    };
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
    const startedAt = performance.now();
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
    // F-65. This was an unconditional `replace(… , ' & ', ' | ')` over the
    // *rendered* tsquery, which is string surgery on an expression tree and
    // inverts the one operator that must not move: `'a' & !'b'` became
    // `'a' | !'b'`, so a relaxed search returned documents selected **because**
    // they lacked the excluded term. Measured when the finding was raised:
    // strict 0 rows, relaxed 3 775 of 3 777, every one scoring 0 — a search that
    // answered "nothing matched" by returning almost the whole corpus.
    //
    // Splitting the rendered text on ' & ' and reassembling would fix the
    // negation and break something else: `websearch_to_tsquery` emits
    // parenthesised groups for an `or`, so `'a' | ('b' & 'c')` splits into
    // fragments that are not valid queries. Rather than parse a tsquery in SQL,
    // relaxation now applies only where the plain rewrite is provably safe — a
    // flat conjunction, with no negation, no alternation and no grouping. Any
    // other shape keeps the strict query.
    //
    // That narrows relaxation rather than widening it, which is the correct
    // direction for this defect: the failure being fixed is a search that
    // matched too much, for the wrong reason, and said nothing about it.
    const tsquery =
      query.relax === true
        ? sql`${relaxedTsQuery(text)} AS q(query)`
        : sql`(SELECT websearch_to_tsquery('english', ${text})) AS q(query)`;

    const entityMatches = sql`
      SELECT ${ENTITY_COLUMNS},
             'entity'::text AS hit_source,
             NULL::uuid AS evidence_id,
             NULL::integer AS evidence_authority,
             ts_rank(e.search_vector, q.query, ${RANK_NORMALIZATION}) AS score,
             -- The same text migration 0007's generated column indexes, field
             -- for field.
             --
             -- DEFECT: it used to be a shorter list, so a hit could match on
             -- text the headline never saw and come back with nothing marked.
             -- Searching connection reached src/connection-pool.ts through
             -- 0007's translate of the path separators, which the headline did
             -- not apply, so it marked nothing. Found when ranking changed
             -- which row of an entity is the one shown (EPIC-056 §8.5); the
             -- mismatch predates it and was passing on the luck of which row
             -- sorted first.
             ts_headline('english',
                         coalesce(e.attributes->>'name', '') || ' ' ||
                         coalesce(e.attributes->>'description', '') || ' ' ||
                         coalesce(e.attributes->>'path', '') || ' ' ||
                         translate(coalesce(e.attributes->>'path', ''), '/-_.', '    ') || ' ' ||
                         coalesce(e.attributes->>'message', '') || ' ' ||
                         coalesce(e.attributes->>'shortName', '') || ' ' ||
                         coalesce(e.attributes->>'ref', '') || ' ' ||
                         coalesce(e.attributes->>'title', '') || ' ' || e.source_id,
                         q.query,
                         'MaxFragments=1,MaxWords=20,MinWords=5') AS highlight
        FROM ferret.entity e, ${tsquery}
       WHERE e.search_vector @@ q.query AND ${kindFilter} AND ${systemFilter}
         AND ${scopePredicate(access)}`;

    const evidenceMatches = sql`
      SELECT ${ENTITY_COLUMNS},
             'evidence'::text AS hit_source,
             ev.id AS evidence_id,
             -- EPIC-057 §5. The ordering needs the authority rank, and the
             -- ranked path deliberately does not read the evidence record
             -- until it knows which hits survive — overfetching would
             -- otherwise multiply round trips for objects nobody sees.
             ev.authority AS evidence_authority,
             ts_rank(ev.search_vector, q.query, ${RANK_NORMALIZATION}) AS score,
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
    // EPIC-087 — the branch that reaches a term appearing only inside a file.
    //
    // **Two joins, and the second one is not decoration.** A blob is addressed
    // by hash, so the first join reaches the `file_version` that carries it —
    // but a `file_version` is a blob at a path, and it is not what anyone
    // searching for `authenticate` is looking for. The hit is the `file`, which
    // is the entity a developer names by hand and the one EPIC-096's labels are
    // written against. Measured: resolving to the version instead left
    // `text-authentication` at recall 0.00 with content indexed and searchable,
    // because the label expects a file and retrieval offered a version of one.
    //
    // The second join is also what makes the permission filter correct. A
    // `file_version`'s `source_scope` is its *file*; a `file`'s is its
    // repository, which is what `includedRepositories` compares against. So
    // filtering the version would have compared a file id to a repository id and
    // excluded everything — a leak's mirror image, and just as wrong.
    //
    // The direction matters for the same reason #87 did. A blob is shared by
    // definition: the same bytes at two paths are one row, and if those paths
    // are in two repositories, ranking on `content_blob` alone would answer a
    // query with source the caller cannot list. The blob supplies rank and
    // highlight only; the row that comes back is an entity that passed
    // `scopePredicate`, exactly as in every other branch.
    //
    // The `file_version` kind predicate is spelled out rather than left to
    // `kindFilter` — the latter is the caller's filter, may be absent, and
    // applies to the *file* — and migration 0011's partial index is on it.
    const contentMatches = sql`
      SELECT ${ENTITY_COLUMNS},
             'content'::text AS hit_source,
             NULL::uuid AS evidence_id,
             NULL::integer AS evidence_authority,
             ts_rank(cb.search_vector, q.query, ${RANK_NORMALIZATION}) AS score,
             ts_headline('english', coalesce(cb.text_content, ''), q.query,
                         'MaxFragments=1,MaxWords=20,MinWords=5') AS highlight
        FROM ferret.content_blob cb
        JOIN ferret.entity fv
          ON fv.kind = 'file_version'
         AND fv.attributes->>'contentHash' = cb.content_hash
        JOIN ferret.entity e
          ON e.id::text = fv.source_scope
         AND e.kind = 'file', ${tsquery}
       WHERE cb.search_vector @@ q.query AND ${kindFilter} AND ${systemFilter}
         AND ${scopePredicate(access)}`;

    const abbreviated = abbreviatedObjectId(text);
    const objectIdMatches =
      abbreviated === undefined
        ? undefined
        : sql`
      SELECT ${ENTITY_COLUMNS},
             'entity'::text AS hit_source,
             NULL::uuid AS evidence_id,
             NULL::integer AS evidence_authority,
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
    // Content joins the union unconditionally. There is no `includeContent`
    // flag: `includeEvidence` exists because an evidence hit returns a second
    // object the caller may not want to pay for, and a content hit returns the
    // same `file_version` entity every other branch does.
    const withContent = sql`${textual} UNION ALL ${contentMatches}`;
    const body = objectIdMatches === undefined ? withContent : sql`${objectIdMatches} UNION ALL ${withContent}`;

    try {
      const rows = await this.#db.execute<
        EntityRowShape & {
          hit_source: string;
          evidence_id: string | null;
          evidence_authority: number | null;
          score: number;
          highlight: string | null;
        }
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
         -- More candidates than the caller asked for — EPIC-056 §8.7. Ranking
         -- can only change an answer if the pool is larger than the answer;
         -- with exactly limit rows the best a reranker could do is reorder a
         -- page this ORDER BY had already chosen. Bounded by MAX_LIMIT.
         LIMIT ${overfetchLimit(limit)}`);

      const tally = new WithheldTally();
      // Evidence is *not* read here. Overfetching multiplied this loop, and the
      // rows that do not survive ranking would have been a round trip each for
      // an object nobody sees. The id is carried instead and resolved below for
      // the hits that are actually returned.
      const candidates = rows.rows.map((row) => ({
        source: hitSourceOf(row.hit_source),
        entity: toEntity(row),
        evidence: undefined,
        score: Number(row.score),
        highlight: row.highlight ?? undefined,
        evidenceId: row.evidence_id,
        // EPIC-057. `undefined` rather than `0`: an absent rank is unassessed,
        // and `effectiveAuthority` is what keeps that distinct from weakest.
        authority: row.evidence_authority ?? undefined,
      }));

      // The scope and exclusion dimensions SQL cannot express — worktree,
      // session, and glob path exclusion — plus the count of what went.
      //
      // Before ranking, and that order matters: a hit withheld here must not
      // occupy one of the `limit` places, and a constituent must not be folded
      // into a container the caller cannot see.
      const permitted = visibleEntities(candidates, (hit) => hit.entity, access, tally);
      // EPIC-130. What the merger already knows about which of these say the
      // same thing. After the permission filter, so a cluster is never formed
      // through a record the caller may not see.
      const equivalence = await this.#equivalenceOf(permitted.map((hit) => hit.entity));
      const clustered = permitted.map((hit) => {
        const key = equivalence.get(hit.entity.id);
        return key === undefined ? hit : { ...hit, equivalenceKey: key };
      });

      const visible: SearchHit[] = [];
      for (const { evidenceId, authority: _authority, ...hit } of rank(clustered, limit)) {
        visible.push({
          ...hit,
          evidence: evidenceId === null ? undefined : await this.#readEvidence(evidenceId),
        });
      }
      tally.add(WithholdReason.PERMISSION, await this.#countProtected(query, access));
      this.#metrics?.observe(Metric.RETRIEVAL_SEARCH_MS, performance.now() - startedAt);
      return { hits: visible, withheld: tally.report };
    } catch (error) {
      throw classifyDatabaseError(error, 'retrieval.search');
    }
  }

  /**
   * Which of these hits the merger recorded as restatements of one another —
   * EPIC-130.
   *
   * One query over the candidate pool, never over the corpus: the edges are
   * read *between the ids already retrieved*, so the cost is bounded by the
   * page and does not grow with what Ferret holds.
   *
   * The cluster's key is its lowest member id — deterministic, needs no tuning,
   * and is only an identity for the group. Which member *survives* is
   * `rank`'s decision, made with the same ordering the answer is sorted by.
   *
   * Only `context_relates_to_context`. A contradiction is emphatically not an
   * equivalence: two records that disagree are two answers, and folding one
   * into the other would be Ferret picking a winner it has already said it
   * cannot pick.
   */
  async #equivalenceOf(entities: readonly CanonicalEntity[]): Promise<ReadonlyMap<string, string>> {
    const ids = entities.filter((one) => one.kind === DURABLE_CONTEXT_KIND).map((one) => one.id);
    if (ids.length < 2) return new Map();

    const rows = await this.#db.execute<{ [column: string]: unknown; from_id: string; to_id: string }>(sql`
      SELECT from_id, to_id FROM ferret.relationship
       WHERE type = ${CONTEXT_RELATES_TO_CONTEXT}
         AND valid_to IS NULL
         AND from_id::text = ANY(${sql.raw('ARRAY[')}${sql.join(ids.map((id) => sql`${id}`), sql`, `)}${sql.raw(']::text[]')})
         AND to_id::text = ANY(${sql.raw('ARRAY[')}${sql.join(ids.map((id) => sql`${id}`), sql`, `)}${sql.raw(']::text[]')})
    `);

    // Union-find over the pool. A restatement of a restatement is one cluster,
    // which is what a reader means by "these all say the same thing".
    const parent = new Map<string, string>(ids.map((id) => [id, id]));
    const find = (id: string): string => {
      let root = id;
      while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
      let walk = id;
      while (walk !== root) {
        const next = parent.get(walk) ?? walk;
        parent.set(walk, root);
        walk = next;
      }
      return root;
    };
    for (const row of rows.rows) {
      const left = find(row.from_id);
      const right = find(row.to_id);
      if (left === right) continue;
      // Lowest id wins, so the key is the same whichever order the edges arrive.
      if (left < right) parent.set(right, left);
      else parent.set(left, right);
    }

    const clustered = new Map<string, string>();
    const sized = new Map<string, number>();
    for (const id of ids) sized.set(find(id), (sized.get(find(id)) ?? 0) + 1);
    for (const id of ids) {
      const root = find(id);
      // A cluster of one is not a cluster; keying it would fold nothing and
      // report an equivalence nobody asserted.
      if ((sized.get(root) ?? 0) > 1) clustered.set(id, root);
    }
    return clustered;
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
