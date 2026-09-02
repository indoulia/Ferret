import {
  FILE_DECLARES_SYMBOL,
  FILE_REFERENCES_SYMBOL,
  SYMBOL_REFERENCES_SYMBOL,
  buildCodeSymbols,
  resolveReferences,
  type CodeSymbol,
  type SymbolIndexPort,
  type SymbolIndexReport,
} from '../code/index.js';
import { DEFAULT_SYMBOL_SOURCE_SYSTEM } from '../code/identity.js';
import {
  EvidenceMethod,
  authorityFor,
  canonicalId,
  encodeKeyParts,
  type CanonicalEntity,
  type RelationshipInput,
} from '../domain/index.js';
import { describeFileStructure, type FileStructure } from '../files/index.js';
import type { Logger } from '../logging/index.js';
import {
  UNPARSED_REASONS,
  mediaTypeForPath,
  PLAIN_TEXT,
  type ParserFramework,
  type UnparsedReason,
} from '../parsing/index.js';
import { OutlineKind } from '../providers/index.js';
import type {
  CodeReference,
  DiscoveredRepository,
  ParseTarget,
  ProviderOperationContext,
} from '../providers/index.js';
import { throwIfAborted } from '../providers/index.js';
import { VERSION } from '../version.js';

import type {
  ContentArtifactStore,
  ContentBlobWriter,
  ContentReader,
  EvidenceWriter,
} from './ports.js';

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
   * What the run's references came to — EPIC-035.
   *
   * `undefined` when no writer was wired, so "not stored" and "none found" stay
   * distinguishable — the distinction EPIC-094 recorded the cost of losing.
   */
  readonly references?: ReferenceCounts | undefined;
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
  /**
   * Symbol edges this stage derived — EPIC-035.
   *
   * Returned rather than written for the reason `structure` is returned: this
   * stage runs before the graph is persisted, so the `file` entity an edge
   * points from does not exist yet. The indexer writes them once it has.
   */
  readonly edges: readonly RelationshipInput[];
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
  /**
   * Optional — EPIC-035, and it closes issue #49.
   *
   * Only the evidence writer. **The edges are returned, not written**, because
   * this stage runs *between the listing and the write* — the structure EPIC-030
   * derives has to be on the entities before they are persisted — so a `file`
   * entity does not exist yet when a reference is resolved, and an edge from one
   * would violate the relationship table's foreign key. Found by test, on the
   * first end-to-end run.
   *
   * A symbol, by contrast, is written by `indexFileSymbols` before this point,
   * so evidence about one has a subject to attach to.
   */
  readonly evidence?: EvidenceWriter;
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
  const { content, symbols, parser, artifacts, blobs, evidence, logger } = dependencies;
  const facts = fileVersionFacts(request.emitted.entities);
  // EPIC-035. A reference outside any declaration is the *file's*, and a file
  // declares the symbols it contains, so both edge types need the file entity's
  // id. Taken from the emitted graph rather than re-derived — the same rule §8.6
  // states for symbols: the provider owns identity, and a second derivation is
  // how two halves of one graph stop agreeing.
  const fileIds = fileEntityIds(request.emitted.entities);
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
  let references: ReferenceCounts | undefined;
  const edges: RelationshipInput[] = [];
  const pending: {
    readonly path: string;
    readonly fileId: string | undefined;
    readonly producerVersion: string | undefined;
    readonly built: readonly CodeSymbol[];
    readonly references: readonly CodeReference[];
    readonly imports: readonly string[];
  }[] = [];
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
    // EPIC-029 §8.4. Only an outline that says it is a symbol table becomes
    // one. Without this a Markdown heading is indexed as a declaration —
    // `codeSymbolKindOf` maps an unrecognised kind to `UNKNOWN` rather than
    // refusing — and 206 files of Ferret's own prose would fill EPIC-034's
    // symbol index.
    const built =
      outcome.outlineKind === OutlineKind.CODE
        ? buildCodeSymbols(outcome, { scope: request.repositoryId, path: entry.path })
        : [];
    const stored = await symbols.indexFileSymbols(
      { scope: request.repositoryId, path: entry.path },
      built,
      request.observedAt,
    );
    accumulate(symbolCounts, stored);

    // EPIC-035. Held for a pass after the loop rather than resolved here.
    //
    // **Cross-file resolution needs every file's symbols stored first.** Found
    // by test: `src/refund.ts` sorts before `src/tax.ts`, so resolving during
    // the loop asked for `applyTax` before `tax.ts` had been parsed and got
    // `not-found` — and because the gate skips an unchanged file, a later run
    // would never have corrected it. A defect that heals on the next run is bad;
    // one that never heals is worse.
    pending.push({
      path: entry.path,
      fileId: fileIds.get(entry.path),
      producerVersion,
      built,
      references: outcome.references ?? [],
      imports: outcome.imports ?? [],
    });

    await record(artifacts, scopeId, producerVersion, known.contentHash, described, request.observedAt);
  }

  // The reference pass — EPIC-035, in two phases over the whole run.
  //
  // **Symbol evidence first, for every file.** EPIC-008 requires `inferred`
  // evidence to name what it was derived from, and a cross-file resolution's
  // chain is the *target's* record — which the target's own file wrote. Found by
  // test: keeping the map per file made every cross-file resolution unciteable
  // and the write was rightly rejected.
  const symbolEvidence = new Map<string, string>();
  if (evidence !== undefined) {
    for (const file of pending) {
      await recordSymbolEvidence(evidence, symbolEvidence, {
        path: file.path,
        producerVersion: file.producerVersion,
        observedAt: request.observedAt,
        built: file.built,
      });
    }
  }

  // Then resolve. Every symbol this run stored now exists, so a name declared in
  // any parsed file is findable from any other.
  for (const file of pending) {
    const found = await indexReferences(
      { evidence, symbols, logger, symbolEvidence },
      {
        repositoryId: request.repositoryId,
        path: file.path,
        fileId: file.fileId,
        producerVersion: file.producerVersion,
        observedAt: request.observedAt,
      },
      file.built,
      file.references,
      new Set(file.imports),
    );
    references = addReferences(references, found.counts);
    edges.push(...found.edges);
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
      // EPIC-035. `undefined` when no writer was wired, so "not stored" and
      // "none found" stay distinguishable — the distinction the lifecycle stage
      // already makes and EPIC-094 recorded the cost of losing.
      references,
    },
    structure,
    // EPIC-035. Derived here and written by the indexer, after the entities
    // these edges point at exist.
    edges,
  };
}

