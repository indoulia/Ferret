import { EntityKind, type CanonicalEntity } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import type { SyncCursors } from '../indexing/ports.js';
import type { Logger } from '../logging/index.js';
import {
  sourceIdentityKey,
  type AcquiredRecord,
  type AcquisitionRequest,
  type SkippedSourceRecord,
  type SourceConnector,
  type SourceIdentity,
} from '../providers/contracts/source-connector.js';
import { throwIfAborted } from '../providers/sdk/cancellation.js';
import { Emitter } from '../providers/sdk/emit.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';
import { VERSION } from '../version.js';

import {
  addWrites,
  writeContribution,
  NO_WRITES,
  type ContributionWriters,
  type ContributionWrites,
} from './write.js';

/**
 * The ingestion path every connector shares — EPIC-119.
 *
 * `ferret sync` (EPIC-113) proved the shape: read a cursor, enumerate under a
 * page bound, model what came back, write entities then relationships then
 * evidence, advance the cursor only if the pass finished. What it did not do is
 * make that shape *reusable* — every line of it names issues, pull requests and
 * reviews, so the second kind of source would have got a second copy.
 *
 * This is the same pass with the tracker taken out of it. It knows about pages,
 * cursors, ordering and failure; it knows nothing about what a record is. What
 * a record is, is the connector's business, and it stays there.
 *
 * It also knows that a pass and a window are not the same thing. The page bound
 * ends a *pass*; the *window* — what `since` covers — closes only when the
 * source runs out of pages, however many passes that takes. See
 * {@link DEFAULT_INGEST_PAGE_LIMIT}.
 *
 * **Nothing here reasons.** It fetches what it is told to fetch, in the order
 * the contract fixes, and stops. There is no planner, no retry policy of its
 * own, no model call, and no decision that is not a bound the caller passed in.
 */

/** What produced a connector's cursor. Distinct from `ferret.sync`'s. */
export const INGEST_PRODUCER = 'ferret.connector';

/**
 * Pages read from one source before a pass stops asking.
 *
 * A bound, not a preference — the reason `ferret sync` gives: an unbounded
 * enumeration spends somebody else's rate limit until it runs out.
 *
 * A pass that stops here reports `truncated`, does **not** advance the window
 * (`since` stays where it was, so nothing between the two is skipped) and
 * persists the page cursor it stopped at, so the next pass **resumes** from
 * there rather than re-reading the same first pages.
 *
 * Not resuming was the defect: the bound is per pass, so a source holding more
 * than `pageLimit × pageSize` records re-read the same bounded prefix on every
 * pass, for ever, and the remainder was never reached — while each pass wrote
 * rows and looked like progress. Raising the bound only moves the source size
 * at which that happens; the continuation is what removes it.
 */
export const DEFAULT_INGEST_PAGE_LIMIT = 20;

export interface IngestOptions {
  /** The source to read, in the connector's own words: `owner/repo`, `FER`. */
  readonly resource: string;
  /** Ignore the stored position and read everything the source will return. */
  readonly full?: boolean;
  /** Acquire and normalize, and write nothing. */
  readonly dryRun?: boolean;
  readonly pageLimit?: number;
  readonly pageSize?: number;
}

export interface IngestCounts {
  readonly pages: number;
  readonly records: number;
}

export interface IngestReport {
  readonly connectorId: string;
  readonly system: string;
  readonly identity: SourceIdentity;
  /** The stable key the source entity is derived from. */
  readonly identityKey: string;
  /** The entity every record of this pass was scoped to. */
  readonly sourceEntityId: string;
  /** What the pass asked for, or `undefined` for a full read. */
  readonly since: string | undefined;
  /** The source said nothing had changed. Not the same as nothing existing. */
  readonly unchanged: boolean;
  readonly counts: IngestCounts;
  readonly writes: ContributionWrites;
  /** Records the connector could not map. One bad record must not fail a source. */
  readonly skipped: readonly SkippedSourceRecord[];
  /**
   * A page limit stopped the enumeration short, so the window did not advance.
   *
   * The next pass continues from {@link continuation} rather than re-reading
   * this one's first page — the pass is unfinished, not restarted.
   */
  readonly truncated: boolean;
  /** The page cursor this pass resumed from, or `undefined` for a fresh window. */
  readonly resumedFrom: string | undefined;
  /**
   * The page cursor persisted for the next pass to continue from.
   *
   * `undefined` means the window finished: there is nothing left to continue,
   * and any stored continuation has been cleared.
   */
  readonly continuation: string | undefined;
  /** The instant the next pass will ask from, or `undefined` when not advanced. */
  readonly cursorAdvancedTo: string | undefined;
  readonly dryRun: boolean;
}

