import { and, eq, isNull, sql } from 'drizzle-orm';

import {
  EntityKind,
  LifecycleState,
  RelationshipType,
  actorClassForKind,
  assertSameActorClass,
  createIdentityAlias,
  type ActorClass,
  type IdentityAlias,
  type IdentityAliasInput,
  type IdentityCollision,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';
import { entity } from './schema/entities.js';
import { identityAlias, type IdentityAliasRow } from './schema/identities.js';
import { RelationshipStore } from './relationships.js';

/**
 * Reconciling identities.
 *
 * Three properties EPIC-009 requires, none of which a naive "upsert the mapping"
 * would give:
 *
 * - **Collisions are detected, never merged.** Two actors claiming one external
 *   identity is a judgement call, and answering it automatically is how two
 *   people who once shared a shell account become one contributor —
 *   permanently, and invisibly.
 * - **Developers and agents never merge.** They are distinct identity classes,
 *   and merging them would answer "who wrote this" with a bot.
 * - **History is retained.** A mapping that stops being true is closed, not
 *   deleted, so "who was this address at the time" stays answerable.
 *
 * Reconciliation runs under a transaction-scoped advisory lock keyed on the
 * external identity, because "concurrent reconciliation" is an explicit test
 * requirement and the read-decide-write shape is the same one that produced
 * write skew in EPIC-007.
 */

/** Serializes reconciliation of one external identity. See EPIC-007 D-007. */
async function lockIdentity(tx: FerretDatabase, system: string, externalId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:${system}:${externalId}`}, 0))`);
}

export const LinkOutcome = {
  /** A new mapping was recorded. */
  LINKED: 'linked',
  /** The mapping already existed, unchanged. */
  UNCHANGED: 'unchanged',
  /** Another actor already holds this identity. Nothing was written. */
  COLLISION: 'collision',
} as const;

export type LinkOutcome = (typeof LinkOutcome)[keyof typeof LinkOutcome];

export interface LinkResult {
  readonly outcome: LinkOutcome;
  readonly alias: IdentityAlias | undefined;
  /** Present when the outcome is a collision. */
  readonly collision: IdentityCollision | undefined;
}

export interface MergeResult {
  /** The actor that remains. */
  readonly survivorId: string;
  /** The actor that was superseded. Retained, never deleted. */
  readonly mergedId: string;
  /** Aliases moved from the merged actor to the survivor. */
  readonly movedAliases: readonly string[];
}

function toAlias(row: IdentityAliasRow): IdentityAlias {
  return Object.freeze({
    id: row.id,
    system: row.system,
    externalId: row.externalId,
    actorId: row.actorId,
    actorClass: row.actorClass as ActorClass,
    evidenceId: row.evidenceId ?? undefined,
    confidence: row.confidence ?? undefined,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo === null ? null : row.validTo.toISOString(),
  });
}

export class IdentityStore {
  readonly #db: FerretDatabase;
  readonly #relationships: RelationshipStore;

  constructor(db: FerretDatabase) {
    this.#db = db;
    this.#relationships = new RelationshipStore(db);
  }