/**
 * The `file_version` id and content hash for each path the listing produced.
 *
 * Taken from the entities `emitFiles` emitted, never re-derived. The provider
 * owns file and file-version identity; deriving it a second time here is the
 * EPIC-034 failure mode wearing different clothes.
 */
function fileEntityIds(entities: readonly CanonicalEntity[]): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  for (const entity of entities) {
    if (entity.kind !== 'file') continue;
    const path = entity.attributes['path'];
    if (typeof path !== 'string') continue;
    ids.set(path, entity.id);
  }
  return ids;
}

/** Sums one file's reference counts into the run's. */
function addReferences(total: ReferenceCounts | undefined, one: ReferenceCounts): ReferenceCounts {
  const base = total ?? NO_REFERENCES;
  const byRule = { ...base.byRule };
  for (const [rule, count] of Object.entries(one.byRule)) byRule[rule] = (byRule[rule] ?? 0) + count;
  const unresolved = { ...base.unresolved };
  for (const [reason, count] of Object.entries(one.unresolved)) {
    unresolved[reason] = (unresolved[reason] ?? 0) + count;
  }
  return {
    extracted: base.extracted + one.extracted,
    resolved: base.resolved + one.resolved,
    byRule,
    unresolved,
    edges: base.edges + one.edges,
    uncited: base.uncited + one.uncited,
    recursive: base.recursive + one.recursive,
  };
}

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