/** What the ingestor needs. Ports, for the reason `indexing/ports.ts` gives. */
export interface IngestDependencies extends ContributionWriters {
  /** Where a source got to. Absent means every pass is a full read. */
  readonly cursors?: SyncCursors;
  readonly logger?: Logger;
}

/** The position a connector cursor carries. Opaque to EPIC-075, read only here. */
interface IngestPosition {
  /** The instant the last completed pass started. The next `since`. */
  readonly syncedAt?: string;
  /**
   * The page cursor an unfinished pass stopped at, for the next one to resume.
   *
   * Present only between the truncation and the pass that finishes the window;
   * a completed pass writes a position without it, and because the cursor store
   * replaces a position rather than merging into it, that clears the
   * continuation by construction rather than by remembering to delete it.
   *
   * The connector's own token, opaque here — the same value
   * {@link AcquisitionPage.cursor} carried, handed straight back as
   * {@link AcquisitionRequest.cursor}.
   */
  readonly pageCursor?: string;
  /**
   * The instant the *window* began, which is not the instant this pass began.
   *
   * A window spanning several passes must ask the next one from where the
   * first started, not from where the last continuation ran: a record edited
   * after the window opened but inside a page an earlier pass already read
   * would otherwise fall outside both windows and never be re-read. Carried
   * across continuations for that reason, and only while one is open.
   */
  readonly passStartedAt?: string;
  /** Whatever the connector asked to keep. Handed back untouched. */
  readonly checkpoint?: Readonly<Record<string, unknown>>;
}

export class SourceIngestor {
  readonly #connector: SourceConnector;
  readonly #writers: ContributionWriters;
  readonly #cursors: SyncCursors | undefined;
  readonly #logger: Logger | undefined;
  readonly #emitter: Emitter;

