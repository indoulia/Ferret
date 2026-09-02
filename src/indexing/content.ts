import { buildCodeSymbols, type SymbolIndexPort, type SymbolIndexReport } from '../code/index.js';
import { canonicalId, encodeKeyParts, type CanonicalEntity } from '../domain/index.js';
import { describeFileStructure, type FileStructure } from '../files/index.js';
import type { Logger } from '../logging/index.js';
import {
  UNPARSED_REASONS,
  mediaTypeForPath,
  PLAIN_TEXT,
  type ParserFramework,
  type UnparsedReason,
} from '../parsing/index.js';
import type { DiscoveredRepository, ParseTarget, ProviderOperationContext } from '../providers/index.js';
import { throwIfAborted } from '../providers/index.js';

import type { ContentArtifactStore, ContentBlobWriter, ContentReader } from './ports.js';

/**
 * The per-file content flow — EPIC-108 §3.5 and §8.7.
 *
 * Its own module rather than more of `indexer.ts`, because it is a different
 * kind of work: `indexer.ts` decides what to read and in what order, and this
 * decides what one file yields. Keeping them apart also keeps EPIC-031's file
 * reviewable as EPIC-031's file.
 *
 * **Nothing here derives an identity.** Not a symbol id, not a `code_symbol`
 * entity input, not a canonical key. `buildCodeSymbols` produces symbols and
 * `indexFileSymbols` stores them, and this module's entire contribution is
 * calling them in order with the context they expect. EPIC-034 failed exactly
 * once by deriving the same id in two places three files apart, and every
 * symbol was retired on every run; §8.6 makes that a contract rather than a
 * memory, and AC-15 makes it testable.
 *
 * The order is fixed and each step is somebody else's function:
 *
 * ```
 * gate → readFileContent → describeFileStructure → ParserFramework.parse
 *      → buildCodeSymbols → indexFileSymbols
 * ```
 */

/** The derived-artefact kind the re-parse gate records under. */
export const CONTENT_ARTIFACT_KIND = 'content-index';

/** The producer the gate attributes its artefacts to. */
export const CONTENT_PRODUCER = 'ferret.indexer.content';

/**
 * How many of each `UNPARSED_REASONS` value a run saw.
 *
 * Every reason is present, including the zeroes. "How much of this repository is
 * unparsed, and why" should be a lookup rather than an investigation (§12), and
 * an absent key would make a reader guess whether it meant zero or meant the
 * reason had been removed.
 */
export type UnparsedBreakdown = Record<UnparsedReason, number>;

/** What the content stage did, defined in EPIC-108 §8.8. */
export interface ContentCounts {
  /** Files the stage examined, after EPIC-022's skip rules and before the gate. */
  readonly filesConsidered: number;
  /** Passed the gate: content was **not** read and not parsed. */
  readonly filesSkippedUnchanged: number;
  /** Content actually fetched from the provider. Excludes the above. */
  readonly filesRead: number;
  /** A parse returned a result. A partial result from a file with syntax errors *is* parsed. */
  readonly filesParsed: number;
  /** A result marked unparsed. Ferret had the bytes and no parser produced a result. */
  readonly filesUnparsed: number;
  readonly unparsedReasons: UnparsedBreakdown;
  /**
   * Content could not be obtained at all.
   *
   * Distinct from unparsed, and the distinction is load-bearing: one is "Ferret
   * could not get the bytes" and the other is "Ferret has the bytes and no
   * parser produced a result". Collapsing them would hide a provider fault
   * inside a parser statistic.
   */
  readonly filesFailed: number;
  /**
   * What the content stage persisted — EPIC-087 §12.
   *
   * All zero when no blob writer was composed, which is indistinguishable from
   * a run that stored nothing. That is acceptable and the alternative was not:
   * the stage-level skip reasons already say *why* content did not run, and a
   * fifth `undefined` here would make every consumer handle a case the skip
   * reason already covers.
   */
  readonly blobs: {
    /** Content written for the first time. */
    readonly stored: number;
    /** Already on record under this hash. Nothing was written. */
    readonly deduplicated: number;
    /** Stored without a body, by reason — EPIC-087 §8.6. */
    readonly textOmitted: Readonly<Record<string, number>>;
    /** The store rejected it. The file is still parsed and indexed (AC-13). */
    readonly failed: number;
  };
  /** Summed from the `SymbolIndexReport`s EPIC-034 returned, with its meanings. */
  readonly symbols: {
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly tombstoned: number;
    readonly reinstated: number;
  };
}

