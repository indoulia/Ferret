import { writeContribution, type ContributionGraph } from '../connectors/write.js';
import { EntityKind, type CanonicalEntity } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import type {
  EntityWriter,
  EvidenceWriter,
  RelationshipWriter,
  SyncCursors,
} from '../indexing/ports.js';
import type { Logger } from '../logging/index.js';
import {
  ProjectOperation,
  type ProjectIssue,
  type ProjectPage,
  type ProjectPullRequest,
  type ProjectQuery,
  type ProjectRateLimit,
  type ProjectReview,
  type ProjectSource,
} from '../providers/contracts/source-project.js';
import { throwIfAborted } from '../providers/sdk/cancellation.js';
import { Emitter, type EmissionIdentity } from '../providers/sdk/emit.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';

import { VERSION } from '../version.js';

import { modelProject, type SkippedRecord } from './model.js';

/**
 * `ferret sync` — EPIC-113.
 *
 * The join nothing performed. EPIC-021 and EPIC-071 read a tracker, EPIC-072
 * turns what they read into canonical knowledge, EPIC-075 remembers where a
 * source got to, and EPIC-002 stores all three kinds of record. Every part
 * existed and was tested; **nothing called them in order**, which is why
 * `ferret sync` was the last `(planned)` entry in the command surface.
 *
 * Three decisions shape this file, and each was taken by the owner rather than
 * inferred here — see `docs/EPICs/EPIC-113-Provider-Sync-Transport.md`.
 *
 * **D-113.2 — a synchronization is one explicit request.** There is no daemon,
 * no timer and no scheduler, for the reason `reconcile.ts` already gives: the
 * scheduler is `cron`, a `systemd` timer, or Task Scheduler, each of which
 * already survives a reboot and logs when it ran. What this owes them is being
 * safe to run unattended, which is a report, an exit code, and a pass that is
 * harmless when it overlaps with another.
 *
 * **D-113.1 — no credential is persisted.** A one-shot command resolves its
 * token from configuration on every invocation, through the `$secret` mechanism
 * EPIC-081 and EPIC-015 already built. Persisting one was authorised and is not
 * *needed*: with no long-lived process there is nothing for a stored credential
 * to outlive, and Ferret has no key-management mechanism to store one under.
 * Nothing at rest changed, so EPIC-081's posture is unchanged.
 *
 * **D-113.3 — a remote edit supersedes through the model that already exists.**
 * An issue whose title changed is a new observation of the same subject and
 * field. `EvidenceStore.record` closes the prior current reading and points it
 * at the new one, which is EPIC-047 §8.2 working exactly as written; the old
 * statement stays on record and stays verifiable, so "what did this ticket say
 * when we decided X" remains answerable. Nothing here re-implements that, and
 * nothing here overwrites local state a sync did not observe: the writes are
 * the same idempotent upserts the indexer performs, and a record the tracker
 * did not return is not touched at all.
 */

/** What produced a sync cursor. Distinct from the indexer's own watermark. */
export const SYNC_PRODUCER = 'ferret.sync';

/**
 * Pages read from one collection before a pass stops asking.
 *
 * A bound rather than a preference: an unbounded enumeration of a repository
 * with forty thousand issues spends somebody else's rate limit until it runs
 * out, and EPIC-021 §8.4 exists because that budget is not Ferret's. A pass
 * that stops here reports `truncated` and **does not advance the cursor**, so
 * the next pass re-reads from the same place rather than skipping what it never
 * saw.
 */
export const DEFAULT_PAGE_LIMIT = 20;

/**
 * Pull requests whose reviews one pass will fetch. One request each.
 *
 * Hitting this ceiling is **not** the same kind of incompleteness as a page
 * limit, and conflating them was a defect found by running the command against
 * Ferret's own repository: 139 pull requests, the ceiling bit, the pass reported
 * `truncated`, and the cursor therefore never advanced. Every pass would have
 * re-read the whole tracker for ever, which is precisely the incremental
 * behaviour the cursor exists to provide.
 *
 * The two are different facts. A page limit means *the enumeration stopped* —
 * there are pull requests this pass never saw, so advancing would skip them. A
 * review ceiling means *the enumeration finished* and the reviews of the last
 * few were not fetched; re-reading the same window next time would fetch the
 * same first fifty again and make no progress at all. So this one is reported
 * as `reviewsPartial` and does not block the cursor: the next pass asks only
 * for what changed, and a pull request whose reviews are wanted is read again
 * when it changes.
 */
