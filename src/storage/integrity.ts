import { asc, eq, gt, sql, type SQL } from 'drizzle-orm';

import {
  IntegrityFindingKind,
  IntegritySubject,
  verifyEntity,
  verifyEvidence,
  verifyRelationship,
  type IntegrityFinding,
} from '../domain/index.js';
import type { Logger } from '../logging/index.js';
import { ENTITY_SCHEMA_VERSION } from '../domain/index.js';
import { VERSION } from '../version.js';

import { classifyDatabaseError } from './connection.js';
import { EntityStore, type FerretDatabase } from './entities.js';
import { EvidenceStore } from './evidence.js';
import { IndexRunStore } from './runs.js';
import { derivedArtifact } from './schema/derived.js';
import { entity } from './schema/entities.js';
import { evidence } from './schema/evidence.js';
import { relationship } from './schema/relationships.js';

/**
 * The integrity sweep — EPIC-094 §3.2.
 *
 * Governance §13: *"Corrupt or stale derived indexes must be detectable and
 * recoverable without requiring the user to become a database administrator."*
 * Detection is this file. Recovery is a re-index, and the two are deliberately
 * never fused: a sweep that repaired as it went would make its own report
 * unreproducible, and an operator who cannot see a finding before the fix cannot
 * tell a real problem from a bug in the checker.
 *
 * **Everything here is read-only.** No method in this module issues an `UPDATE`
 * or a `DELETE`, and that is the contract AC-11 turns into a test: the only
 * correct fix for a row that disagrees with its hash is a fresh observation
 * superseding it. Editing the row to match the hash — or the hash to match the
 * row — launders a corruption into a fact.
 *
 * **`UNRESTRICTED_READ` is said out loud.** A sweep reads back what Ferret
 * itself wrote and must see all of it. EPIC-083 named this caller by name and
 * closed the door on arriving at unrestricted by omitting the parameter.
 */

/** How far a sweep got in each table, so the next one can carry on. */
export interface SweepCursor {
  readonly entity: string | undefined;
  readonly relationship: string | undefined;
  readonly evidence: string | undefined;
}

export interface SweepOptions {
  /**
   * Rows examined per table before the sweep stops and says so.
   *
   * A bound that was hit is reported, never applied silently — the shape
   * `EvidenceStore.verifyAll` had, where a `limit: 1_000` produced a `checked`
   * count that read like a whole subject.
   */
  readonly limit?: number;
  /** Resume from a previous sweep's cursor. */
  readonly after?: SweepCursor;
  /** Restrict entity and evidence checks to one repository scope. */
  readonly repositoryId?: string;
  /**
   * What the caller's composition would build an artefact as, today — AC-7.
   *
   * A port rather than a parser, and that is forced rather than stylistic:
   * `boundaries.test.ts` asserts `src/storage/`'s external package set exactly,
   * so importing `ParserFramework` here would drag `web-tree-sitter` into the
   * storage graph and fail that check. The caller has a parser; the sweep asks
   * it a question.
   *
   * Absent, every non-`ferret.indexer` artefact stays `unassessable` — the
   * behaviour before this existed, and still the honest answer when nothing can
   * judge them.
   */
  readonly producerIdentity?: ProducerIdentityResolver;
  readonly logger?: Logger;
}

/**
 * What a producer would stamp on an artefact if it rebuilt it now.
 *
 * The seam AC-7 needed. `ferret.indexer` records a Ferret version and the sweep
 * can compare that itself; `ferret.indexer.content` records a *parser* identity
 * — `ferret.parser.code@1.0.0+wts0.25.10+typescript@14/8515…`, or the literal
 * `none` — which depends on the file and on what the caller composed. Only the
 * caller can answer it.
 */
export interface ProducerIdentityResolver {
  /**
   * The current version for one artefact, or `undefined` when it cannot say.
   *
   * `undefined` is not "stale". A resolver that cannot judge an artefact leaves
   * it `unassessable`, because reporting an artefact stale on the strength of
   * not knowing is how 540 healthy rows got reported corrupt once already.
   */
  versionFor(artifact: {
    readonly kind: string;
    readonly producer: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }): Promise<string | undefined>;
}

export interface SweepCounts {
  readonly entities: number;
  readonly relationships: number;
  readonly evidence: number;
  readonly artifacts: number;
  readonly runs: number;
}

