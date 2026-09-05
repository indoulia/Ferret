import type { CanonicalEntity, CanonicalEvidence, CanonicalRelationship } from '../../domain/index.js';
import type { Emitter } from '../sdk/emit.js';
import type { ProviderOperationContext } from '../sdk/operation.js';

/**
 * The `source.connector` capability — EPIC-119.
 *
 * Ferret already had two source contracts and no *common* one.
 * `source.repository` (EPIC-017) is shaped around a Git working tree;
 * `source.project` (EPIC-021, EPIC-071) is shaped around a tracker's issues and
 * pull requests. Both are good contracts for what they cover, and neither is
 * something a third kind of source can implement: a wiki page is not a branch
 * and a build is not a review. Adding a source therefore meant adding an
 * ingestion path — acquire it, model it, write it in the right order, remember
 * where it got to — and `ferret sync` is that path written once, for trackers.
 *
 * This is the boundary that stops the third one being written again. It is
 * deliberately **thin**: three verbs, and nothing that decides anything.
 *
 * ```
 * identify → acquire → normalize
 * ```
 *
 * - **identify** — what source instance is this, stably, across runs and hosts.
 * - **acquire** — hand back records, verbatim, a page at a time.
 * - **normalize** — turn those records into Ferret's *existing* canonical
 *   model: entities, relationships and evidence, emitted through EPIC-008's
 *   `Emitter` so provenance is attached by construction rather than by
 *   remembering.
 *
 * What is deliberately **not** here:
 *
 * - **No storage.** A connector never writes. `SourceIngestor` writes, through
 *   the same ports `RepositoryIndexer` and `ProjectSynchronizer` already use,
 *   in the same order, with the same idempotence. A connector that stored its
 *   own output would be the parallel ingestion model this Epic exists to avoid.
 * - **No schedule, no subscription, no webhook.** Change *detection* is left as
 *   the two fields it needs — {@link AcquisitionRequest.since} and
 *   {@link AcquisitionRequest.cursor} — and a connector that has neither simply
 *   re-reads. Realtime ingestion is a later Epic and would not change this
 *   contract, which is the test of whether the seam was cut in the right place.
 * - **No reasoning.** A connector transports and maps. It does not decide what
 *   to fetch next, call a model, or act on what it read.
 */

/** The version of the connector contract itself. */
export const SOURCE_CONNECTOR_CONTRACT_VERSION = 1;

/** Operation names, for a connector declaring partial support. */
export const ConnectorOperation = {
  IDENTIFY: 'identify',
  ACQUIRE: 'acquire',
  NORMALIZE: 'normalize',
} as const;

export type ConnectorOperation = (typeof ConnectorOperation)[keyof typeof ConnectorOperation];

/**
 * Which source instance, exactly.
 *
 * Three parts because two are not enough and four is guessing. `system` is the
 * kind of thing — `github`, `jira`, `confluence`. `instance` is *which
 * deployment of it* — `github.com`, `acme.atlassian.net` — and is what keeps
 * two companies' `PROJ` boards apart; a connector reading a single hosted
 * service still names it rather than leaving it blank, because "unspecified"
 * and "the public one" become the same value the moment somebody self-hosts.
 * `resource` is the addressable thing within that deployment: `owner/repo`,
 * `FER`, a space key.
 *
 * **`instance` must never carry a credential.** A base URL read from
 * configuration carries a token more often than anyone expects, and this value
 * is stored, logged and shown — the same rule `RepositoryRemote.url` states.
 */
export interface SourceIdentity {
  readonly system: string;
  readonly instance: string;
  readonly resource: string;
}

/** Separator chosen so the parts cannot be confused with a path or a URL. */
const IDENTITY_SEPARATOR = '::';

/**
 * The stable key a source instance is remembered by.
 *
 * Deterministic and total: the same identity produces the same key on every
 * host, in every process, for ever. It is the source entity's `source.id`, and
 * therefore what that entity's canonical id — and the sync cursor filed under
 * it — ultimately derive from. A change to this function re-creates every
 * source entity and orphans every cursor, so treat it as a stored format rather
 * than a formatting helper.
 *
 * The parts are lowercased because hostnames and project keys arrive in
 * whatever case a user typed, and `Github.com` and `github.com` are not two
 * sources. They are *not* otherwise normalised: trimming a trailing slash or
 * resolving a redirect would be Ferret deciding two addresses are the same
 * thing, which is the connector's judgement to make and not this function's.
 */