export const DEFAULT_REVIEW_LIMIT = 50;

export interface ProjectSyncOptions {
  /** The repository or project, as the provider names it: `owner/repo`, `FER`. */
  readonly project: string;
  /**
   * Ignore the cursor and read everything the tracker will return.
   *
   * Explicit because it is expensive, and because a pass that silently decided
   * to be full would be indistinguishable from one that had lost its place —
   * the wording EPIC-031 chose for the same option, for the same reason.
   */
  readonly full?: boolean;
  /** Read the plan and write nothing. */
  readonly dryRun?: boolean;
  readonly withIssues?: boolean;
  readonly withPullRequests?: boolean;
  /** One request per pull request read this pass. Requires pull requests. */
  readonly withReviews?: boolean;
  readonly pageLimit?: number;
  readonly reviewLimit?: number;
}

export interface ProjectSyncCounts {
  readonly issues: number;
  readonly pullRequests: number;
  readonly reviews: number;
}

export interface ProjectSyncWrites {
  readonly entitiesCreated: number;
  readonly entitiesUpdated: number;
  readonly entitiesUnchanged: number;
  readonly relationships: number;
  readonly evidenceRecorded: number;
  readonly evidenceDeduplicated: number;
}

export interface ProjectSyncReport {
  readonly provider: string;
  readonly sourceSystem: string;
  readonly project: string;
  /** The repository entity every record was scoped to. */
  readonly repositoryId: string;
  /** What the pass asked the tracker for, or `undefined` for a full read. */
  readonly since: string | undefined;
  /** Collections the provider does not offer, named rather than silently empty. */
  readonly unsupported: readonly string[];
  /** Collections that answered `304 Not Modified` — nothing changed, not nothing. */
  readonly unchanged: readonly string[];
  readonly counts: ProjectSyncCounts;
  readonly writes: ProjectSyncWrites;
  /** §8.9 — one malformed record must not fail a project. */
  readonly skipped: readonly SkippedRecord[];
  /**
   * A page limit stopped an enumeration short.
   *
   * The cursor is not advanced when this is true, so nothing is skipped; the
   * next pass reads the same window again.
   */
  readonly truncated: boolean;
  /**
   * Reviews were fetched for only the first {@link DEFAULT_REVIEW_LIMIT} pull
   * requests this pass read.
   *
   * Reported, and deliberately **not** cursor-blocking — see that constant for
   * why the two kinds of incompleteness are different.
   */
  readonly reviewsPartial: boolean;
  /** The instant the next pass will ask from, or `undefined` when not advanced. */
  readonly cursorAdvancedTo: string | undefined;
  /** What the tracker last said about the budget. `undefined` when it says nothing. */
  readonly rateLimit: ProjectRateLimit | undefined;
  readonly dryRun: boolean;
}

/** What the synchronizer needs. Ports, for the reason `indexing/ports.ts` gives. */
export interface ProjectSyncDependencies {
  /** The provider, as a project source. */
  readonly source: ProjectSource;
  /** The provider id, for attribution and for the report. */
  readonly providerId: string;
  /** The external system observed — `github`, `jira`. */
  readonly sourceSystem: string;
  /** Operations the provider declared. An undeclared one is never called. */
  readonly operations: readonly string[];
  readonly entities: EntityWriter;
  readonly relationships: RelationshipWriter;
  readonly evidence: EvidenceWriter;
  /** Where this project got to. Absent means every pass is a full read. */
  readonly cursors?: SyncCursors;
  readonly logger?: Logger;
}

/** The position a sync cursor carries. Opaque to EPIC-075, read only here. */
interface SyncPosition {
  /** The instant the last completed pass started. The next `since`. */
  readonly syncedAt?: string;
  /** Conditional-request tags, keyed by collection. */
  readonly etags?: Readonly<Record<string, string>>;
}

const ISSUES = 'issues';
const PULL_REQUESTS = 'pullRequests';
const REVIEWS = 'reviews';