export interface SweepReport {
  readonly examined: SweepCounts;
  /**
   * Rows a check could not judge, and therefore did not.
   *
   * §8 — a check that cannot run reports `unknown`, never `ok`. Today this is
   * derived artefacts whose producer version is a parser identity rather than a
   * Ferret version; judging those needs a composed parser, which a read-only
   * sweep does not have.
   */
  readonly unassessable: number;
  /** How many rows exist, so `examined` can be read against something. */
  readonly total: SweepCounts;
  /**
   * True only when every table was read to its end.
   *
   * The single most important field here. A partial sweep reporting no findings
   * looks exactly like a clean installation, and that is the failure mode this
   * Epic exists to stop repeating.
   */
  readonly complete: boolean;
  /** Tables where the bound was reached, named. Empty when `complete`. */
  readonly truncated: readonly string[];
  /** Where to resume. `undefined` when the sweep finished. */
  readonly cursor: SweepCursor | undefined;
  readonly findings: readonly IntegrityFinding[];
  readonly durationMs: number;
}

/**
 * The one producer whose `producer_version` is a Ferret version.
 *
 * Every other Ferret producer records the identity of whatever *it* composed —
 * a parser and its grammar, for `ferret.indexer.content` — and comparing that
 * to `VERSION` is a category error, not a staleness check.
 */
const INDEXER_PRODUCER = 'ferret.indexer';

function staleFinding(
  row: { id: string; kind: string; scopeId: string | null },
  reason: string,
): IntegrityFinding {
  return {
    kind: IntegrityFindingKind.STALE_ARTIFACT,
    subject: IntegritySubject.ARTIFACT,
    id: row.id,
    entityKind: row.kind,
    canonicalKey: undefined,
    scope: row.scopeId ?? undefined,
    detail: `${reason}.`,
    remediation:
      'Nothing is lost. Run `ferret index <path>` to re-derive that scope, or `ferret verify --repair` to re-derive every stale scope.',
  };
}

/** The default bound. Large enough for a real installation, small enough to end. */
export const DEFAULT_SWEEP_LIMIT = 10_000;

/**
 * An open run older than this is reported as unfinished.
 *
 * Not "dead": the database cannot be asked whether a process is alive, and
 * pretending otherwise would be the manufactured certainty Governance §6 exists
 * to prevent. Two hours is longer than any index run Ferret has been measured
 * performing, so a run still open past it is either enormous or gone, and both
 * are worth an operator's attention.
 */
export const UNFINISHED_RUN_AFTER_MS = 2 * 60 * 60 * 1000;

export class IntegrityService {
  readonly #db: FerretDatabase;
  readonly #entities: EntityStore;
  readonly #evidence: EvidenceStore;
  readonly #runs: IndexRunStore;

  constructor(db: FerretDatabase) {
    this.#db = db;
    this.#entities = new EntityStore(db);
    this.#evidence = new EvidenceStore(db);
    this.#runs = new IndexRunStore(db);
  }

  /**
   * Verifies the whole installation, bounded and resumable.
   *
   * Reads in id order and remembers where it stopped, so a store larger than the
   * bound is examined across several sweeps rather than partly examined once and
   * declared clean.
   */
  async sweep(options: SweepOptions = {}): Promise<SweepReport> {
    const startedAt = Date.now();
    const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
    const findings: IntegrityFinding[] = [];
    const truncated: string[] = [];

    try {
      const scope = options.repositoryId;

      const entities = await this.#sweepEntities(limit, options.after?.entity, scope);
      findings.push(...entities.findings);
      if (entities.truncated) truncated.push('entity');

      const relationships = await this.#sweepRelationships(limit, options.after?.relationship);
      findings.push(...relationships.findings);
      if (relationships.truncated) truncated.push('relationship');

      const observations = await this.#sweepEvidence(limit, options.after?.evidence, scope);
      findings.push(...observations.findings);
      if (observations.truncated) truncated.push('evidence');

      const artifacts = await this.#sweepArtifacts(options.producerIdentity);
      findings.push(...artifacts.findings);

      const runs = await this.#sweepRuns();
      findings.push(...runs.findings);

      const complete = truncated.length === 0;
      const report: SweepReport = {
        examined: {
          entities: entities.examined,
          relationships: relationships.examined,
          evidence: observations.examined,
          artifacts: artifacts.examined,
          runs: runs.examined,
        },
        total: {
          entities: await this.#count(entity, scope === undefined ? undefined : eq(entity.sourceScope, scope)),
          relationships: await this.#count(relationship),
          evidence: await this.#count(evidence),
          artifacts: await this.#count(derivedArtifact),
          runs: await this.#runs.count(),
        },
        unassessable: artifacts.unassessable,
        complete,
        truncated,
        cursor: complete
          ? undefined
          : { entity: entities.last, relationship: relationships.last, evidence: observations.last },
        findings,
        durationMs: Date.now() - startedAt,
      };

      // Governance §20, and EPIC-032's point about skipped sweeps: silence and
      // health must not look the same. A sweep that found nothing says so.
      options.logger?.info(
        {
          operation: 'index.integrity',
          scope: scope ?? 'installation',
          examined: report.examined,
          complete: report.complete,
          truncated: report.truncated,
          findings: report.findings.length,
          durationMs: report.durationMs,
        },
        report.findings.length === 0
          ? `Integrity sweep found nothing wrong in ${String(report.examined.entities)} entities, ${String(report.examined.relationships)} relationships and ${String(report.examined.evidence)} observations`
          : `Integrity sweep found ${String(report.findings.length)} problem(s)`,
      );

      return report;
    } catch (error) {
      throw classifyDatabaseError(error, 'integrity.sweep');
    }
  }

