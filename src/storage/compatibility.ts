import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Pool } from 'pg';

import {
  Compatibility,
  ENTITY_SCHEMA_VERSION,
  SURFACE_POLICIES,
  VersionedSurface,
  canonicalId,
  checkCompatibility,
  databaseSchemaPolicy,
  encodeKeyParts,
  isArtifactStale,
  summarizeCompatibility,
  type CompatibilityReport,
  type CompatibilityVerdict,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

import { classifyDatabaseError, isMissingRelation } from './connection.js';
import type { FerretDatabase } from './entities.js';
import { entity } from './schema/entities.js';
import { derivedArtifact, type DerivedArtifactRow } from './schema/derived.js';
import { readSchemaStatus } from './migrator.js';
import { targetSchemaVersion } from './migration-source.js';

/**
 * Applying the compatibility policy to a live installation.
 *
 * `src/domain/compatibility.ts` states the rules; this asks the database what
 * versions it actually holds and runs them. Keeping the two apart means the
 * rules can be tested exhaustively without a database, and the reading can be
 * tested against a real one.
 */

export const ArtifactState = {
  VALID: 'valid',
  /** The producer or the source has changed since it was built. */
  STALE: 'stale',
  /** A rebuild is in progress. */
  REBUILDING: 'rebuilding',
} as const;

export type ArtifactState = (typeof ArtifactState)[keyof typeof ArtifactState];

export interface DerivedArtifactInput {
  readonly kind: string;
  readonly scopeId?: string | undefined;
  readonly producer: string;
  readonly producerVersion: string;
  readonly sourceContentHash?: string | undefined;
  readonly metadata?: Record<string, unknown>;
}

export interface DerivedArtifact {
  readonly id: string;
  readonly kind: string;
  readonly scopeId: string | undefined;
  readonly producer: string;
  readonly producerVersion: string;
  readonly schemaVersion: number;
  readonly sourceContentHash: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly builtAt: string;
  readonly state: ArtifactState;
}

function toArtifact(row: DerivedArtifactRow): DerivedArtifact {
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    scopeId: row.scopeId ?? undefined,
    producer: row.producer,
    producerVersion: row.producerVersion,
    schemaVersion: row.schemaVersion,
    sourceContentHash: row.sourceContentHash ?? undefined,
    metadata: Object.freeze(row.metadata as Record<string, unknown>),
    builtAt: row.builtAt.toISOString(),
    state: row.state as ArtifactState,
  });
}

/** Identity of one artefact: a kind within a scope. */
function artifactId(kind: string, scopeId: string | undefined): string {
  return canonicalId(encodeKeyParts(['derived-artifact', kind, scopeId ?? '']));
}

export class CompatibilityService {
  readonly #db: FerretDatabase;
  readonly #pool: Pool;

  constructor(db: FerretDatabase, pool: Pool) {
    this.#db = db;
    this.#pool = pool;
  }

  /**
   * Reads every versioned surface and applies the policy to each.
   *
   * One report rather than four separate checks, so `ferret doctor` and every
   * write path ask the same question and get the same answer.
   */
  async check(): Promise<CompatibilityReport> {
    const verdicts: CompatibilityVerdict[] = [];

    const schema = await readSchemaStatus(this.#pool);
    // A database from a newer Ferret reports unknown applied versions; the
    // highest of those is the version it is really at.
    const databaseVersion =
      schema.unknown.length > 0 ? Math.max(...schema.unknown) : schema.schemaVersion;
    verdicts.push(checkCompatibility(databaseSchemaPolicy(targetSchemaVersion()), databaseVersion));

    verdicts.push(
      checkCompatibility(SURFACE_POLICIES[VersionedSurface.ENTITY_SCHEMA], await this.#highestEntityVersion()),
    );

    return summarizeCompatibility(verdicts);
  }

  /**
   * Refuses to write when any surface is incompatible.
   *
   * AC-3 requires incompatible versions to fail **before unsafe writes**, so
   * this is called at the boundary of a write path rather than left to each
   * caller to remember.
   */
  async assertSafeToWrite(): Promise<void> {
    const report = await this.check();
    const unsafe = report.verdicts.find((verdict) => !verdict.safeToWrite);
    if (unsafe === undefined) return;

    const code =
      unsafe.compatibility === Compatibility.UPGRADABLE
        ? ErrorCode.MIGRATION_PENDING
        : ErrorCode.SCHEMA_UNSUPPORTED;

    throw new FerretError(code, unsafe.detail, {
      details: {
        surface: unsafe.surface,
        found: unsafe.found,
        expected: unsafe.expected,
        compatibility: unsafe.compatibility,
      },
      ...(unsafe.remediation === undefined ? {} : { remediation: unsafe.remediation }),
    });
  }

  /**
   * The highest entity envelope version present.
   *
   * Reading the maximum rather than sampling: one row from a newer Ferret is
   * enough to make writing unsafe, and a check that missed it would be worse
   * than no check.
   *
   * A missing table is not an error. Compatibility has to be answerable on a
   * *partially migrated* database — which is exactly when an operator most needs
   * it, and when the entity table may not exist yet because a later migration
   * creates it. An empty or absent table has nothing incompatible in it, so it
   * reports the current version. Same stance `readSchemaStatus` takes toward a
   * database Ferret has never touched.
   */
  async #highestEntityVersion(): Promise<number> {
    try {
      const rows = await this.#db
        .select({ highest: sql<number | null>`max(${entity.schemaVersion})` })
        .from(entity);
      return rows[0]?.highest ?? ENTITY_SCHEMA_VERSION;
    } catch (error) {
      if (isMissingRelation(error)) return ENTITY_SCHEMA_VERSION;
      throw classifyDatabaseError(error, 'storage.compatibility.entityVersion');
    }
  }

  /**
   * Records that a derived artefact was built.
   *
   * Replaces any previous artefact of the same kind and scope: rebuilding must
   * not leave the old one available to be selected.
   */
  async recordArtifact(input: DerivedArtifactInput, now: Date = new Date()): Promise<DerivedArtifact> {
    const id = artifactId(input.kind, input.scopeId);

    try {
      const [row] = await this.#db
        .insert(derivedArtifact)
        .values({
          id,
          kind: input.kind,
          scopeId: input.scopeId ?? null,
          producer: input.producer,
          producerVersion: input.producerVersion,
          schemaVersion: ENTITY_SCHEMA_VERSION,
          sourceContentHash: input.sourceContentHash ?? null,
          metadata: input.metadata ?? {},
          builtAt: now,
          lastCheckedAt: now,
          state: ArtifactState.VALID,
        })
        .onConflictDoUpdate({
          target: derivedArtifact.id,
          set: {
            producer: input.producer,
            producerVersion: input.producerVersion,
            schemaVersion: ENTITY_SCHEMA_VERSION,
            sourceContentHash: input.sourceContentHash ?? null,
            metadata: input.metadata ?? {},
            builtAt: now,
            lastCheckedAt: now,
            state: ArtifactState.VALID,
          },
        })
        .returning();

      if (row === undefined) {
        throw new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'Derived artefact insert returned no row', {
          details: { kind: input.kind },
        });
      }
      return toArtifact(row);
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.compatibility.recordArtifact');
    }
  }