export interface ContentStageResult {
  readonly counts: ContentCounts;
  /**
   * EPIC-030 structure by path, for the `structure` option `emitFiles` accepts.
   *
   * Includes files the gate skipped, replayed from their artefact rather than
   * recomputed. Without that, a second run would emit those files *without* the
   * structure the first run gave them, the upsert would report `updated`, and
   * AC-6's "writes no rows" would be false for the very files the gate exists to
   * make free.
   */
  readonly structure: ReadonlyMap<string, FileStructure>;
}

/**
 * One file, as the content stage needs to address it.
 *
 * Narrowed from the listing at the point of use rather than by widening
 * EPIC-031's `IndexableSource`, which declares its entries `unknown` and is
 * depended upon rather than modified (§7). The two fields are the capability
 * contract's own vocabulary — `FileContentRequest` names exactly `path` and
 * `oid` — so this is not a Git shape leaking into the core.
 */
interface AddressableEntry {
  readonly path: string;
  readonly oid: string;
}

function addressable(entry: unknown): AddressableEntry | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const candidate = entry as { path?: unknown; oid?: unknown };
  if (typeof candidate.path !== 'string' || candidate.path.length === 0) return undefined;
  if (typeof candidate.oid !== 'string' || candidate.oid.length === 0) return undefined;
  return { path: candidate.path, oid: candidate.oid };
}

export interface ContentStageDependencies {
  readonly content: ContentReader;
  readonly symbols: SymbolIndexPort;
  readonly parser: ParserFramework;
  readonly artifacts: ContentArtifactStore;
  /** Optional — EPIC-087. Absent means content is read and derived from, not kept. */
  readonly blobs?: ContentBlobWriter;
  readonly logger?: Logger;
}

export interface ContentStageRequest {
  readonly repository: DiscoveredRepository;
  /** The repository's canonical entity id — `context.scope` for every symbol. */
  readonly repositoryId: string;
  /** Entries the listing returned, in the source's own shape. */
  readonly entries: readonly unknown[];
  /**
   * The graph `emitFiles` produced *without* structure.
   *
   * Read for two things and written to for none: which paths survived the skip
   * rules, and what each one's content hash is.
   * Taking them from the emitted graph rather than re-deriving them is the same
   * rule §8.6 states for symbols — the provider owns identity, and a second
   * derivation is how two halves of one graph stop agreeing.
   */
  readonly emitted: { readonly entities: readonly CanonicalEntity[] };
  readonly revision: string | undefined;
  readonly observedAt: Date;
}

interface FileVersionFacts {
  readonly contentHash: string;
}

/**
 * Runs the content stage over one repository's files.
 *
 * Cancellation is checked **between files**, not only between stages, so a large
 * repository stops promptly (§8.9). It throws on cancellation rather than
 * returning what it had: a cancelled content stage means the run failed, and a
 * partial count reported as a whole one is exactly the claim Governance §6
 * forbids.
 */