  async #count(table: typeof entity | typeof relationship | typeof evidence | typeof derivedArtifact, where?: SQL): Promise<number> {
    const rows = await this.#db
      .select({ n: sql<string>`count(*)::text` })
      .from(table)
      .where(where);
    return Number(rows[0]?.n ?? '0');
  }

  async #sweepEntities(
    limit: number,
    after: string | undefined,
    scope: string | undefined,
  ): Promise<{ examined: number; truncated: boolean; last: string | undefined; findings: IntegrityFinding[] }> {
    const filters: SQL[] = [];
    if (after !== undefined) filters.push(gt(entity.id, after));
    if (scope !== undefined) filters.push(eq(entity.sourceScope, scope));

    const rows = await this.#db
      .select({ id: entity.id })
      .from(entity)
      .where(filters.length === 0 ? undefined : sql.join(filters, sql` AND `))
      .orderBy(asc(entity.id))
      .limit(limit);

    const findings: IntegrityFinding[] = [];
    for (const row of rows) {
      // Read through the store rather than mapping the row here: the store owns
      // how a row becomes a canonical value, including its external ids, and a
      // second mapping would verify against a shape production never produces.
      const stored = await this.#entities.get(row.id);
      if (stored === undefined) continue;
      findings.push(...verifyEntity(stored));
    }

    return {
      examined: rows.length,
      truncated: rows.length === limit,
      last: rows.at(-1)?.id,
      findings,
    };
  }

  async #sweepRelationships(
    limit: number,
    after: string | undefined,
  ): Promise<{ examined: number; truncated: boolean; last: string | undefined; findings: IntegrityFinding[] }> {
    const rows = await this.#db
      .select()
      .from(relationship)
      .where(after === undefined ? undefined : gt(relationship.id, after))
      .orderBy(asc(relationship.id))
      .limit(limit);

    const findings: IntegrityFinding[] = [];
    for (const row of rows) {
      findings.push(
        ...verifyRelationship({
          id: row.id,
          fromId: row.fromId,
          type: row.type,
          toId: row.toId,
          validFrom: row.validFrom.toISOString(),
          validTo: row.validTo === null ? null : row.validTo.toISOString(),
          metadata: row.metadata as Record<string, unknown>,
          sourceSystem: row.sourceSystem,
          sourceId: row.sourceId ?? undefined,
          contentHash: row.contentHash,
        }),
      );
    }

    return { examined: rows.length, truncated: rows.length === limit, last: rows.at(-1)?.id, findings };
  }

  async #sweepEvidence(
    limit: number,
    after: string | undefined,
    scope: string | undefined,
  ): Promise<{ examined: number; truncated: boolean; last: string | undefined; findings: IntegrityFinding[] }> {
    const filters: SQL[] = [];
    if (after !== undefined) filters.push(gt(evidence.id, after));
    if (scope !== undefined) filters.push(eq(evidence.subjectId, scope));

    const rows = await this.#db
      .select({ id: evidence.id })
      .from(evidence)
      .where(filters.length === 0 ? undefined : sql.join(filters, sql` AND `))
      .orderBy(asc(evidence.id))
      .limit(limit);

    const findings: IntegrityFinding[] = [];
    for (const row of rows) {
      // `get` takes no scoped-read parameter: it is the internal read, and
      // EPIC-008's checkpoint is explicit that "an internal caller omitting it
      // is correct, a retrieval caller omitting it is a leak". Where a
      // parameter *does* exist — `verifyAll` — this Epic passes
      // {@link UNRESTRICTED_READ} by name rather than arriving at unrestricted
      // by omission, which is the door EPIC-083 closed.
      const stored = await this.#evidence.get(row.id);
      if (stored === undefined) continue;
      findings.push(...verifyEvidence(stored));
    }

    return { examined: rows.length, truncated: rows.length === limit, last: rows.at(-1)?.id, findings };
  }

  /**
   * Every derived artefact whose producer, version or entity schema is no longer
   * current — AC-7.
   *
   * Across **every kind**, which is the gap: the `index-integrity` probe filters
   * `kind = 'index'`, so a `content-index` artefact built by a superseded parser
   * has been invisible to it since EPIC-108 shipped.
   */
  async #sweepArtifacts(
    resolver: ProducerIdentityResolver | undefined,
  ): Promise<{ examined: number; unassessable: number; findings: IntegrityFinding[] }> {
    const rows = await this.#db
      .select({
        id: derivedArtifact.id,
        kind: derivedArtifact.kind,
        scopeId: derivedArtifact.scopeId,
        producer: derivedArtifact.producer,
        producerVersion: derivedArtifact.producerVersion,
        schemaVersion: derivedArtifact.schemaVersion,
        metadata: derivedArtifact.metadata,
      })
      .from(derivedArtifact);

    const findings: IntegrityFinding[] = [];
    let unassessable = 0;
    for (const row of rows) {
      // The entity schema version is comparable for every artefact, whoever
      // built it, so it is checked first and unconditionally.
      if (row.schemaVersion !== ENTITY_SCHEMA_VERSION) {
        findings.push(staleFinding(row, `built against entity schema ${String(row.schemaVersion)}, current is ${String(ENTITY_SCHEMA_VERSION)}`));
        continue;
      }

      // **A producer version is only comparable to Ferret's when the producer
      // is Ferret itself.** Measured on Ferret's own index: `ferret.indexer`
      // records `0.1.0`, and `ferret.indexer.content` records the *parser's*
      // identity — `ferret.parser.code@1.0.0+wts0.25.10+typescript@14/8515…`,
      // or the literal `none` where no parser claimed the file. Comparing
      // either to `VERSION` reported all 540 content artefacts as stale on a
      // freshly built index, which is exactly how a real finding gets trained
      // out of an operator.
      //
      // EPIC-010's `validateArtifact` is the rule that *can* judge these, and
      // it needs the current parser identity — which means composing a parser,
      // which a read-only sweep does not do. So they are counted as
      // unassessable and reported as such: §8, a check that cannot run says
      // `unknown` and never `ok`. EPIC-108's re-parse gate already validates
      // them on the path that has a parser in hand.
      if (row.producer !== INDEXER_PRODUCER) {
        // AC-7 — "a derived artefact of **any** kind". A caller that composed
        // the producer can say what it would stamp today; one that did not
        // leaves the row unassessable, which is what this branch did for every
        // artefact before the seam existed.
        const current =
          resolver === undefined
            ? undefined
            : await resolver.versionFor({
                kind: row.kind,
                producer: row.producer,
                metadata: (row.metadata ?? {}) as Readonly<Record<string, unknown>>,
              });
        if (current === undefined) {
          unassessable += 1;
          continue;
        }
        if (row.producerVersion === current) continue;
        findings.push(staleFinding(row, `built by ${row.producer}@${row.producerVersion}; this composition builds ${current}`));
        continue;
      }
      if (row.producerVersion === VERSION) continue;
      findings.push(staleFinding(row, `built by ${row.producer}@${row.producerVersion}; this Ferret is ${VERSION}`));
    }

    return { examined: rows.length, unassessable, findings };
  }

  /** Runs that started and never recorded finishing — AC-6. */
  async #sweepRuns(): Promise<{ examined: number; findings: IntegrityFinding[] }> {
    const open = await this.#runs.unfinished(new Date(Date.now() - UNFINISHED_RUN_AFTER_MS));
    return {
      examined: open.length,
      findings: open.map((run) => ({
        kind: IntegrityFindingKind.UNFINISHED_RUN,
        subject: IntegritySubject.RUN,
        id: run.id,
        entityKind: undefined,
        canonicalKey: undefined,
        scope: run.repositoryId,
        detail: `An index run started at ${run.startedAt.toISOString()} by ferret ${run.ferretVersion} (pid ${String(run.hostPid)}) never recorded finishing.`,
        remediation: `Run \`ferret index ${run.repositoryKey}\` again. Indexing is idempotent, so a re-run costs a read and writes only what is missing.`,
      })),
    };
  }
}