export function sourceIdentityKey(identity: SourceIdentity): string {
  return [identity.system, identity.instance, identity.resource]
    .map((part) => part.trim().toLowerCase())
    .join(IDENTITY_SEPARATOR);
}

/**
 * What a source says about a record, in terms Ferret shares across sources.
 *
 * Everything is optional because every field of it is absent somewhere: a wiki
 * page has no labels, a build has no title worth the name, and a system that
 * reports no modification time is common enough that inventing one would be
 * worse than admitting it. `attributes` carries whatever else the source said
 * that the connector wants to keep; it is data, never instructions.
 */
export interface SourceRecordMetadata {
  readonly title?: string;
  readonly url?: string;
  /** ISO-8601, as the source reported it. Never re-derived here. */
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /**
   * The source's own version marker — an ETag, a revision number, a digest.
   *
   * Carried so a later change-detection Epic has something to compare without
   * a contract change. Ferret does not interpret it.
   */
  readonly version?: string;
  readonly labels?: readonly string[];
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * One thing acquired from a source, before Ferret has an opinion about it.
 *
 * `payload` is **untrusted content a stranger wrote** and is carried verbatim.
 * It is never interpreted at this layer; the connector's own `normalize` is the
 * only thing that reads it, and the MCP surface already says as much of
 * everything it renders.
 */
export interface AcquiredRecord {
  /**
   * Stable within the source instance, and stable across runs.
   *
   * This is what makes repeated ingestion idempotent rather than duplicating:
   * the canonical entity id is derived from it, so the same record acquired
   * twice is one row. A connector that synthesises an id per run — an array
   * index, a timestamp — breaks that, and `ingest-determinism` is the test
   * that catches it.
   */
  readonly id: string;
  /** The connector's own word for what this is: `issue`, `page`, `build`. */
  readonly kind: string;
  readonly payload: unknown;
  readonly metadata: SourceRecordMetadata;
}

/** What a connector is asked for. */
export interface AcquisitionRequest {
  readonly identity: SourceIdentity;
  /** Continue from a previous page. Opaque, and connector-defined. */
  readonly cursor?: string;
  /**
   * Only records changed at or after this ISO-8601 instant.
   *
   * The whole of change detection, for now. A connector whose source cannot
   * filter ignores it and returns everything; the ingestion is idempotent
   * either way, so the cost of ignoring it is traffic rather than correctness.
   */
  readonly since?: string;
  /** A ceiling the connector may lower and must not raise. */
  readonly pageSize?: number;
}

/**
 * One page of acquisition.
 *
 * `unchanged` is the conditional answer — the source said nothing has changed
 * since `since`, which is *not* the same fact as an empty page. Collapsing the
 * two would make "there is nothing" and "nothing moved" indistinguishable, and
 * `source.project` already refused that conflation for the same reason.
 */
export interface AcquisitionPage {
  readonly records: readonly AcquiredRecord[];
  /** Absent means this was the last page. */
  readonly cursor?: string;
  readonly unchanged?: boolean;
  /**
   * A connector-defined marker for where this page left off.
   *
   * Persisted with the cursor and handed back untouched on the next pass. It
   * exists so a source with a change feed — a Jira `updated` watermark, a
   * changelog token — has somewhere to keep its place without this contract
   * having to know what a change feed is.
   */
  readonly checkpoint?: Readonly<Record<string, unknown>>;
}

/** A record the connector could not map, and why. Never silently dropped. */
export interface SkippedSourceRecord {
  readonly id: string;
  readonly kind: string;
  readonly reason: string;
}

/**
 * What normalization produced: Ferret's existing model, nothing new.
 *
 * Three collections in the order they must be written, which is not a
 * preference — the database has foreign keys, and evidence about an entity that
 * does not exist yet fails on a source ingested for the first time.
 */
export interface SourceContribution {
  readonly entities: readonly CanonicalEntity[];
  readonly relationships: readonly CanonicalRelationship[];
  readonly evidence: readonly CanonicalEvidence[];
  /**
   * Entities emitted only so an edge has an endpoint.
   *
   * Written `ifAbsent`, so a stub carrying one attribute cannot overwrite the
   * record some other pass read in full — issue #48, one layer up.
   */
  readonly placeholderEntityIds?: readonly string[];
  /** One malformed record must not fail a source. EPIC-072 §8.9's rule. */
  readonly skipped?: readonly SkippedSourceRecord[];
}

/** What `normalize` is told about where its records are going. */
export interface NormalizationContext {
  readonly identity: SourceIdentity;
  /**
   * The entity every record of this source is scoped to.
   *
   * The ingestor writes it; a connector hangs its records off it rather than
   * inventing a second root. A dangling scope — an id that names no row — is
   * the defect EPIC-072 §8.10 fixed one level down.
   *
   * **Pass it as each emitted entity's `source.scope`.** A connector that does
   * not scope its records derives identity from the record id alone, so the
   * same page id on two wikis — or the same issue key on two Jira tenants —
   * collapses into one entity. `modelProject` has always scoped to the
   * repository for exactly this reason; the field is here so a new connector
   * inherits the rule rather than rediscovering it. Found by running an
   * unscoped connector against the real database, where two source instances
   * silently shared their documents.
   */
  readonly sourceEntityId: string;
  /**
   * Emits canonical records with provenance already attached.
   *
   * A connector must use this rather than `createEntity`/`createEvidence`
   * directly. That is the whole mechanism by which producer, producer version
   * and source system survive ingestion: supplied once, carried by every record
   * emitted, impossible to forget. EPIC-008 and the `Emitter`'s own comment.
   */
  readonly emitter: Emitter;
}

/**
 * What a `source.connector` provider implements.
 *
 * Three methods, all required, because a connector that cannot do one of them
 * is not a connector — unlike `source.project`, where a tracker genuinely has
 * no pull requests. Optionality here would only express "I did not finish
 * writing this".
 */
export interface SourceConnector {
  /** Stable and unique — conventionally the provider id. */
  readonly connectorId: string;
  /** The {@link SOURCE_CONNECTOR_CONTRACT_VERSION} this was built against. */
  readonly contractVersion: number;
  /**
   * The external system observed — `github`, `jira`.
   *
   * The *system*, not the connector: two connectors reading the same GitHub
   * repository must produce evidence that deduplicates, and it only does if
   * they agree on what they were looking at.
   */
  readonly system: string;
  /**
   * Whether this connector reads the system that owns the facts it reports.
   *
   * Raises observed evidence to `SYSTEM_OF_RECORD` authority — EPIC-045. A
   * connector scraping a mirror says no.
   */
  readonly systemOfRecord?: boolean;

  /**
   * Resolve a user's words into the identity this source is remembered by.
   *
   * Pure and total: no request, no credentials, no network. It is called before
   * anything is acquired — the cursor is keyed by its answer — so a connector
   * that needed to call out to answer it would make an unreachable source
   * indistinguishable from an unknown one.
   */
  identify(resource: string): SourceIdentity;

  acquire(
    request: AcquisitionRequest,
    context: ProviderOperationContext,
  ): Promise<AcquisitionPage>;

  /**
   * Map acquired records onto Ferret's canonical model.
   *
   * Synchronous and pure by contract: it is given records and an emitter, and
   * it returns a contribution. A `normalize` that fetched would be acquiring,
   * and would do it outside the paging and cancellation the ingestor applies.
   */
  normalize(
    records: readonly AcquiredRecord[],
    context: NormalizationContext,
  ): SourceContribution;
}

/** True when a value implements the connector contract's three verbs. */
export function isSourceConnector(value: unknown): value is SourceConnector {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SourceConnector>;
  return (
    typeof candidate.connectorId === 'string' &&
    typeof candidate.system === 'string' &&
    typeof candidate.identify === 'function' &&
    typeof candidate.acquire === 'function' &&
    typeof candidate.normalize === 'function'
  );
}
