import {
  authorityFor,
  createEntity,
  createEvidence,
  createRelationship,
  EvidenceMethod,
  type CanonicalEntity,
  type CanonicalEvidence,
  type CanonicalRelationship,
  type EntityInput,
  type EntitySource,
  type EvidenceInput,
  type RelationshipInput,
} from '../../domain/index.js';

/**
 * Emitting canonical knowledge, with attribution attached by construction.
 *
 * A provider's output is only useful if Ferret can later say where it came from
 * and what produced it. EPIC-008 makes both mandatory fields; nothing yet made
 * them *hard to omit*, and "every provider author remembers to pass
 * `producerVersion`" is a policy that holds until the sixth provider.
 *
 * The cost of forgetting is not a crash. It is that Governance §21's central
 * question — *"re-extract everything the old PDF parser touched"* — quietly
 * becomes unanswerable, months later, for the subset of evidence one provider
 * emitted without a version. So the identity is supplied once, when the emitter
 * is constructed, and every record it produces carries it.
 *
 * The emitter adds nothing else. Validation, identity derivation, redaction and
 * hashing all stay in EPIC-006/007/008 where they are already tested — this is a
 * convenience over them, not a second implementation of them.
 */

/** Who is emitting, and at what version. */
export interface EmissionIdentity {
  /**
   * The external system observed — `git`, `github`, `jira`.
   *
   * Deliberately the *system*, not the provider. Two providers reading the same
   * GitHub repository should produce evidence that deduplicates, and it only
   * does if they agree on what they were looking at.
   */
  readonly sourceSystem: string;
  /** What produced the record. Conventionally the provider id. */
  readonly producer: string;
  /**
   * The producer's version.
   *
   * Governance §21. A parser whose output changed between versions produced
   * genuinely different evidence, and conflating them makes re-extraction
   * unresolvable.
   */
  readonly producerVersion: string;
  /**
   * This provider is the system of record for what it observes — EPIC-045.
   *
   * Raises the authority of *observed* and *parsed* evidence to
   * `SYSTEM_OF_RECORD`; it cannot promote an inference or a model's output,
   * because authority is a property of how a fact was obtained rather than of
   * who is claiming it.
   *
   * Off by default. A provider says this when it reads the system that owns the
   * fact — Git about a commit's contents, Jira about an issue's status — and
   * nothing is the system of record for everything.
   */
  readonly systemOfRecord?: boolean;
}

/** An entity input whose `source.system` the emitter fills in. */
export type EmittedEntityInput = Omit<EntityInput, 'source'> & {
  readonly source: Omit<EntitySource, 'system'> & { readonly system?: string };
};

/** A relationship input whose `sourceSystem` the emitter fills in. */
export type EmittedRelationshipInput = Omit<RelationshipInput, 'sourceSystem'> & {
  readonly sourceSystem?: string;
};

/** An evidence input whose producer, version and system the emitter fills in. */
export type EmittedEvidenceInput = Omit<
  EvidenceInput,
  'method' | 'producer' | 'producerVersion' | 'sourceSystem'
> & {
  readonly sourceSystem?: string;
};

export class Emitter {
  readonly #identity: EmissionIdentity;

  constructor(identity: EmissionIdentity) {
    this.#identity = identity;
  }

  get identity(): EmissionIdentity {
    return this.#identity;
  }