/** What one file's references came to — EPIC-035 §12. */
export interface ReferenceCounts {
  readonly extracted: number;
  readonly resolved: number;
  /** By resolution rule, so `same-file` and `unique-in-repository` are visible apart. */
  readonly byRule: Readonly<Record<string, number>>;
  /** By reason, and the number that matters: a repository where most references
   * are ambiguous is one where §8.3's honesty is doing real work. */
  readonly unresolved: Readonly<Record<string, number>>;
  readonly edges: number;
  /**
   * Resolutions whose evidence could not be written — EPIC-035 §16.
   *
   * The target was declared by a file this run did not parse, so Ferret does not
   * hold the record an `inferred` conclusion must cite. The edge is written and
   * the citation is not; counting it is what keeps the gap visible.
   */
  readonly uncited: number;
  /**
   * Resolutions that resolved to the symbol they sit inside — EPIC-035 §17.
   *
   * Recursion. A true resolution and not an edge, because EPIC-007 forbids a
   * relationship connecting an entity to itself. Counted so the number is
   * visible rather than looking like a resolution that went missing.
   */
  readonly recursive: number;
}

const NO_REFERENCES: ReferenceCounts = Object.freeze({
  extracted: 0,
  resolved: 0,
  byRule: Object.freeze({}),
  unresolved: Object.freeze({}),
  edges: 0,
  uncited: 0,
  recursive: 0,
});

/**
 * Phase one of the reference pass — one `parsed` record per symbol.
 *
 * Issue #49's fix, and separated from resolution because EPIC-008 requires an
 * `inferred` conclusion to name its chain: a cross-file resolution cites the
 * *target's* record, which the target's own file wrote. Doing both in one pass
 * per file made every cross-file citation impossible, which a test caught.
 *
 * A grammar extracted this declaration from this file's content, and the
 * *method* is what gives it authority `PARSED` (60) through EPIC-045 — the
 * ranking issue #49 recorded as inert for symbols because there was nothing to
 * rank.
 */
async function recordSymbolEvidence(
  evidence: EvidenceWriter,
  into: Map<string, string>,
  file: {
    readonly path: string;
    readonly producerVersion: string | undefined;
    readonly observedAt: Date;
    readonly built: readonly CodeSymbol[];
  },
): Promise<void> {
  for (const symbol of file.built) {
    const recorded = await evidence.record(
      {
        subjectId: symbol.id,
        field: 'attributes.qualifiedName',
        statement: symbol.qualifiedName,
        method: EvidenceMethod.PARSED,
        // DEFECT, found by test: `authorityFor` is applied by the provider SDK's
        // `Emitter`, and a caller writing through the store directly gets the
        // schema default of **0** — the exact state EPIC-045 existed to end,
        // reintroduced by a new write path. Applied explicitly here.
        authority: authorityFor(EvidenceMethod.PARSED),
        producer: CONTENT_PRODUCER,
        producerVersion: file.producerVersion ?? VERSION,
        sourceSystem: DEFAULT_SYMBOL_SOURCE_SYSTEM,
        sourceId: file.path,
        locator: { kind: 'line', start: symbol.span.startLine, end: symbol.span.endLine },
        observedAt: file.observedAt.toISOString(),
      },
      file.observedAt,
    );
    into.set(symbol.id, recorded.evidence.id);
  }
}