  async getArtifact(kind: string, scopeId?: string): Promise<DerivedArtifact | undefined> {
    const [row] = await this.#db
      .select()
      .from(derivedArtifact)
      .where(
        and(
          eq(derivedArtifact.kind, kind),
          scopeId === undefined ? isNull(derivedArtifact.scopeId) : eq(derivedArtifact.scopeId, scopeId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : toArtifact(row);
  }

  /**
   * Artefacts a producer upgrade has invalidated.
   *
   * The sweep run after a parser or model changes. Any difference in producer or
   * version counts — Ferret cannot know whether a change was breaking, so the
   * conservative direction is the only safe one.
   */
  async staleArtifacts(
    producer: string,
    currentVersion: string,
    kind?: string,
  ): Promise<DerivedArtifact[]> {
    const filters = [eq(derivedArtifact.producer, producer), ne(derivedArtifact.producerVersion, currentVersion)];
    if (kind !== undefined) filters.push(eq(derivedArtifact.kind, kind));

    const rows = await this.#db
      .select()
      .from(derivedArtifact)
      .where(and(...filters));
    return rows.map(toArtifact);
  }

  /**
   * Whether one artefact is still valid against the current producer and source.
   *
   * Returns *why* it is stale, because "the parser changed" and "the file
   * changed" call for the same action but mean different things, and an operator
   * asking why everything is rebuilding deserves the real answer.
   */
  validateArtifact(
    artifact: DerivedArtifact,
    current: { producer: string; producerVersion: string; sourceContentHash?: string },
  ): { valid: boolean; reason: string | undefined } {
    if (isArtifactStale(artifact, current)) {
      return {
        valid: false,
        reason: `built by ${artifact.producer}@${artifact.producerVersion}, current is ${current.producer}@${current.producerVersion}`,
      };
    }
    if (
      current.sourceContentHash !== undefined &&
      artifact.sourceContentHash !== undefined &&
      artifact.sourceContentHash !== current.sourceContentHash
    ) {
      return { valid: false, reason: 'the source content has changed since it was built' };
    }
    if (artifact.schemaVersion !== ENTITY_SCHEMA_VERSION) {
      return {
        valid: false,
        reason: `built against entity schema ${String(artifact.schemaVersion)}, current is ${String(ENTITY_SCHEMA_VERSION)}`,
      };
    }
    return { valid: true, reason: undefined };
  }

  /** Marks artefacts a producer upgrade invalidated, so a rebuild can find them. */
  async markStale(producer: string, currentVersion: string, now: Date = new Date()): Promise<number> {
    const result = await this.#db
      .update(derivedArtifact)
      .set({ state: ArtifactState.STALE, lastCheckedAt: now })
      .where(
        and(
          eq(derivedArtifact.producer, producer),
          or(
            ne(derivedArtifact.producerVersion, currentVersion),
            ne(derivedArtifact.schemaVersion, ENTITY_SCHEMA_VERSION),
          ),
        ),
      )
      .returning({ id: derivedArtifact.id });
    return result.length;
  }
}