  entity(input: EmittedEntityInput): CanonicalEntity {
    return createEntity({
      ...input,
      source: { ...input.source, system: input.source.system ?? this.#identity.sourceSystem },
    });
  }

  relationship(input: EmittedRelationshipInput, now?: Date): CanonicalRelationship {
    return createRelationship(
      { ...input, sourceSystem: input.sourceSystem ?? this.#identity.sourceSystem },
      now,
    );
  }

  /** Evidence for something read directly from the source. The strongest kind. */
  observed(input: EmittedEvidenceInput): CanonicalEvidence {
    return this.#evidence(EvidenceMethod.OBSERVED, input);
  }

  /** Evidence extracted from source content by a parser. */
  parsed(input: EmittedEvidenceInput): CanonicalEvidence {
    return this.#evidence(EvidenceMethod.PARSED, input);
  }

  /**
   * Evidence worked out from other evidence.
   *
   * `derivedFrom` is not optional in practice — EPIC-008 rejects an inference
   * that names nothing it rests on, which is what keeps "why do you believe
   * this" answerable.
   */
  inferred(input: EmittedEvidenceInput & { readonly derivedFrom: readonly string[] }): CanonicalEvidence {
    return this.#evidence(EvidenceMethod.INFERRED, input);
  }

  /** Evidence produced by a model. Never conflated with observation. */
  generated(input: EmittedEvidenceInput & { readonly derivedFrom: readonly string[] }): CanonicalEvidence {
    return this.#evidence(EvidenceMethod.GENERATED, input);
  }

  /**
   * Evidence about an entity this provider just emitted.
   *
   * The common shape: the entity is the subject, the source content hash is the
   * entity's, and the statement is whatever the source said. Saves the caller
   * threading three fields it already has, and — more usefully — makes the
   * staleness link automatic, since evidence whose `sourceContentHash` no longer
   * matches its subject is exactly what "stale" means.
   */
  about(
    entity: CanonicalEntity,
    field: string,
    statement: unknown,
    options: Omit<EmittedEvidenceInput, 'subjectId' | 'field' | 'statement'> = {},
  ): CanonicalEvidence {
    return this.observed({
      sourceContentHash: entity.contentHash,
      sourceId: entity.source.id,
      ...(entity.source.url === undefined ? {} : { sourceUrl: entity.source.url }),
      ...options,
      subjectId: entity.id,
      field,
      statement,
    });
  }

  #evidence(method: EvidenceMethod, input: EmittedEvidenceInput): CanonicalEvidence {
    return createEvidence({
      ...input,
      method,
      producer: this.#identity.producer,
      producerVersion: this.#identity.producerVersion,
      sourceSystem: input.sourceSystem ?? this.#identity.sourceSystem,
      // EPIC-045. Before this, every record defaulted to authority 0, so
      // `preferredEvidence` ranked by authority first and that comparison never
      // discriminated — every source in Ferret was equally authoritative. A
      // caller that has already decided a rank keeps it.
      authority:
        input.authority ??
        authorityFor(method, {
          ...(this.#identity.systemOfRecord === undefined
            ? {}
            : { systemOfRecord: this.#identity.systemOfRecord }),
        }),
    });
  }
}

export interface BatchCounts {
  readonly entities: number;
  readonly relationships: number;
  readonly evidence: number;
  /** Records that were emitted more than once and collapsed. */
  readonly duplicates: number;
}

/**
 * An emitter that accumulates what it produces, deduplicating by canonical id.
 *
 * Governance §10 requires re-ingesting unchanged content to be a no-op. Canonical
 * ids are already content-derived, so two emissions of the same fact *are* the
 * same record — but a provider that walks a commit and its parent will emit the
 * same author entity twice, and passing both to storage means two upserts, two
 * round trips and two chances to interleave badly with a concurrent writer.
 *
 * Collapsing at the point of emission is cheaper than collapsing in the database
 * and, unlike the database, can report how often it happened — a provider whose
 * duplicate count is most of its output is walking something twice.
 */
export class BatchEmitter extends Emitter {
  readonly #entities = new Map<string, CanonicalEntity>();
  readonly #relationships = new Map<string, CanonicalRelationship>();
  readonly #evidence = new Map<string, CanonicalEvidence>();
  #duplicates = 0;

  override entity(input: EmittedEntityInput): CanonicalEntity {
    const value = super.entity(input);
    this.#record(this.#entities, value.id, value);
    return value;
  }

  override relationship(input: EmittedRelationshipInput, now?: Date): CanonicalRelationship {
    const value = super.relationship(input, now);
    this.#record(this.#relationships, value.id, value);
    return value;
  }

  override observed(input: EmittedEvidenceInput): CanonicalEvidence {
    return this.#recordEvidence(super.observed(input));
  }

  override parsed(input: EmittedEvidenceInput): CanonicalEvidence {
    return this.#recordEvidence(super.parsed(input));
  }

  override inferred(input: EmittedEvidenceInput & { readonly derivedFrom: readonly string[] }): CanonicalEvidence {
    return this.#recordEvidence(super.inferred(input));
  }

  override generated(input: EmittedEvidenceInput & { readonly derivedFrom: readonly string[] }): CanonicalEvidence {
    return this.#recordEvidence(super.generated(input));
  }

  get entities(): readonly CanonicalEntity[] {
    return [...this.#entities.values()];
  }

  get relationships(): readonly CanonicalRelationship[] {
    return [...this.#relationships.values()];
  }

  get evidence(): readonly CanonicalEvidence[] {
    return [...this.#evidence.values()];
  }

  get counts(): BatchCounts {
    return {
      entities: this.#entities.size,
      relationships: this.#relationships.size,
      evidence: this.#evidence.size,
      duplicates: this.#duplicates,
    };
  }

  get size(): number {
    return this.#entities.size + this.#relationships.size + this.#evidence.size;
  }

  clear(): void {
    this.#entities.clear();
    this.#relationships.clear();
    this.#evidence.clear();
    this.#duplicates = 0;
  }

  #recordEvidence(value: CanonicalEvidence): CanonicalEvidence {
    this.#record(this.#evidence, value.id, value);
    return value;
  }

  #record<T>(into: Map<string, T>, id: string, value: T): void {
    if (into.has(id)) {
      this.#duplicates += 1;
      return;
    }
    into.set(id, value);
  }
}