/**
 * Resolves and writes a file's symbol edges and evidence — EPIC-035.
 *
 * Four Epics deferred references, and issue #49 recorded what a symbol lacked: a
 * `code_symbol` had identity, attributes and lifecycle and **no evidence row
 * stating how Ferret came to believe it**, so EPIC-045's authority ranking had
 * nothing to apply and `derivedFrom` could not trace a symbol to the parse that
 * produced it.
 *
 * Reached only for a file this run actually parsed. An unchanged file is skipped
 * before this point, which is what makes AC-13 structural rather than a
 * deduplication that happens to work: no parse, no symbols, no references, no
 * writes.
 *
 * **The I/O is here and the decision is in `resolveReferences`.** The resolver is
 * pure and synchronous, so this function does the one thing it cannot: fetch the
 * repository-wide candidates for the names the file itself could not answer.
 * That is the layering used everywhere else — ports at the edge, a pure core
 * inside — and it is what lets every resolution rule be tested on paper.
 */
async function indexReferences(
  dependencies: {
    readonly evidence: EvidenceWriter | undefined;
    readonly symbols: SymbolIndexPort;
    readonly logger: Logger | undefined;
    /** Symbol id to its `parsed` record, across the whole run — see phase one. */
    readonly symbolEvidence: ReadonlyMap<string, string>;
  },
  request: {
    readonly repositoryId: string;
    readonly path: string;
    readonly fileId: string | undefined;
    /**
     * The parser's identity, when it could say.
     *
     * `undefined` is a parser that declined to identify itself, which the gate
     * already tolerates. Evidence needs a value, so §17 records the substitute
     * and why it is honest: a record attributed to an unidentified parser is
     * still attributable to *the content stage at this version*, and claiming a
     * grammar version Ferret does not have would be worse.
     */
    readonly producerVersion: string | undefined;
    readonly observedAt: Date;
  },
  built: readonly CodeSymbol[],
  references: readonly CodeReference[],
  imported: ReadonlySet<string>,
): Promise<{ counts: ReferenceCounts; edges: readonly RelationshipInput[] }> {
  const { evidence, symbols, logger } = dependencies;

  const observedAt = request.observedAt.toISOString();
  const evidenceIds = dependencies.symbolEvidence;
  // A parser that declined to identify itself still produced this. Attributing
  // the record to the content stage's own version is true; inventing a grammar
  // version would not be.
  const producerVersion = request.producerVersion ?? VERSION;

  // The names the file cannot answer itself. A name declared exactly once here
  // resolves `same-file` and never reaches the repository; one declared twice is
  // ambiguous and never reaches it either. So the lookup set is precisely the
  // names with no local declaration — §13's "one lookup per distinct name".
  const localCount = new Map<string, number>();
  for (const symbol of built) localCount.set(symbol.name, (localCount.get(symbol.name) ?? 0) + 1);

  const wanted = new Set(
    references
      .filter((one) => !one.qualified && !imported.has(one.name))
      .map((one) => one.name)
      .filter((name) => (localCount.get(name) ?? 0) === 0),
  );
  const candidates = new Map<string, readonly { readonly id: string }[]>();
  for (const name of wanted) {
    const found = await symbols.findSymbols({ scope: request.repositoryId, name });
    candidates.set(
      name,
      found.map((one) => ({ id: one.id })),
    );
  }

  const { resolved, unresolved } = resolveReferences(
    references,
    built,
    (name) => candidates.get(name) ?? [],
    imported,
  );

  const byRule: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  let uncited = 0;
  let recursive = 0;
  for (const one of unresolved) byReason[one.reason] = (byReason[one.reason] ?? 0) + 1;

  const edges: RelationshipInput[] = [];

  // Every symbol this file declares, so "what is in this file" is a traversal
  // rather than a path comparison.
  if (request.fileId !== undefined) {
    for (const symbol of built) {
      edges.push({
        fromId: request.fileId,
        type: FILE_DECLARES_SYMBOL,
        toId: symbol.id,
        validFrom: observedAt,
        metadata: { qualifiedName: symbol.qualifiedName, symbolKind: symbol.kind },
        sourceSystem: DEFAULT_SYMBOL_SOURCE_SYSTEM,
        sourceId: request.path,
      });
    }
  }

  {
    for (const one of resolved) {
      byRule[one.rule] = (byRule[one.rule] ?? 0) + 1;

      // §8.2. A reference with no enclosing declaration is the file's, not
      // nobody's — a separate edge type, because the endpoint kinds are what
      // make an edge mean something and one type accepting either would make
      // "which symbol calls this" unanswerable.
      const fromId = one.fromSymbolId ?? request.fileId;
      if (fromId === undefined) continue;
      const type = one.fromSymbolId === undefined ? FILE_REFERENCES_SYMBOL : SYMBOL_REFERENCES_SYMBOL;

      // A recursive call is a true resolution and **not an edge** — EPIC-007
      // forbids a relationship connecting an entity to itself, and it is right
      // to: a symbol calling itself is a property of the symbol, not a
      // relationship between two things. Found on Ferret's own code, where
      // `connect` calls `connect`; the resolution and its evidence are kept, so
      // recursion is still recorded, and only the self-edge is skipped.
      if (fromId === one.toSymbolId) {
        recursive += 1;
        continue;
      }

      edges.push({
        fromId,
        type,
        toId: one.toSymbolId,
        validFrom: observedAt,
        // The rule is on the edge because it is the answer to "how sure are
        // you" — a caller reading a call graph needs to know which half of it
        // is an inference from the absence of a homonym.
        metadata: {
          rule: one.rule,
          referenceKind: one.reference.kind,
          name: one.reference.name,
          line: one.reference.span.startLine,
        },
        sourceSystem: DEFAULT_SYMBOL_SOURCE_SYSTEM,
        sourceId: request.path,
      });

      // §8.4's second half. `inferred`, not `parsed`: the *reference* was
      // parsed, and that this reference means that declaration is a conclusion
      // Ferret drew. `derivedFrom` names the declaration's own record, so
      // EPIC-046's propagation bounds this record by it, and the confidence is
      // the rule's — which makes this the first shipping producer of `inferred`
      // evidence and EPIC-046's chain live rather than latent.
      if (evidence === undefined) continue;
      const derivedFrom = evidenceIds.get(one.toSymbolId);
      // EPIC-008 requires `inferred` evidence to name its chain, and Ferret
      // cannot cite one it does not hold: a target declared by a file this run
      // did not parse has no record in this map. The **edge is still written** —
      // the resolution is real — and only the evidence about it is skipped,
      // counted so the gap is visible rather than silent. §16 records it.
      if (derivedFrom === undefined) {
        uncited += 1;
        continue;
      }
      await evidence.record(
        {
          subjectId: one.toSymbolId,
          field: 'references',
          statement: {
            from: one.fromSymbolId ?? request.fileId,
            name: one.reference.name,
            rule: one.rule,
          },
          method: EvidenceMethod.INFERRED,
          authority: authorityFor(EvidenceMethod.INFERRED),
          producer: CONTENT_PRODUCER,
          producerVersion,
          sourceSystem: DEFAULT_SYMBOL_SOURCE_SYSTEM,
          sourceId: request.path,
          locator: { kind: 'line', start: one.reference.span.startLine, end: one.reference.span.endLine },
          confidence: one.confidence,
          derivedFrom: [derivedFrom],
          observedAt,
        },
        request.observedAt,
      );
    }
  }

  if (unresolved.length > 0) {
    logger?.debug(
      {
        operation: 'index.references',
        path: request.path,
        extracted: references.length,
        resolved: resolved.length,
        unresolved: byReason,
      },
      `Resolved ${String(resolved.length)} of ${String(references.length)} references in ${request.path}`,
    );
  }

  return {
    counts: {
      extracted: references.length,
      resolved: resolved.length,
      byRule,
      unresolved: byReason,
      edges: edges.length,
      uncited,
      recursive,
    },
    edges,
  };
}