export class ProjectSynchronizer {
  readonly #source: ProjectSource;
  readonly #providerId: string;
  readonly #sourceSystem: string;
  readonly #operations: ReadonlySet<string>;
  readonly #entities: EntityWriter;
  readonly #relationships: RelationshipWriter;
  readonly #evidence: EvidenceWriter;
  readonly #cursors: SyncCursors | undefined;
  readonly #logger: Logger | undefined;
  readonly #emitter: Emitter;

  constructor(dependencies: ProjectSyncDependencies) {
    this.#source = dependencies.source;
    this.#providerId = dependencies.providerId;
    this.#sourceSystem = dependencies.sourceSystem;
    this.#operations = new Set(dependencies.operations);
    this.#entities = dependencies.entities;
    this.#relationships = dependencies.relationships;
    this.#evidence = dependencies.evidence;
    this.#cursors = dependencies.cursors;
    this.#logger = dependencies.logger;
    this.#emitter = new Emitter(emissionIdentity(dependencies));
  }

  /**
   * The repository entity a project's records are scoped to.
   *
   * Derived exactly as `model.ts` derives it for a referenced foreign
   * repository, so a pull request that mentions `owner/other#7` and a later
   * sync of `owner/other` agree on the identifier rather than needing
   * reconciliation. Public because the cursor is keyed by it and a caller
   * reporting on a project has no other way to name one.
   */
  repositoryIdFor(project: string): string {
    return this.#repositoryEntity(project).id;
  }