  /**
   * Maps an external identity to an actor.
   *
   * Reports a collision rather than resolving one. A caller that genuinely
   * intends to merge two actors calls {@link merge}, which requires evidence —
   * making the merge a deliberate, recorded act rather than a side effect of
   * ingestion.
   */
  async link(input: IdentityAliasInput, now: Date = new Date()): Promise<LinkResult> {
    const proposed = createIdentityAlias(input, now);
    await this.#assertActorClassMatchesEntity(proposed.actorId, proposed.actorClass);

    try {
      return await this.#db.transaction(async (tx) => {
        await lockIdentity(tx, proposed.system, proposed.externalId);

        const [current] = await tx
          .select()
          .from(identityAlias)
          .where(
            and(
              eq(identityAlias.system, proposed.system),
              eq(identityAlias.externalId, proposed.externalId),
              isNull(identityAlias.validTo),
            ),
          )
          .limit(1);

        if (current !== undefined) {
          if (current.actorId === proposed.actorId) {
            await tx.update(identityAlias).set({ lastIndexedAt: now }).where(eq(identityAlias.id, current.id));
            return { outcome: LinkOutcome.UNCHANGED, alias: toAlias(current), collision: undefined };
          }

          // Two actors want the same identity. Report it; change nothing.
          return {
            outcome: LinkOutcome.COLLISION,
            alias: toAlias(current),
            collision: {
              system: proposed.system,
              externalId: proposed.externalId,
              existingActorId: current.actorId,
              proposedActorId: proposed.actorId,
              crossesActorClass: current.actorClass !== proposed.actorClass,
            },
          };
        }

        const [row] = await tx
          .insert(identityAlias)
          .values({
            id: proposed.id,
            system: proposed.system,
            externalId: proposed.externalId,
            actorId: proposed.actorId,
            actorClass: proposed.actorClass,
            evidenceId: proposed.evidenceId ?? null,
            confidence: proposed.confidence ?? null,
            validFrom: new Date(proposed.validFrom),
            validTo: null,
            firstIndexedAt: now,
            lastIndexedAt: now,
          })
          .onConflictDoUpdate({
            target: identityAlias.id,
            set: { lastIndexedAt: now, evidenceId: proposed.evidenceId ?? null },
          })
          .returning();

        if (row === undefined) {
          throw new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'Identity alias insert returned no row', {
            details: { system: proposed.system },
          });
        }
        return { outcome: LinkOutcome.LINKED, alias: toAlias(row), collision: undefined };
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.identity.link');
    }
  }

  /**
   * Resolves an external identity to the actor that currently holds it.
   *
   * Point-in-time when `at` is given, which is what makes "who was this address
   * when that commit was authored" answerable after a reassignment.
   */
  async resolve(system: string, externalId: string, at?: Date): Promise<IdentityAlias | undefined> {
    const filters = [eq(identityAlias.system, system), eq(identityAlias.externalId, externalId)];
    if (at === undefined) {
      filters.push(isNull(identityAlias.validTo));
    } else {
      // Half-open, matching EPIC-007: a mapping that ended at T was not in force
      // *at* T, so a reassignment at an instant has exactly one answer.
      filters.push(sql`${identityAlias.validFrom} <= ${at}`);
      filters.push(sql`(${identityAlias.validTo} IS NULL OR ${identityAlias.validTo} > ${at})`);
    }

    const [row] = await this.#db
      .select()
      .from(identityAlias)
      .where(and(...filters))
      .orderBy(sql`${identityAlias.validFrom} DESC`)
      .limit(1);
    return row === undefined ? undefined : toAlias(row);
  }

  /** Every identity an actor is currently known by. */
  async aliasesOf(actorId: string, includeHistorical = false): Promise<IdentityAlias[]> {
    const filters = [eq(identityAlias.actorId, actorId)];
    if (!includeHistorical) filters.push(isNull(identityAlias.validTo));

    const rows = await this.#db
      .select()
      .from(identityAlias)
      .where(and(...filters))
      .orderBy(sql`${identityAlias.validFrom} DESC`);
    return rows.map(toAlias);
  }

  /**
   * Every mapping an external identity has ever had, oldest first.
   *
   * AC-6: identity history is retained when mappings change. Without this, an
   * address reassigned within an organisation would silently reattribute every
   * commit its previous owner made.
   */
  async history(system: string, externalId: string): Promise<IdentityAlias[]> {
    const rows = await this.#db
      .select()
      .from(identityAlias)
      .where(and(eq(identityAlias.system, system), eq(identityAlias.externalId, externalId)))
      .orderBy(identityAlias.validFrom);
    return rows.map(toAlias);
  }

  /**
   * Ends a mapping without deleting it.
   *
   * Used when an identity is genuinely reassigned. The old row keeps its
   * interval, so historical attribution stays correct.
   */
  async unlink(system: string, externalId: string, at: Date = new Date()): Promise<IdentityAlias | undefined> {
    const [current] = await this.#db
      .select()
      .from(identityAlias)
      .where(
        and(
          eq(identityAlias.system, system),
          eq(identityAlias.externalId, externalId),
          isNull(identityAlias.validTo),
        ),
      )
      .limit(1);

    if (current === undefined) return undefined;
    // An event ending a mapping before it began is out of order or wrong.
    if (at < current.validFrom) return toAlias(current);

    const [row] = await this.#db
      .update(identityAlias)
      .set({ validTo: at, lastIndexedAt: at })
      .where(eq(identityAlias.id, current.id))
      .returning();
    return row === undefined ? undefined : toAlias(row);
  }

  /**
   * Merges two actors into one, deliberately and with a record.
   *
   * Requires evidence, because AC-3 requires the mapping to be auditable and a
   * merge is the least reversible thing reconciliation does. Refuses to cross
   * the developer/agent boundary.
   *
   * The merged actor is **superseded, not deleted**: a
   * `entity_supersedes_entity` relationship records the merge with its own
   * temporal validity, so an id that appears in older data still resolves and
   * still leads to the survivor.
   */
  async merge(
    survivorId: string,
    mergedId: string,
    evidenceId: string,
    now: Date = new Date(),
  ): Promise<MergeResult> {
    if (survivorId === mergedId) {
      throw new FerretError(ErrorCode.IDENTITY_INVALID, 'An actor cannot be merged into itself', {
        details: { actorId: survivorId },
      });
    }

    const survivorClass = await this.#actorClassOf(survivorId);
    const mergedClass = await this.#actorClassOf(mergedId);
    assertSameActorClass(survivorClass, mergedClass, { survivorId, mergedId });

    try {
      return await this.#db.transaction(async (tx) => {
        const aliases = await tx
          .select()
          .from(identityAlias)
          .where(and(eq(identityAlias.actorId, mergedId), isNull(identityAlias.validTo)));

        const moved: string[] = [];
        for (const alias of aliases) {
          // Close the mapping to the merged actor and open one to the survivor,
          // rather than repointing the row. The history of who held the identity
          // is exactly what AC-6 requires be kept.
          await tx.update(identityAlias).set({ validTo: now, lastIndexedAt: now }).where(eq(identityAlias.id, alias.id));

          const replacement = createIdentityAlias(
            {
              system: alias.system,
              externalId: alias.externalId,
              actorId: survivorId,
              actorClass: survivorClass,
              evidenceId,
              ...(alias.confidence === null ? {} : { confidence: alias.confidence }),
              validFrom: now.toISOString(),
            },
            now,
          );

          await tx
            .insert(identityAlias)
            .values({
              id: replacement.id,
              system: replacement.system,
              externalId: replacement.externalId,
              actorId: survivorId,
              actorClass: survivorClass,
              evidenceId,
              confidence: replacement.confidence ?? null,
              validFrom: now,
              validTo: null,
              firstIndexedAt: now,
              lastIndexedAt: now,
            })
            .onConflictDoNothing();

          moved.push(replacement.id);
        }

        await tx
          .update(entity)
          .set({ lifecycle: LifecycleState.SUPERSEDED, lastIndexedAt: now })
          .where(eq(entity.id, mergedId));

        return { survivorId, mergedId, movedAliases: moved };
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.identity.merge');
    } finally {
      // Recorded outside the transaction so a relationship failure cannot roll
      // back a completed merge; the relationship is a description of what
      // happened, not part of making it happen.
      await this.#relationships
        .assert({
          fromId: mergedId,
          type: RelationshipType.ENTITY_SUPERSEDES_ENTITY,
          toId: survivorId,
          validFrom: now.toISOString(),
          sourceSystem: 'ferret',
          sourceId: evidenceId,
          metadata: { reason: 'identity-reconciliation' },
        })
        .catch(() => undefined);
    }
  }

  /** Actors that would collide if this identity were linked to `actorId`. */
  async collisionFor(
    system: string,
    externalId: string,
    actorId: string,
  ): Promise<IdentityCollision | undefined> {
    const current = await this.resolve(system, externalId);
    if (current === undefined || current.actorId === actorId) return undefined;

    const proposedClass = await this.#actorClassOf(actorId);
    return {
      system,
      externalId,
      existingActorId: current.actorId,
      proposedActorId: actorId,
      crossesActorClass: current.actorClass !== proposedClass,
    };
  }

  async #actorClassOf(actorId: string): Promise<ActorClass> {
    const [row] = await this.#db
      .select({ kind: entity.kind })
      .from(entity)
      .where(eq(entity.id, actorId))
      .limit(1);

    if (row === undefined) {
      throw new FerretError(ErrorCode.ENTITY_NOT_FOUND, `No actor with id ${actorId}`, {
        details: { actorId },
        remediation: 'Index the developer or agent before linking identities to it.',
      });
    }

    const actorClass = actorClassForKind(row.kind);
    if (actorClass === undefined) {
      throw new FerretError(
        ErrorCode.IDENTITY_INVALID,
        `Entity ${actorId} is a ${row.kind}, which is not an actor`,
        {
          details: { actorId, kind: row.kind },
          remediation: `Identities may only be linked to a ${EntityKind.DEVELOPER} or an ${EntityKind.AGENT}.`,
        },
      );
    }
    return actorClass;
  }

  /**
   * Refuses a mapping that disagrees with the entity it points at.
   *
   * A caller claiming `actorClass: 'developer'` for an entity stored as an agent
   * would create a record that contradicts itself, and the contradiction would
   * surface much later as a wrong answer about who did something.
   */
  async #assertActorClassMatchesEntity(actorId: string, claimed: ActorClass): Promise<void> {
    const actual = await this.#actorClassOf(actorId);
    if (actual !== claimed) {
      throw new FerretError(
        ErrorCode.IDENTITY_INVALID,
        `Entity ${actorId} is a ${actual}, but the alias claims it is a ${claimed}`,
        {
          details: { actorId, actual, claimed },
          remediation: 'Correct the actorClass, or link the identity to the right actor.',
        },
      );
    }
  }
}
