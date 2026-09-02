import { and, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';

import {
  EvidenceState,
  createEvidence,
  detectConflicts,
  integrityHashOf,
  stableStringify,
  type CanonicalEvidence,
  type Completeness,
  type ConflictGroup,
  type EvidenceInput,
  type EvidenceLocator,
  type EvidenceMethod,
  type StatedEvidence,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import { scopeDescendantPattern, scopeGrants } from '../retrieval/access.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';
import { evidence, evidenceDerivation, type EvidenceRow } from './schema/evidence.js';

/**
 * Persisting evidence.
 *
 * **Append-only in content.** `record()` never updates the observation half of a
 * row; a re-observation of the same fact resolves to the same id and is a no-op
 * beyond noting that Ferret looked again. What may change is Ferret's
 * interpretation — `state`, and the pointer to whatever superseded it.
 *
 * That is not a stylistic preference. Governance §6 forbids silently rewriting
 * source evidence, and a store that can update an observation cannot promise it.
 */

export interface RecordedEvidence {
  readonly evidence: CanonicalEvidence;
  readonly state: EvidenceState;
  readonly recordedAt: string;
  readonly supersededBy: string | undefined;
  /** True when this observation was already on record. */
  readonly deduplicated: boolean;
}

/**
 * Which permission scopes a read is performed under — EPIC-058.
 *
 * Optional here rather than required, and the distinction is the one
 * `Checkpoints/EPIC-008.md:112` draws: "an internal caller omitting it is
 * correct, a retrieval caller omitting it is a leak." The indexer and the
 * reconciler read this store directly and must see everything they wrote.
 *
 * The *retrieval path* reaches evidence through `EvidenceReader`, where the
 * context is a required parameter — EPIC-083 AC-1, after EPIC-058 required it in
 * prose and #85 and #87 both omitted it anyway. An internal caller that means
 * unrestricted says {@link UNRESTRICTED_READ} rather than passing nothing.
 */
export interface ScopedRead {
  readonly permittedScopes?: readonly string[];
}

/**
 * The one legitimate unrestricted read, said out loud — EPIC-083 AC-2.
 *
 * The indexer, the reconciler and an integrity sweep read back what Ferret itself
 * wrote, and must see all of it. That is a real requirement and this Epic does not
 * remove it; what it removes is the ability to *arrive* at it by omission.
 *
 * EPIC-058 refused an `UNRESTRICTED_ACCESS` on the retrieval side and was right —
 * there, unrestricted is the opt-out the Epic exists to close. Here it is the
 * correct answer for a caller that is not acting for anyone, so it gets a name a
 * reviewer can grep for rather than an empty options object that looks like
 * someone forgot. The difference between an audited decision and a forgotten one
 * is whether it is written down.
 */
export const UNRESTRICTED_READ: ScopedRead = Object.freeze({ permittedScopes: undefined });

export interface EvidenceQuery {
  readonly field?: string;
  readonly state?: EvidenceState;
  /**
   * Permission scopes the caller may see.
   *
   * Omitted means unrestricted, which is correct for internal callers and wrong
   * for a query on behalf of a user. EPIC-058 makes supplying it mandatory on
   * the retrieval path; here the parameter exists so evidence can be filtered at
   * the point it is read rather than after it has been assembled into an answer.
   */
  readonly permittedScopes?: readonly string[];
  readonly limit?: number;
}

/**
 * The permission predicate for a read — EPIC-058.
 *
 * `undefined` scopes means unrestricted, which is right for the indexer reading
 * back what it wrote and wrong for a query on a user's behalf. An empty array is
 * the caller who holds nothing: unscoped rows only.
 *
 * One definition, used by every read here, so the rule cannot differ between
 * `forSubject` and a lineage walk — which is exactly how a filter ends up applied
 * on the path everyone tests and missing on the path nobody does.
 */
function permissionFilter(permittedScopes: readonly string[] | undefined): SQL | undefined {
  if (permittedScopes === undefined) return undefined;
  // Empty grants dropped for the same reason `scopeGrants` denies them: a blank
  // entry would become `LIKE ':%'` and match every scoped row.
  const grants = permittedScopes.filter((scope) => scope.length > 0);
  if (grants.length === 0) return isNull(evidence.permissionScope);
  return or(
    isNull(evidence.permissionScope),
    inArray(evidence.permissionScope, [...grants]),
    // A grant covers its descendants — EPIC-083. Segment-wise, never a
    // substring: the pattern carries the separator, so `jira:proj-a` matches
    // `jira:proj-a:issue-1` and not `jira:proj-ab`.
    ...grants.map((scope) => like(evidence.permissionScope, scopeDescendantPattern(scope))),
  );
}

function toCanonical(row: EvidenceRow, derivedFrom: readonly string[]): CanonicalEvidence {
  return Object.freeze({
    id: row.id,
    subjectId: row.subjectId,
    field: row.field ?? undefined,
    statement: row.statement,
    method: row.method as EvidenceMethod,
    producer: row.producer,
    producerVersion: row.producerVersion,
    sourceSystem: row.sourceSystem,
    sourceId: row.sourceId ?? undefined,
    sourceUrl: row.sourceUrl ?? undefined,
    locator: (row.locator ?? undefined) as EvidenceLocator | undefined,
    sourceContentHash: row.sourceContentHash ?? undefined,
    confidence: row.confidence ?? undefined,
    completeness: row.completeness as Completeness,
    authority: row.authority,
    observedAt: row.observedAt?.toISOString(),
    derivedFrom: Object.freeze([...derivedFrom].sort()),
    permissionScope: row.permissionScope ?? undefined,
    integrityHash: row.integrityHash,
    redacted: row.redacted,
  });
}

export class EvidenceStore {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  /**
   * Records an observation.
   *
   * Identity covers what was observed, where it came from and what produced it,
   * so re-indexing an unchanged file deduplicates rather than accumulating. A
   * *different* producer or producer version is a genuinely different
   * observation and is kept separately — which is what makes "re-extract
   * everything the old parser touched" answerable.
   */
  async record(input: EvidenceInput, now: Date = new Date()): Promise<RecordedEvidence> {
    const canonical = createEvidence(input);

    try {
      return await this.#db.transaction(async (tx) => {
        const [existing] = await tx.select().from(evidence).where(eq(evidence.id, canonical.id)).limit(1);

        if (existing !== undefined) {
          // Already on record. Note that Ferret looked again — staleness is
          // measured from that — and change nothing else. Rewriting the row
          // would be exactly the silent rewrite §6 forbids.
          await tx.update(evidence).set({ lastCheckedAt: now }).where(eq(evidence.id, canonical.id));
          return {
            evidence: toCanonical(existing, await this.#readDerivedFrom(tx, canonical.id)),
            state: existing.state as EvidenceState,
            recordedAt: existing.recordedAt.toISOString(),
            supersededBy: existing.supersededBy ?? undefined,
            deduplicated: true,
          };
        }

        const [row] = await tx
          .insert(evidence)
          .values({
            id: canonical.id,
            subjectId: canonical.subjectId,
            field: canonical.field ?? null,
            statement: canonical.statement,
            method: canonical.method,
            producer: canonical.producer,
            producerVersion: canonical.producerVersion,
            sourceSystem: canonical.sourceSystem,
            sourceId: canonical.sourceId ?? null,
            sourceUrl: canonical.sourceUrl ?? null,
            locator: canonical.locator ?? null,
            sourceContentHash: canonical.sourceContentHash ?? null,
            confidence: canonical.confidence ?? null,
            completeness: canonical.completeness,
            authority: canonical.authority,
            observedAt: canonical.observedAt === undefined ? null : new Date(canonical.observedAt),
            recordedAt: now,
            lastCheckedAt: now,
            state: EvidenceState.CURRENT,
            supersededBy: null,
            permissionScope: canonical.permissionScope ?? null,
            integrityHash: canonical.integrityHash,
            redacted: canonical.redacted,
          })
          // Two callers racing to record the same observation is normal — two
          // providers indexing one repository. The second is a no-op, not a
          // failure.
          .onConflictDoNothing({ target: evidence.id })
          .returning();

        if (canonical.derivedFrom.length > 0) {
          await tx
            .insert(evidenceDerivation)
            .values(
              canonical.derivedFrom.map((sourceEvidenceId) => ({
                evidenceId: canonical.id,
                sourceEvidenceId,
              })),
            )
            .onConflictDoNothing();
        }

        if (row === undefined) {
          // Lost the race. Read what the winner wrote rather than reporting a
          // failure for an operation whose outcome was achieved.
          const [winner] = await tx.select().from(evidence).where(eq(evidence.id, canonical.id)).limit(1);
          if (winner === undefined) {
            throw new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'Evidence insert returned no row', {
              details: { evidenceId: canonical.id },
            });
          }
          return {
            evidence: toCanonical(winner, canonical.derivedFrom),
            state: winner.state as EvidenceState,
            recordedAt: winner.recordedAt.toISOString(),
            supersededBy: winner.supersededBy ?? undefined,
            deduplicated: true,
          };
        }

        return {
          evidence: toCanonical(row, canonical.derivedFrom),
          state: EvidenceState.CURRENT,
          recordedAt: row.recordedAt.toISOString(),
          supersededBy: undefined,
          deduplicated: false,
        };
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.evidence.record');
    }
  }

  async get(id: string): Promise<CanonicalEvidence | undefined> {
    const [row] = await this.#db.select().from(evidence).where(eq(evidence.id, id)).limit(1);
    return row === undefined ? undefined : toCanonical(row, await this.#readDerivedFrom(this.#db, id));
  }

  /** Ferret's current interpretation of a record, which the content hash excludes. */
  async stateOf(id: string): Promise<{ state: EvidenceState; supersededBy: string | undefined } | undefined> {
    const [row] = await this.#db
      .select({ state: evidence.state, supersededBy: evidence.supersededBy })
      .from(evidence)
      .where(eq(evidence.id, id))
      .limit(1);
    return row === undefined
      ? undefined
      : { state: row.state as EvidenceState, supersededBy: row.supersededBy ?? undefined };
  }

  /** Every record about a subject, newest observation first. */
  async forSubject(subjectId: string, query: EvidenceQuery = {}): Promise<CanonicalEvidence[]> {
    return await this.#hydrate(await this.#rowsForSubject(subjectId, query));
  }

  /**
   * The same query, each record paired with Ferret's interpretation of it.
   *
   * EPIC-062 needs both halves. `toCanonical` drops `state` — correctly, because
   * the integrity hash must exclude Ferret's revisable reading of an immutable
   * observation — and that left a citation surface unable to tell a superseded
   * record from a current one, so it could only order by recency.
   *
   * A projection rather than a second query: the `select()` below already fetches
   * `state` and `superseded_by`, and threw them away.
   */
  async forSubjectWithState(subjectId: string, query: EvidenceQuery = {}): Promise<StatedEvidence[]> {
    const rows = await this.#rowsForSubject(subjectId, query);
    const records = await this.#hydrate(rows);
    // `#hydrate` preserves row order, so index pairing is exact.
    return records.map((record, index) => {
      const row = rows[index];
      return Object.freeze({
        evidence: record,
        state: row === undefined ? undefined : (row.state as EvidenceState),
        supersededBy: row?.supersededBy ?? undefined,
      });
    });
  }

  async #rowsForSubject(subjectId: string, query: EvidenceQuery): Promise<EvidenceRow[]> {
    const filters = [eq(evidence.subjectId, subjectId)];
    if (query.field !== undefined) filters.push(eq(evidence.field, query.field));
    if (query.state !== undefined) filters.push(eq(evidence.state, query.state));
    // Unscoped evidence is visible to everyone; scoped evidence only to a caller
    // holding that scope. Filtering here rather than after assembly is what stops
    // protected content reaching an answer at all — Governance §12 requires
    // authorization before information enters retrieval results.
    const permission = permissionFilter(query.permittedScopes);
    if (permission !== undefined) filters.push(permission);

    try {
      return await this.#db
        .select()
        .from(evidence)
        .where(and(...filters))
        .orderBy(sql`COALESCE(${evidence.observedAt}, ${evidence.recordedAt}) DESC`)
        .limit(query.limit ?? 200);
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.evidence.forSubject');
    }
  }

  /**
   * Walks the provenance chain backwards from a conclusion.
   *
   * "Why does Ferret believe this" — the question EPIC-048 (Answer Traceability)
   * turns into a user-facing explanation. Depth-limited because a chain with a
   * cycle, however it got there, must not hang the query.
   */
  async provenanceOf(
    id: string,
    options: { readonly maxDepth?: number } & ScopedRead = {},
  ): Promise<CanonicalEvidence[]> {
    const maxDepth = options.maxDepth ?? 10;
    const seen = new Set<string>([id]);
    const chain: CanonicalEvidence[] = [];
    let frontier = [id];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const edges = await this.#db
        .select()
        .from(evidenceDerivation)
        .where(inArray(evidenceDerivation.evidenceId, frontier));

      const next = edges.map((edge) => edge.sourceEvidenceId).filter((candidate) => !seen.has(candidate));
      for (const candidate of next) seen.add(candidate);
      if (next.length === 0) break;

      // EPIC-058 AC-12. Filtered in the query, not after: an ancestor the caller
      // may not see must not be read, and a lineage is exactly where a protected
      // observation would otherwise surface — the chain is walked *because* the
      // caller asked why, and "why" is the most revealing answer Ferret gives.
      //
      // The walk continues past a withheld ancestor rather than stopping, because
      // stopping would make the chain's *shape* disclose where the protected row
      // sits.
      const rows = await this.#db
        .select()
        .from(evidence)
        .where(and(inArray(evidence.id, next), permissionFilter(options.permittedScopes)));
      chain.push(...(await this.#hydrate(rows)));
      frontier = next;
    }

    return chain;
  }

  /**
   * Walks the chain forwards from an observation.
   *
   * The direction a re-extraction needs: when a parser version is found to be
   * wrong, everything downstream of its output has to be found and redone.
   */
  async dependentsOf(id: string, maxDepth = 10): Promise<CanonicalEvidence[]> {
    const seen = new Set<string>([id]);
    const dependents: CanonicalEvidence[] = [];
    let frontier = [id];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const edges = await this.#db
        .select()
        .from(evidenceDerivation)
        .where(inArray(evidenceDerivation.sourceEvidenceId, frontier));

      const next = edges.map((edge) => edge.evidenceId).filter((candidate) => !seen.has(candidate));
      for (const candidate of next) seen.add(candidate);
      if (next.length === 0) break;

      const rows = await this.#db.select().from(evidence).where(inArray(evidence.id, next));
      dependents.push(...(await this.#hydrate(rows)));
      frontier = next;
    }

    return dependents;
  }

  /**
   * Marks a record as no longer current.
   *
   * The row is not deleted and its content is not touched — only Ferret's
   * interpretation of it. A superseded observation remains verifiable and
   * remains part of the history, which is what lets "what did Ferret believe
   * before, and why did that change" be answered.
   */
  async supersede(id: string, replacedBy: string, now: Date = new Date()): Promise<void> {
    try {
      await this.#db
        .update(evidence)
        .set({ state: EvidenceState.SUPERSEDED, supersededBy: replacedBy, lastCheckedAt: now })
        .where(eq(evidence.id, id));
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.evidence.supersede');
    }
  }

  /** Records that the source a piece of evidence came from has changed. */
  async markStale(id: string, now: Date = new Date()): Promise<void> {
    await this.#db
      .update(evidence)
      .set({ state: EvidenceState.STALE, lastCheckedAt: now })
      .where(eq(evidence.id, id));
  }

  /**
   * Finds current records that disagree about the same fact.
   *
   * Detection only. EPIC-045 decides which source wins and EPIC-047 acts on it;
   * reporting the disagreement is the honest answer when no authority rule
   * applies, and Governance §15 forbids resolving it by discarding one side.
   */
  async conflictsFor(subjectId: string, options: ScopedRead = {}): Promise<ConflictGroup[]> {
    const current = await this.forSubject(subjectId, {
      state: EvidenceState.CURRENT,
      ...(options.permittedScopes === undefined ? {} : { permittedScopes: options.permittedScopes }),
    });
    return detectConflicts(current);
  }

  /**
   * Recomputes the integrity hash of a stored record.
   *
   * Evidence is append-only through this module, so nothing legitimate changes a
   * row after it is written. A mismatch therefore means the row was altered
   * outside Ferret, which is a finding rather than an error to swallow.
   *
   * @throws {FerretError} `E_EVIDENCE_TAMPERED` when the content does not match
   * its recorded hash.
   */
  async verify(id: string, options: ScopedRead = {}): Promise<CanonicalEvidence> {
    const record = await this.get(id);
    // Withheld and absent give the same answer, deliberately: a distinct error
    // for "you may not verify this" would confirm the record exists, which is the
    // question the filter refuses.
    const visible =
      record !== undefined &&
      // Undefined means an unrestricted internal caller; an empty array means a
      // caller holding nothing, which sees unscoped records only.
      (options.permittedScopes === undefined ||
        record.permissionScope === undefined ||
        // The same membership rule the SQL filter applies — EPIC-083. Two
        // spellings of one decision is two decisions.
        options.permittedScopes.some((grant) =>
          scopeGrants(grant, record.permissionScope ?? ''),
        ));
    if (record === undefined || !visible) {
      throw new FerretError(ErrorCode.ENTITY_NOT_FOUND, `No evidence with id ${id}`, {
        details: { evidenceId: id },
      });
    }

    const recomputed = integrityHashOf(record);
    if (recomputed !== record.integrityHash) {
      throw new FerretError(
        ErrorCode.EVIDENCE_TAMPERED,
        `Evidence ${id} does not match its recorded integrity hash`,
        {
          details: { evidenceId: id, expected: record.integrityHash, actual: recomputed },
          remediation:
            'This row was modified outside Ferret. Re-index the source to produce a fresh observation; do not edit evidence in place.',
        },
      );
    }
    return record;
  }

  /**
   * Verifies one subject's records, returning the ones that fail rather than
   * throwing.
   *
   * An integrity sweep wants the whole picture; stopping at the first bad row
   * would hide how much is affected.
   *
   * **The bound is reported, not applied silently — EPIC-094, issue #95.** This
   * read at most 1 000 rows and returned `checked` as though it were the whole
   * subject, so a subject with more observations than that was reported clean
   * on the strength of its first thousand. A partial answer presented as a whole
   * one is the exact failure Governance §6 forbids, and it is the worst possible
   * place to make it: it looks like success.
   *
   * `complete` is the field a caller must read. An installation-wide sweep lives
   * in {@link IntegrityService}; this stays subject-scoped because that is what
   * its one caller asks for.
   */
  async verifyAll(
    subjectId: string,
    options: { readonly limit?: number } = {},
  ): Promise<{ checked: number; total: number; complete: boolean; tampered: string[] }> {
    const limit = options.limit ?? 1_000;
    // Named, not omitted — EPIC-083 AC-2. An integrity read sees everything
    // Ferret wrote, including protected records, and says so.
    const records = await this.forSubject(subjectId, { ...UNRESTRICTED_READ, limit });
    const total = await this.count(subjectId);
    const tampered = records
      .filter((record) => integrityHashOf(record) !== record.integrityHash)
      .map((record) => record.id);
    return { checked: records.length, total, complete: records.length >= total, tampered };
  }

  /** True when the source content has changed since the evidence was recorded. */
  isStaleAgainst(record: CanonicalEvidence, currentSourceHash: string): boolean {
    // Unknown, not fresh: evidence recorded without a source hash cannot be
    // checked, and reporting it as current would be manufacturing certainty.
    return record.sourceContentHash !== undefined && record.sourceContentHash !== currentSourceHash;
  }

  async count(subjectId?: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<string>`count(*)::text` })
      .from(evidence)
      .where(subjectId === undefined ? undefined : eq(evidence.subjectId, subjectId));
    return Number(rows[0]?.count ?? '0');
  }

  async #hydrate(rows: readonly EvidenceRow[]): Promise<CanonicalEvidence[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const edges = await this.#db
      .select()
      .from(evidenceDerivation)
      .where(inArray(evidenceDerivation.evidenceId, ids));

    const byEvidence = new Map<string, string[]>();
    for (const edge of edges) {
      const list = byEvidence.get(edge.evidenceId) ?? [];
      list.push(edge.sourceEvidenceId);
      byEvidence.set(edge.evidenceId, list);
    }
    return rows.map((row) => toCanonical(row, byEvidence.get(row.id) ?? []));
  }

  async #readDerivedFrom(db: FerretDatabase, id: string): Promise<string[]> {
    const edges = await db
      .select()
      .from(evidenceDerivation)
      .where(eq(evidenceDerivation.evidenceId, id));
    return edges.map((edge) => edge.sourceEvidenceId);
  }
}

/** Re-exported so callers comparing statements use the same canonical form. */
export { stableStringify };