export async function runContentStage(
  dependencies: ContentStageDependencies,
  request: ContentStageRequest,
  context: ProviderOperationContext,
): Promise<ContentStageResult> {
  const { content, symbols, parser, artifacts, blobs, logger } = dependencies;
  const facts = fileVersionFacts(request.emitted.entities);
  const structure = new Map<string, FileStructure>();

  let filesConsidered = 0;
  let filesSkippedUnchanged = 0;
  let filesRead = 0;
  let filesParsed = 0;
  let filesUnparsed = 0;
  let filesFailed = 0;
  const unparsedReasons = emptyBreakdown();
  const symbolCounts = { created: 0, updated: 0, unchanged: 0, tombstoned: 0, reinstated: 0 };
  const blobCounts = { stored: 0, deduplicated: 0, failed: 0 };
  const textOmitted: Record<string, number> = {};

  for (const raw of request.entries) {
    // Between files rather than between stages. A repository with forty
    // thousand files must stop when it is told to, not when it finishes.
    throwIfAborted(context.signal, 'index.content');

    const entry = addressable(raw);
    if (entry === undefined) continue;
    // A path with no `file_version` entity did not survive EPIC-022's skip
    // rules — a symlink, a submodule, a secret-bearing path. `emitFiles` already
    // decided and reported that; the content stage does not second-guess it, and
    // in particular a `.env` is not read merely because content indexing is on.
    const known = facts.get(entry.path);
    if (known === undefined) continue;

    filesConsidered += 1;

    const target = preReadTarget(entry.path);
    const producerVersion = await parser.producerVersion(target);
    const scopeId = contentScopeId(request.repositoryId, entry.path);

    // The gate, before the read. The content hash is what `listFiles` already
    // returned, which is what lets this skip the *read* and not merely the
    // parse.
    const verdict = await gate(artifacts, scopeId, producerVersion, known.contentHash);
    if (verdict.valid) {
      filesSkippedUnchanged += 1;
      const replayed = replayStructure(verdict.metadata);
      // Replayed rather than recomputed. Emitting this file without the
      // structure the last run derived would rewrite the entity to remove it,
      // which is a row written for a file nothing about which changed.
      if (replayed !== undefined) structure.set(entry.path, replayed);
      logger?.debug(
        { operation: 'index.content.skip', path: entry.path, reason: 'unchanged' },
        `Skipped ${entry.path}: content, parser and grammar are unchanged`,
      );
      continue;
    }
    if (verdict.reason !== undefined) {
      // "The parser changed" and "the file changed" call for the same action and
      // are different facts (§12).
      logger?.debug(
        { operation: 'index.content.stale', path: entry.path, reason: verdict.reason },
        `Re-reading ${entry.path}: ${verdict.reason}`,
      );
    }

    const fetched = await content.readFileContent(
      request.repository,
      {
        path: entry.path,
        oid: entry.oid,
        ...(request.revision === undefined ? {} : { revision: request.revision }),
      },
      context,
    );

    if (!fetched.read) {
      // Counted in its own bucket and the run continues. One unreadable file
      // costs exactly itself (§8.9, Governance §13).
      filesFailed += 1;
      logger?.warn(
        { operation: 'index.content.failed', path: entry.path, reason: fetched.reason, detail: fetched.detail },
        `Could not read ${entry.path}: ${fetched.detail}`,
      );
      continue;
    }

    filesRead += 1;
    const described = describeFileStructure(entry.path, fetched.bytes);
    structure.set(entry.path, described);

    // EPIC-087 — the point at which EPIC-108 §4 discarded the bytes.
    //
    // After `describeFileStructure` because the store needs its verdict on
    // binary, media type and encoding, and before the parse because a store
    // failure must not cost the parse. Isolated for that reason: content
    // retrieval is an additional answer, and losing it is not a reason to lose
    // the symbols this run already read the file for (AC-13).
    if (blobs !== undefined) {
      try {
        const written = await blobs.store({
          contentHash: known.contentHash,
          bytes: fetched.bytes,
          mediaType: described.mediaType,
          encoding: described.encoding,
          binary: described.binary,
        });
        if (written.deduplicated) blobCounts.deduplicated += 1;
        else blobCounts.stored += 1;
        if (written.omittedReason !== undefined) {
          textOmitted[written.omittedReason] = (textOmitted[written.omittedReason] ?? 0) + 1;
        }
        for (const [kind, count] of Object.entries(written.redacted)) {
          // Kind and count. Never the value — that is the whole point of
          // redacting before the insert (EPIC-087 §8.2).
          logger?.warn(
            { operation: 'index.content.redacted', path: entry.path, kind, count },
            `Redacted ${String(count)} ${kind} from ${entry.path} before storing it`,
          );
        }
      } catch (error) {
        blobCounts.failed += 1;
        logger?.warn(
          { operation: 'index.content.blob-failed', path: entry.path, error: String(error) },
          `Could not store content for ${entry.path}; it is indexed but not searchable by body`,
        );
      }
    }

    const outcome = await parser.parse(
      { path: entry.path, bytes: fetched.bytes, contentHash: known.contentHash },
      context,
    );

    if (!outcome.parsed) {
      filesUnparsed += 1;
      unparsedReasons[outcome.reason] += 1;
      // Recorded anyway, and deliberately. "No parser claims this media type" is
      // a stable answer for unchanged content, and re-deriving it every run
      // would make the gate useless for exactly the files it is cheapest on.
      await record(artifacts, scopeId, producerVersion, known.contentHash, described, request.observedAt);
      continue;
    }

    filesParsed += 1;

    // The one path from a parse to a stored symbol. `buildCodeSymbols` owns
    // identity and `indexFileSymbols` owns storage; the scope is the repository
    // entity id and the path is repository-relative, which is the shape
    // `symbolScope` expects (§8.6).
    const built = buildCodeSymbols(outcome, { scope: request.repositoryId, path: entry.path });
    const stored = await symbols.indexFileSymbols(
      { scope: request.repositoryId, path: entry.path },
      built,
      request.observedAt,
    );
    accumulate(symbolCounts, stored);

    await record(artifacts, scopeId, producerVersion, known.contentHash, described, request.observedAt);
  }

  return {
    counts: {
      filesConsidered,
      filesSkippedUnchanged,
      filesRead,
      filesParsed,
      filesUnparsed,
      unparsedReasons,
      filesFailed,
      blobs: { ...blobCounts, textOmitted: { ...textOmitted } },
      symbols: { ...symbolCounts },
    },
    structure,
  };
}