  /**
   * The repository entity a project's records hang from.
   *
   * Written as a placeholder on every pass, and the reason is that
   * `modelProject` does not write it: it takes `repositoryId` as an input and
   * scopes every record's identity to it, so before this the id a pass reported
   * named no row at all. A dangling scope is the shape of defect EPIC-072 §8.10
   * already fixed one level down — an edge whose endpoint nothing stored — and
   * `ifAbsent` keeps the guarantee that mattered there: a stub cannot overwrite
   * a repository some other pass read in full.
   */
  #repositoryEntity(project: string): CanonicalEntity {
    return this.#emitter.entity({
      kind: EntityKind.REPOSITORY,
      source: { id: project },
      attributes: { name: project },
    });
  }

  async sync(
    options: ProjectSyncOptions,
    context: ProviderOperationContext,
  ): Promise<ProjectSyncReport> {
    const project = options.project.trim();
    if (project === '') {
      throw new FerretError(ErrorCode.USAGE, 'A project to synchronize must be named', {
        details: { provider: this.#providerId },
        remediation:
          'Pass a project — `owner/repo` for GitHub, a project key for Jira — or configure `projects` in the provider options.',
      });
    }

    const repositoryId = this.repositoryIdFor(project);
    const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
    const reviewLimit = options.reviewLimit ?? DEFAULT_REVIEW_LIMIT;

    // Read the cursor before anything else, and take the pass's own start
    // instant as what the *next* pass will ask from. Not the newest
    // `updated_at` seen: a record edited while this pass was reading has an
    // instant inside the window and would fall outside the next one. The
    // overlap re-reads a boundary record, which EPIC-080 already guarantees is
    // free — the same input twice writes one row.
    const startedAt = new Date();
    const stored = options.full === true ? undefined : await this.#position(repositoryId);
    const since = stored?.syncedAt;
    const etags = stored?.etags ?? {};

    const unsupported: string[] = [];
    const unchanged: string[] = [];
    const nextEtags: Record<string, string> = {};
    let truncated = false;

    const base: ProjectQuery = { project, ...(since === undefined ? {} : { since }) };

    const wantIssues = options.withIssues !== false;
    const wantPulls = options.withPullRequests !== false;
    const wantReviews = options.withReviews !== false && wantPulls;

    let issues: readonly ProjectIssue[] = [];
    if (wantIssues) {
      throwIfAborted(context.signal, 'sync');
      const read = await this.#collect<ProjectIssue>(
        ISSUES,
        ProjectOperation.LIST_ISSUES,
        (query) => this.#source.listIssues(query, context),
        base,
        etags[ISSUES],
        pageLimit,
        { unsupported, unchanged, nextEtags },
      );
      issues = read.items;
      truncated = truncated || read.truncated;
    }

    let pullRequests: readonly ProjectPullRequest[] = [];
    if (wantPulls) {
      throwIfAborted(context.signal, 'sync');
      const read = await this.#collect<ProjectPullRequest>(
        PULL_REQUESTS,
        ProjectOperation.LIST_PULL_REQUESTS,
        (query) => this.#source.listPullRequests?.(query, context) ?? unsupportedPage(),
        base,
        etags[PULL_REQUESTS],
        pageLimit,
        { unsupported, unchanged, nextEtags },
      );
      pullRequests = read.items;
      truncated = truncated || read.truncated;
    }

    const reviews: ProjectReview[] = [];
    let reviewsPartial = false;
    if (wantReviews && pullRequests.length > 0) {
      if (!this.#operations.has(ProjectOperation.LIST_REVIEWS)) {
        unsupported.push(REVIEWS);
      } else {
        // One request per pull request, so the count is bounded and the bound
        // is reported. A pull request with no `number` cannot be asked about —
        // the contract numbers reviews by their parent — and is skipped rather
        // than guessed at.
        const numbered = pullRequests.filter(
          (pull): pull is ProjectPullRequest & { number: number } => typeof pull.number === 'number',
        );
        if (numbered.length > reviewLimit) reviewsPartial = true;
        for (const pull of numbered.slice(0, reviewLimit)) {
          throwIfAborted(context.signal, 'sync');
          const page = await this.#source.listReviews?.(
            { project, pullRequest: pull.number },
            context,
          );
          for (const review of page?.items ?? []) reviews.push(review);
        }
      }
    }

    const modelled = modelProject(
      {
        repositoryId,
        project,
        ...(issues.length === 0 ? {} : { issues }),
        ...(pullRequests.length === 0 ? {} : { pullRequests }),
        ...(reviews.length === 0 ? {} : { reviews }),
      },
      this.#emitter,
    );

    const repository = this.#repositoryEntity(project);
    const graph = {
      entities: [repository, ...modelled.entities],
      relationships: modelled.relationships,
      evidence: modelled.evidence,
      placeholderEntityIds: [repository.id, ...modelled.placeholderEntityIds],
    };

    const writes =
      options.dryRun === true ? EMPTY_WRITES : await this.#write(graph, startedAt, context);

    // EPIC-031's rule, which EPIC-075 moved into a separate verb precisely so
    // it could be applied here: a run that did not finish must be repeated, not
    // resumed from a position it never reached. A truncated enumeration, a dry
    // run, and a pass with no cursor store are all "did not finish" for this
    // purpose.
    let cursorAdvancedTo: string | undefined;
    if (options.dryRun !== true && !truncated && this.#cursors !== undefined) {
      const position: SyncPosition = {
        syncedAt: startedAt.toISOString(),
        ...(Object.keys(nextEtags).length === 0 ? {} : { etags: nextEtags }),
      };
      await this.#cursors.advance(SYNC_PRODUCER, repositoryId, { ...position }, startedAt);
      cursorAdvancedTo = position.syncedAt;
    }

    const report: ProjectSyncReport = {
      provider: this.#providerId,
      sourceSystem: this.#sourceSystem,
      project,
      repositoryId,
      since,
      unsupported,
      unchanged,
      counts: {
        issues: issues.length,
        pullRequests: pullRequests.length,
        reviews: reviews.length,
      },
      writes,
      skipped: modelled.skipped,
      truncated,
      reviewsPartial,
      cursorAdvancedTo,
      rateLimit: this.#source.rateLimit(),
      dryRun: options.dryRun === true,
    };

    this.#logger?.info(
      {
        operation: 'sync.project',
        provider: this.#providerId,
        // The project name, never the token and never a record body: this line
        // reaches an operator's terminal and a log file.
        project,
        issues: report.counts.issues,
        pullRequests: report.counts.pullRequests,
        reviews: report.counts.reviews,
        truncated,
        reviewsPartial,
      },
      `Synchronized ${project} from ${this.#sourceSystem}`,
    );

    return report;
  }

  async #position(repositoryId: string): Promise<SyncPosition | undefined> {
    const cursor = await this.#cursors?.read(repositoryId);
    if (cursor === undefined) return undefined;
    const position = cursor.position;
    const syncedAt = position['syncedAt'];
    const etags = position['etags'];
    return {
      ...(typeof syncedAt === 'string' ? { syncedAt } : {}),
      ...(isStringRecord(etags) ? { etags } : {}),
    };
  }

  /**
   * Reads one collection to the end, or to the page limit.
   *
   * `unchanged` is carried through rather than collapsed: a `304` means the
   * caller's copy is still current, which is a different fact from an empty
   * page, and the contract says so. When it happens the previous etag is kept,
   * so a later pass can still ask conditionally.
   */
  async #collect<T>(
    collection: string,
    operation: string,
    read: (query: ProjectQuery) => Promise<ProjectPage<T>>,
    base: ProjectQuery,
    etag: string | undefined,
    pageLimit: number,
    into: {
      unsupported: string[];
      unchanged: string[];
      nextEtags: Record<string, string>;
    },
  ): Promise<{ items: readonly T[]; truncated: boolean }> {
    if (!this.#operations.has(operation)) {
      into.unsupported.push(collection);
      return { items: [], truncated: false };
    }

    const items: T[] = [];
    let cursor: string | undefined;
    let pages = 0;

    for (;;) {
      const page = await read({
        ...base,
        ...(cursor === undefined ? {} : { cursor }),
        // Conditional only on the first page: an etag describes the first
        // response, and sending it against page four would ask the server a
        // question about a page it never issued one for.
        ...(cursor === undefined && etag !== undefined ? { etag } : {}),
      });
      pages += 1;

      if (page.unchanged === true) {
        into.unchanged.push(collection);
        if (etag !== undefined) into.nextEtags[collection] = etag;
        return { items, truncated: false };
      }

      for (const item of page.items) items.push(item);
      if (page.etag !== undefined && cursor === undefined) into.nextEtags[collection] = page.etag;

      cursor = page.cursor;
      if (cursor === undefined) return { items, truncated: false };
      if (pages >= pageLimit) return { items, truncated: true };
    }
  }

  /**
   * Entities, then relationships, then evidence — through the shared writer.
   *
   * This method used to *be* that loop. EPIC-119 lifted it into
   * `connectors/write.ts` unchanged so `SourceIngestor` could reuse the path
   * rather than grow a second copy of it: the order, the `ifAbsent` rule for
   * placeholders and the conflict sweep are each a lesson an earlier Epic paid
   * for, and a second implementation would have had to learn them again.
   */
  async #write(
    modelled: ContributionGraph,
    now: Date,
    context: ProviderOperationContext,
  ): Promise<ProjectSyncWrites> {
    return writeContribution(
      modelled,
      { entities: this.#entities, relationships: this.#relationships, evidence: this.#evidence },
      now,
      context,
      'sync',
    );
  }
}