  constructor(connector: SourceConnector, dependencies: IngestDependencies) {
    this.#connector = connector;
    this.#writers = {
      entities: dependencies.entities,
      relationships: dependencies.relationships,
      evidence: dependencies.evidence,
    };
    this.#cursors = dependencies.cursors;
    this.#logger = dependencies.logger;
    this.#emitter = new Emitter({
      sourceSystem: connector.system,
      producer: connector.connectorId,
      producerVersion: VERSION,
      ...(connector.systemOfRecord === undefined
        ? {}
        : { systemOfRecord: connector.systemOfRecord }),
    });
  }

  /**
   * The entity every record of a source hangs from.
   *
   * A `repository` because that is the kind Ferret's canonical model already
   * uses for "the thing records belong to", and EPIC-119 does not add an entity
   * kind: a Confluence space and a GitHub repository are the same shape of
   * fact — a bounded collection of records with an address — and adding a
   * `source` kind would have made every existing query that scopes by
   * repository miss half the graph.
   *
   * Written as a placeholder on every pass, `ifAbsent`, exactly as
   * `ProjectSynchronizer` writes its repository: before this the id a
   * contribution was scoped to named no row at all, which is the dangling scope
   * EPIC-072 §8.10 fixed one level down.
   */
  sourceEntityFor(identity: SourceIdentity): CanonicalEntity {
    return this.#emitter.entity({
      kind: EntityKind.REPOSITORY,
      source: { id: sourceIdentityKey(identity) },
      attributes: { name: identity.resource },
    });
  }

  async ingest(
    options: IngestOptions,
    context: ProviderOperationContext,
  ): Promise<IngestReport> {
    const resource = options.resource.trim();
    if (resource === '') {
      throw new FerretError(ErrorCode.USAGE, 'A source to ingest must be named', {
        details: { connector: this.#connector.connectorId },
        remediation:
          'Pass the resource the connector addresses — `owner/repo`, a project key, a space key.',
      });
    }

    const identity = this.#connector.identify(resource);
    const identityKey = sourceIdentityKey(identity);
    const sourceEntity = this.sourceEntityFor(identity);
    const pageLimit = options.pageLimit ?? DEFAULT_INGEST_PAGE_LIMIT;

    // Read the position first, and take *this pass's start instant* as what the
    // next one asks from — not the newest record seen. A record edited while
    // this pass was reading has an instant inside the window and would fall
    // outside the next one. The overlap re-reads a boundary record, which
    // EPIC-080 already guarantees is free: the same input twice writes one row.
    const startedAt = new Date();
    // Keyed by the **source entity id**, not by the identity key: the cursor
    // store's scope is a canonical id, and a `wiki::host::resource` string is
    // not one. Found by running a connector against the real database, where
    // PostgreSQL answered `22P02` — the unit suite's cursor fake took any
    // string and could not have caught it.
    const stored = options.full === true ? undefined : await this.#position(sourceEntity.id);
    const since = stored?.syncedAt;
    // Where an earlier pass stopped, and when the window it belongs to opened.
    // A full read ignores both, so `--full` also clears a stuck continuation.
    const resumedFrom = stored?.pageCursor;
    const windowStartedAt =
      resumedFrom === undefined ? startedAt.toISOString() : (stored?.passStartedAt ?? startedAt.toISOString());

    const records: AcquiredRecord[] = [];
    let cursor: string | undefined = resumedFrom;
    let checkpoint = stored?.checkpoint;
    let pages = 0;
    let truncated = false;
    let unchanged = false;
    // Set when the window is *not* finished: the page cursor the next pass must
    // continue from. `undefined` at the end means the source was read to the end.
    let continuation: string | undefined;

    for (;;) {
      throwIfAborted(context.signal, 'ingest');
      const request: AcquisitionRequest = {
        identity,
        ...(cursor === undefined ? {} : { cursor }),
        ...(since === undefined ? {} : { since }),
        ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      };
      const page = await this.#connector.acquire(request, context);
      pages += 1;

      if (page.checkpoint !== undefined) checkpoint = page.checkpoint;

      // "Nothing changed" is not "nothing exists". Reported separately, and it
      // still counts as a completed pass — the cursor advances, because the
      // source has told us our position is current.
      //
      // Except mid-continuation, where it contradicts itself: the tail this
      // window has not read yet is exactly what the question was about. Keeping
      // the continuation there costs a re-read; clearing it would drop every
      // record past the cursor and call the window finished.
      if (page.unchanged === true) {
        unchanged = true;
        continuation = resumedFrom;
        break;
      }

      for (const record of page.records) records.push(record);

      cursor = page.cursor;
      if (cursor === undefined) break;
      if (pages >= pageLimit) {
        truncated = true;
        continuation = cursor;
        break;
      }
    }

    const contribution = this.#connector.normalize(records, {
      identity,
      sourceEntityId: sourceEntity.id,
      emitter: this.#emitter,
    });

    const writes =
      options.dryRun === true
        ? NO_WRITES
        : addWrites(
            await writeContribution(
              {
                entities: [sourceEntity],
                relationships: [],
                evidence: [],
                placeholderEntityIds: [sourceEntity.id],
              },
              this.#writers,
              startedAt,
              context,
            ),
            await writeContribution(
              {
                entities: contribution.entities,
                relationships: contribution.relationships,
                evidence: contribution.evidence,
                placeholderEntityIds: contribution.placeholderEntityIds ?? [],
              },
              this.#writers,
              startedAt,
              context,
            ),
          );

    // EPIC-031's rule, which EPIC-075 gave a separate verb so it could be
    // applied here too: a pass that did not finish must not leave a position
    // claiming it did. A dry run and a pass with no cursor store write nothing
    // at all; everything else writes one of two positions.
    //
    // The window is what advances or does not — `syncedAt`, the next `since`.
    // An unfinished pass leaves it exactly where it was and files the page
    // cursor beside it, so the next pass asks the same question from further
    // along instead of from the beginning. That is the difference between a
    // bound and a ceiling: a bound is per pass, and the window still closes.
    let cursorAdvancedTo: string | undefined;
    if (options.dryRun !== true && this.#cursors !== undefined) {
      const position: IngestPosition =
        continuation === undefined
          ? {
              // The window's own start, not this pass's: a continued window
              // covers everything from when it opened, with no gap in between.
              syncedAt: windowStartedAt,
              ...(checkpoint === undefined ? {} : { checkpoint }),
            }
          : {
              ...(since === undefined ? {} : { syncedAt: since }),
              pageCursor: continuation,
              passStartedAt: windowStartedAt,
              ...(checkpoint === undefined ? {} : { checkpoint }),
            };
      await this.#cursors.advance(INGEST_PRODUCER, sourceEntity.id, { ...position }, startedAt);
      // Only a finished window has advanced. An open continuation reports
      // `undefined` here exactly as a truncated pass always has.
      if (continuation === undefined) cursorAdvancedTo = position.syncedAt;
    }

    const report: IngestReport = {
      connectorId: this.#connector.connectorId,
      system: this.#connector.system,
      identity,
      identityKey,
      sourceEntityId: sourceEntity.id,
      since,
      unchanged,
      counts: { pages, records: records.length },
      writes,
      skipped: contribution.skipped ?? [],
      truncated,
      resumedFrom,
      continuation: options.dryRun === true ? undefined : continuation,
      cursorAdvancedTo,
      dryRun: options.dryRun === true,
    };

    this.#logger?.info(
      {
        operation: 'connector.ingest',
        connector: report.connectorId,
        // The identity, never a credential and never a record body: this line
        // reaches an operator's terminal and a log file.
        source: identityKey,
        records: report.counts.records,
        truncated,
        // Whether a window is open, never the token itself: a continuation is
        // connector-defined and can carry a signed value, and this line reaches
        // a log file.
        resumed: resumedFrom !== undefined,
        continues: report.continuation !== undefined,
        unchanged,
      },
      `Ingested ${identityKey} through ${report.connectorId}`,
    );

    return report;
  }

  async #position(scopeId: string): Promise<IngestPosition | undefined> {
    const cursor = await this.#cursors?.read(scopeId);
    if (cursor === undefined) return undefined;
    const syncedAt = cursor.position['syncedAt'];
    const pageCursor = cursor.position['pageCursor'];
    const passStartedAt = cursor.position['passStartedAt'];
    const checkpoint = cursor.position['checkpoint'];
    return {
      ...(typeof syncedAt === 'string' ? { syncedAt } : {}),
      // An empty string is not a cursor. A connector that produced one would
      // resume from "the beginning" while claiming to be mid-window, which is
      // the truncation defect wearing a continuation's clothes.
      ...(typeof pageCursor === 'string' && pageCursor !== '' ? { pageCursor } : {}),
      ...(typeof passStartedAt === 'string' ? { passStartedAt } : {}),
      ...(isRecord(checkpoint) ? { checkpoint } : {}),
    };
  }
}