/**
 * The `file_version` id and content hash for each path the listing produced.
 *
 * Taken from the entities `emitFiles` emitted, never re-derived. The provider
 * owns file and file-version identity; deriving it a second time here is the
 * EPIC-034 failure mode wearing different clothes.
 */
function fileVersionFacts(entities: readonly CanonicalEntity[]): ReadonlyMap<string, FileVersionFacts> {
  const facts = new Map<string, FileVersionFacts>();
  for (const entity of entities) {
    if (entity.kind !== 'file_version') continue;
    const path = entity.attributes['path'];
    const contentHash = entity.attributes['contentHash'];
    if (typeof path !== 'string' || typeof contentHash !== 'string') continue;
    facts.set(path, { contentHash });
  }
  return facts;
}

/**
 * What the parser framework can be asked *before* the bytes exist.
 *
 * The gate has to know which parser and which grammar would handle a file in
 * order to decide whether to read it at all, and detection needs content. The
 * path is the part that is available early: `mediaTypeForPath` answers from the
 * name alone, and it is the same function `detectContent` consults for a
 * claimed type. A file whose *content* turns out to disagree with its name is
 * re-parsed on its real type after the read; the only consequence of the
 * pre-read guess is which producer version the gate keyed on, and a guess that
 * changes is a guess that invalidates, which is the safe direction.
 */
function preReadTarget(path: string): ParseTarget {
  return {
    path,
    mediaType: mediaTypeForPath(path) ?? PLAIN_TEXT,
    binary: false,
    sizeBytes: 0,
  };
}

/**
 * The artefact scope for one file's derived content — one row per path.
 *
 * A derived scope in the pattern `watermarkScopeId` established, and it departs
 * from §8.7 in two ways that were found by making AC-8 pass rather than by
 * preference. Both are recorded in §18.
 *
 * **Not the `file_version` entity id.** `derived_artifact` needs a uuid unique
 * per scope and both satisfy that; only this one satisfies §8.6's rule that this
 * Epic derives no identity anybody else owns. Reusing the entity id would have
 * the indexer and the provider each computing a value that must agree, which is
 * the exact shape of the defect `src/code/identity.ts` exists to prevent.
 *
 * **Keyed on the path, not on the path *and* the content.** §8.7 says one
 * artefact per indexed file *version*, and that is wrong in a way only a
 * three-run test shows: edit a file, index, revert it, index. With a per-version
 * scope the revert finds the artefact the *first* run wrote, calls the file
 * unchanged, and skips it — but the second run tombstoned the symbols the first
 * run stored, and nothing brings them back. The file is silently left with its
 * symbols deleted.
 *
 * One artefact per path, carrying the content hash as `sourceContentHash`, is
 * what `validateArtifact` was built for and fixes it: a revert is a hash that
 * differs from the recorded one, so the file is re-read and its symbols
 * reinstated. It also bounds the table by distinct paths rather than by distinct
 * file versions, which is strictly smaller than the cost §8.7 accepted.
 */
/**
 * What this composition would stamp on a `content-index` artefact today.
 *
 * EPIC-094 AC-7's other half. The sweep can compare a `ferret.indexer`
 * artefact's version to `VERSION` on its own; it cannot judge a content
 * artefact, whose `producer_version` is the *parser's* identity and therefore
 * depends both on the file and on what the caller composed. So the caller
 * answers, through `SweepOptions.producerIdentity`.
 *
 * The target is rebuilt from the artefact's own `metadata.structure`, which
 * already carries `path`, `mediaType`, `binary` and `sizeBytes` — the record
 * the gate writes is exactly the record needed to re-ask the question. No join
 * back to the file is required, which matters because `contentScopeId` is a
 * hash of the path rather than a reference to an entity.
 *
 * `undefined` whenever it cannot say — a producer it does not own, or metadata
 * without a usable structure. Never a guess: an artefact reported stale because
 * nothing could judge it is how 540 healthy rows were once called corrupt.
 */