const EMPTY_WRITES: ProjectSyncWrites = Object.freeze({
  entitiesCreated: 0,
  entitiesUpdated: 0,
  entitiesUnchanged: 0,
  relationships: 0,
  evidenceRecorded: 0,
  evidenceDeduplicated: 0,
});

/**
 * The identity every record this pass emits carries.
 *
 * `systemOfRecord` is true because a tracker *is* the system of record for its
 * own issues and their state — which is exactly the condition EPIC-045 sets,
 * and the same claim the GitHub and Jira providers make about what they read.
 */
function emissionIdentity(dependencies: ProjectSyncDependencies): EmissionIdentity {
  return {
    sourceSystem: dependencies.sourceSystem,
    producer: dependencies.providerId,
    producerVersion: VERSION,
    systemOfRecord: true,
  };
}

/**
 * A page from an operation the provider declared and did not implement.
 *
 * Unreachable through `#collect`, which checks the declaration first. It exists
 * because the optional method call needs a value, and returning an empty page
 * silently would make "declared and missing" look like "there are none".
 */
function unsupportedPage(): never {
  throw new FerretError(
    ErrorCode.PROVIDER_INVALID,
    'The provider declared an operation it does not implement',
    {
      remediation: 'This is a provider defect. Report it against the provider that declared it.',
    },
  );
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}