/** One source's outcome in a multi-source pass. */
export type IngestOutcome =
  | { readonly status: 'ingested'; readonly report: IngestReport }
  | {
      readonly status: 'failed';
      readonly connectorId: string;
      readonly resource: string;
      /** The error's code, not its message: a code is a fact about the failure. */
      readonly code: string;
      readonly message: string;
    };

export interface IngestRequest {
  readonly connector: SourceConnector;
  readonly options: IngestOptions;
}

/**
 * Ingest several sources, isolating each — EPIC-119 AC-5, EPIC-093's rule.
 *
 * A source that throws is reported and stepped over. It does not stop the pass,
 * and — the part that actually matters — it cannot corrupt anything it does not
 * own: its cursor is not advanced (so it re-reads next time rather than skipping
 * what it never saw), its own partial writes are idempotent upserts that the
 * next pass re-asserts, and no other source's records are touched at all,
 * because nothing is deleted and every write is keyed by its own source.
 *
 * Cancellation is deliberately **not** isolated. An aborted run is the runtime
 * shutting down, not a source misbehaving, and swallowing it would turn "stop
 * now" into "carry on through the remaining forty sources".
 */
export async function ingestSources(
  requests: readonly IngestRequest[],
  dependencies: IngestDependencies,
  context: ProviderOperationContext,
): Promise<readonly IngestOutcome[]> {
  const outcomes: IngestOutcome[] = [];

  for (const request of requests) {
    throwIfAborted(context.signal, 'ingest');
    try {
      const ingestor = new SourceIngestor(request.connector, dependencies);
      outcomes.push({ status: 'ingested', report: await ingestor.ingest(request.options, context) });
    } catch (error) {
      if (context.signal.aborted) throw error;
      // The error's own code when it has one, and `UNKNOWN` otherwise — which
      // is the honest answer for a throw Ferret did not classify. Naming a
      // plausible cause here would put a fact in the report that nothing
      // established.
      const code = error instanceof FerretError ? error.code : ErrorCode.UNKNOWN;
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger?.warn(
        {
          operation: 'connector.ingest',
          connector: request.connector.connectorId,
          source: request.options.resource,
          code,
        },
        `Source failed and was isolated: ${request.connector.connectorId}`,
      );
      outcomes.push({
        status: 'failed',
        connectorId: request.connector.connectorId,
        resource: request.options.resource,
        code,
        message,
      });
    }
  }

  return outcomes;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