export function contentProducerIdentity(parser: {
  producerVersion(target: {
    readonly path: string;
    readonly mediaType: string;
    readonly binary: boolean;
    readonly sizeBytes: number;
  }): Promise<string | undefined>;
}): {
  versionFor(artifact: {
    readonly kind: string;
    readonly producer: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }): Promise<string | undefined>;
} {
  return {
    async versionFor(artifact) {
      if (artifact.producer !== CONTENT_PRODUCER) return undefined;
      const structure = artifact.metadata['structure'];
      if (typeof structure !== 'object' || structure === null) return undefined;
      const { path, mediaType, binary, sizeBytes } = structure as Partial<FileStructure>;
      if (typeof path !== 'string' || typeof mediaType !== 'string') return undefined;
      // `NO_PARSER_PRODUCER` rather than `undefined` when nothing claims the
      // path, because that is what `record` wrote — and the two must agree or
      // every unparsed file reports stale for ever.
      return (
        (await parser.producerVersion({
          path,
          mediaType,
          binary: binary ?? false,
          sizeBytes: sizeBytes ?? 0,
        })) ?? NO_PARSER_PRODUCER
      );
    },
  };
}

export function contentScopeId(repositoryId: string, path: string): string {
  return canonicalId(encodeKeyParts([CONTENT_ARTIFACT_KIND, repositoryId, path]));
}

/**
 * The producer version the gate keys on — parser id, parser version, grammar.
 *
 * All three change what a parse produces, so all three must invalidate. A gate
 * on content alone is cheaper and would leave a parser fix never reaching files
 * already indexed, which is the precise failure EPIC-024 built result provenance
 * to make detectable.
 *
 * `undefined` when no parser claims the path. That is still a producer version —
 * "nothing would parse this" — and it changes the moment a parser is added, so
 * the file is reconsidered rather than skipped for ever.
 */
const NO_PARSER_PRODUCER = 'none';

interface GateVerdict {
  readonly valid: boolean;
  readonly reason: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
}

async function gate(
  artifacts: ContentArtifactStore,
  scopeId: string,
  producerVersion: string | undefined,
  contentHash: string,
): Promise<GateVerdict> {
  const artifact = await artifacts.getArtifact(CONTENT_ARTIFACT_KIND, scopeId);
  if (artifact === undefined) {
    return { valid: false, reason: 'no artefact has been recorded for this file version', metadata: undefined };
  }
  const verdict = artifacts.validateArtifact(artifact, {
    producer: CONTENT_PRODUCER,
    producerVersion: producerVersion ?? NO_PARSER_PRODUCER,
    sourceContentHash: contentHash,
  });
  return { valid: verdict.valid, reason: verdict.reason, metadata: artifact.metadata };
}

async function record(
  artifacts: ContentArtifactStore,
  scopeId: string,
  producerVersion: string | undefined,
  contentHash: string,
  structure: FileStructure,
  now: Date,
): Promise<void> {
  await artifacts.recordArtifact(
    {
      kind: CONTENT_ARTIFACT_KIND,
      scopeId,
      producer: CONTENT_PRODUCER,
      producerVersion: producerVersion ?? NO_PARSER_PRODUCER,
      sourceContentHash: contentHash,
      // The structure is the artefact. Recording it is what lets a gate skip
      // replay what the last run derived instead of emitting a file stripped of
      // it — no bytes are stored, which §4 reserves for EPIC-087.
      metadata: { structure: { ...structure } },
    },
    now,
  );
}

/** The structure a previous run recorded, when the record still holds one. */
function replayStructure(metadata: Readonly<Record<string, unknown>> | undefined): FileStructure | undefined {
  const stored = metadata?.['structure'];
  if (typeof stored !== 'object' || stored === null) return undefined;
  const candidate = stored as Partial<FileStructure>;
  // Checked rather than cast: this came out of a database, and a record written
  // by an older build may not hold what this one expects.
  if (typeof candidate.path !== 'string' || typeof candidate.mediaType !== 'string') return undefined;
  if (typeof candidate.classification !== 'string' || typeof candidate.sizeBytes !== 'number') return undefined;
  return candidate as FileStructure;
}

function emptyBreakdown(): UnparsedBreakdown {
  const breakdown = {} as UnparsedBreakdown;
  for (const reason of UNPARSED_REASONS) breakdown[reason] = 0;
  return breakdown;
}

function accumulate(
  totals: { created: number; updated: number; unchanged: number; tombstoned: number; reinstated: number },
  report: SymbolIndexReport,
): void {
  totals.created += report.created;
  totals.updated += report.updated;
  totals.unchanged += report.unchanged;
  totals.tombstoned += report.tombstoned;
  totals.reinstated += report.reinstated;
}
