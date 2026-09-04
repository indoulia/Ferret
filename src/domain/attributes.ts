import { z } from 'zod';

import { EntityKind } from './kinds.js';

/**
 * EPIC-030's vocabularies, spelled out here rather than imported.
 *
 * `src/files/` derives these from content and depends on the parsing module;
 * the canonical model depends on nothing but zod, and importing upwards to
 * reach two string unions would trade that for no benefit. `files.test.ts`
 * asserts the two lists stay identical.
 */
const FILE_CLASSIFICATIONS = [
  'source',
  'test',
  'documentation',
  'configuration',
  'data',
  'generated',
  'vendored',
  'binary',
] as const;

const LINE_ENDINGS = ['lf', 'crlf', 'cr', 'mixed', 'none'] as const;

/**
 * Canonical attributes per entity kind.
 *
 * These are the fields Ferret understands *provider-neutrally*. They are
 * deliberately small: an attribute belongs here only when more than one provider
 * can supply it and Ferret can act on it. Everything else a source returns is
 * retained verbatim in `unknownFields` (see `entity.ts`), so nothing is lost and
 * nothing is invented.
 *
 * Every schema is `.strict()`. A typo in a provider — `titel` instead of `title`
 * — must fail validation rather than land in the canonical model as a field
 * nothing will ever read. Genuinely unrecognised source fields have a home; a
 * misspelled canonical one does not.
 *
 * Later Epics enrich these. EPIC-020 owns commit and ref modelling, EPIC-030
 * file structure and metadata, EPIC-072 pull requests and reviews. Each of those
 * extends the schema for its kind, which by construction requires no change to
 * the core entity model — that is EPIC-006 AC-4.
 */

/** An ISO-8601 instant with an offset. Used wherever a source reports a time. */
const instant = z.iso.datetime({ offset: true });

const base = {
  /** Human-readable name. Almost every kind has one; none require it. */
  name: z.string().min(1).optional(),
  /** Free-text description or body, as the source provides it. */
  description: z.string().optional(),
} as const;

export const repositoryAttributes = z
  .object({
    ...base,
    /** Canonical remote URL, normalized by the provider. */
    remoteUrl: z.string().min(1).optional(),
    /** Absolute path, when the repository is local. */
    path: z.string().min(1).optional(),
    /** The ref a fresh clone checks out. */
    defaultBranch: z.string().min(1).optional(),
    isBare: z.boolean().optional(),
  })
  .strict();

export const branchAttributes = z
  .object({
    ...base,
    /** Full ref name, e.g. `refs/heads/main`. */
    ref: z.string().min(1),
    /** Short name, e.g. `main`. */
    shortName: z.string().min(1).optional(),
    /** Commit the ref currently points at. */
    headCommit: z.string().min(1).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const worktreeAttributes = z
  .object({
    ...base,
    /** Absolute path of the checkout. */
    path: z.string().min(1),
    /** The ref checked out here, when it is not detached. */
    ref: z.string().min(1).optional(),
    /** True when the worktree is not on a branch. */
    isDetached: z.boolean().optional(),
    /** True for the repository's original working directory. */
    isPrimary: z.boolean().optional(),
    /** True when the worktree is locked, e.g. on removable media. */
    isLocked: z.boolean().optional(),
  })
  .strict();

export const developerAttributes = z
  .object({
    ...base,
    /**
     * Email addresses seen for this developer.
     *
     * A list, not a field: one person commits as several addresses, and
     * EPIC-036 resolves them into one identity. Collapsing to a single address
     * would throw away the evidence that resolution depends on.
     */
    emails: z.array(z.string().min(1)).default([]),
    /** Handles at external systems, e.g. a GitHub login. */
    usernames: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const agentAttributes = z
  .object({
    ...base,
    /** What kind of non-human actor this is: `ai-client`, `bot`, `ci`. */
    agentType: z.string().min(1).optional(),
    /** Product and version, e.g. `claude-code/2.1.0`. */
    version: z.string().min(1).optional(),
  })
  .strict();

export const sessionAttributes = z
  .object({
    ...base,
    startedAt: instant.optional(),
    endedAt: instant.optional(),
    /** Working directory the session ran in. */
    cwd: z.string().min(1).optional(),
    /** What the session set out to do. EPIC-039 gives this structure. */
    objective: z.string().optional(),
  })
  .strict();

export const fileAttributes = z
  .object({
    ...base,
    /** Repository-relative POSIX path. */
    path: z.string().min(1),
    /** Lowercase extension without the dot, when there is one. */
    extension: z.string().optional(),
    /** Detected media type, when a parser established one. */
    mediaType: z.string().min(1).optional(),
    /** Detected language, when a parser established one. */
    language: z.string().min(1).optional(),
    isBinary: z.boolean().optional(),
    /**
     * What the file is for, in one word — EPIC-030.
     *
     * Single-valued, because a consumer needs one answer. The two flags below
     * are separate because a minified bundle inside `node_modules` is both, and
     * "is this generated" must not answer `false` because `vendored` won.
     */
    classification: z.enum(FILE_CLASSIFICATIONS).optional(),
    /** What decided the classification. A derived judgement must be explicable. */
    classificationReason: z.string().min(1).optional(),
    isGenerated: z.boolean().optional(),
    isVendored: z.boolean().optional(),
    /**
     * How much of this file's code Ferret could actually resolve — F-27.
     *
     * EPIC-035 §12 says "the unresolved count is the number that matters". It
     * was computed, aggregated into a `logger.debug` line, and discarded —
     * nothing was written against the symbol, the file or the run. So "nothing
     * references this" and "we refused to resolve 64% of the references" were
     * the same answer, which is what makes a dead-code or impact answer
     * dangerous rather than merely incomplete.
     *
     * Measured on Ferret's own source when the finding was raised:
     * `registry.ts` 141 extracted / 51 resolved, `content.ts` 88 / 16,
     * `references.ts` 22 / 0.
     */
    referenceResolution: z
      .object({
        /** References the parser found in this file. */
        extracted: z.number().int().nonnegative(),
        /** References that became an edge. */
        resolved: z.number().int().nonnegative(),
        /** Counts by `UnresolvedReason`. Counts only — never a guessed target. */
        unresolved: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict()
      .optional(),
  })
  .strict();

export const fileVersionAttributes = z
  .object({
    ...base,
    /** Content hash of the bytes at this version. */
    contentHash: z.string().min(1),
    /** Size in bytes, when known. */
    sizeBytes: z.number().int().nonnegative().optional(),
    /** The commit this version was observed at, when it came from history. */
    commit: z.string().min(1).optional(),
    /** Path at this version, which a rename makes differ from the file's. */
    path: z.string().min(1).optional(),
    encoding: z.string().min(1).optional(),
    /** Lines of text — EPIC-030. Absent for binary: the question does not apply. */
    lineCount: z.number().int().nonnegative().optional(),
    lineEnding: z.enum(LINE_ENDINGS).optional(),
    endsWithNewline: z.boolean().optional(),
    /** Longest line in characters. A minified bundle is one very long line. */
    maxLineLength: z.number().int().nonnegative().optional(),
  })
  .strict();

export const commitAttributes = z
  .object({
    ...base,
    /** Full commit hash. */
    sha: z.string().min(1),
    message: z.string().optional(),
    authoredAt: instant.optional(),
    committedAt: instant.optional(),
    /** Parent commit hashes, in order. Two or more means a merge. */
    parents: z.array(z.string().min(1)).default([]),
    /** Tree hash, when the source reports one. */
    tree: z.string().min(1).optional(),
    /**
     * What the source said about an author Ferret would not identify — F-11.
     *
     * Present only when the author's address was absent, or was not an address
     * at all: `unknown`, `(no author)`, `root` — what `git filter-branch`,
     * `cvs2git` and hand-written commit objects emit. Ferret mints no actor for
     * those, because a display name is not an identity and deriving one merges
     * every unnamed author in a repository into a single person.
     *
     * Recorded rather than dropped: refusing to *identify* is not licence to
     * lose the observation, and a `.mailmap` added later repairs the history
     * from exactly these strings.
     */
    unattributedAuthor: z
      .object({
        name: z.string(),
        email: z.string(),
        /** Why no identity was derived. A reason, never a value. */
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const pullRequestAttributes = z
  .object({
    ...base,
    /** Number or key as the source system presents it. */
    number: z.string().min(1).optional(),
    title: z.string().optional(),
    /** Canonical state: `open`, `merged`, `closed`, `draft`. */
    state: z.string().min(1).optional(),
    sourceRef: z.string().min(1).optional(),
    targetRef: z.string().min(1).optional(),
    createdAt: instant.optional(),
    mergedAt: instant.optional(),
    closedAt: instant.optional(),
    mergeCommit: z.string().min(1).optional(),
  })
  .strict();

export const reviewAttributes = z
  .object({
    ...base,
    /** Canonical verdict: `approved`, `changes_requested`, `commented`. */
    state: z.string().min(1).optional(),
    body: z.string().optional(),
    submittedAt: instant.optional(),
  })
  .strict();

export const issueAttributes = z
  .object({
    ...base,
    /** Key or number as the source presents it, e.g. `FER-12`. */
    key: z.string().min(1).optional(),
    title: z.string().optional(),
    /** Canonical state: `open`, `in_progress`, `resolved`, `closed`. */
    state: z.string().min(1).optional(),
    /** The source's own status name, preserved because it carries meaning. */
    sourceState: z.string().min(1).optional(),
    issueType: z.string().min(1).optional(),
    priority: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).default([]),
    createdAt: instant.optional(),
    resolvedAt: instant.optional(),
    closedAt: instant.optional(),
  })
  .strict();

export const releaseAttributes = z
  .object({
    ...base,
    version: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    releasedAt: instant.optional(),
    isPrerelease: z.boolean().optional(),
    notes: z.string().optional(),
  })
  .strict();

export const deploymentAttributes = z
  .object({
    ...base,
    environment: z.string().min(1).optional(),
    /** Canonical state: `pending`, `succeeded`, `failed`, `rolled_back`. */
    state: z.string().min(1).optional(),
    deployedAt: instant.optional(),
    /** The commit or release that was deployed. */
    revision: z.string().min(1).optional(),
  })
  .strict();

export const documentAttributes = z
  .object({
    ...base,
    title: z.string().optional(),
    /** Where the document lives: a path, or a URL for an external one. */
    location: z.string().min(1).optional(),
    mediaType: z.string().min(1).optional(),
    /** Which parser produced the indexed content, and at which version. */
    parser: z.string().min(1).optional(),
    parserVersion: z.string().min(1).optional(),
    createdAt: instant.optional(),
    modifiedAt: instant.optional(),
  })
  .strict();

export const evidenceAttributes = z
  .object({
    ...base,
    /** What was observed. */
    statement: z.string().min(1).optional(),
    /** How Ferret came to know it: `observed`, `derived`, `asserted`. */
    method: z.string().min(1).optional(),
    /** Where in the source it was found — a line range, a cell, a page. */
    locator: z.string().min(1).optional(),
    observedAt: instant.optional(),
  })
  .strict();

/** Canonical attribute schema for every kind Ferret ships. */
export const ENTITY_ATTRIBUTE_SCHEMAS = {
  [EntityKind.REPOSITORY]: repositoryAttributes,
  [EntityKind.BRANCH]: branchAttributes,
  [EntityKind.WORKTREE]: worktreeAttributes,
  [EntityKind.DEVELOPER]: developerAttributes,
  [EntityKind.AGENT]: agentAttributes,
  [EntityKind.SESSION]: sessionAttributes,
  [EntityKind.FILE]: fileAttributes,
  [EntityKind.FILE_VERSION]: fileVersionAttributes,
  [EntityKind.COMMIT]: commitAttributes,
  [EntityKind.PULL_REQUEST]: pullRequestAttributes,
  [EntityKind.REVIEW]: reviewAttributes,
  [EntityKind.ISSUE]: issueAttributes,
  [EntityKind.RELEASE]: releaseAttributes,
  [EntityKind.DEPLOYMENT]: deploymentAttributes,
  [EntityKind.DOCUMENT]: documentAttributes,
  [EntityKind.EVIDENCE]: evidenceAttributes,
} as const satisfies Record<EntityKind, z.ZodType>;

export type EntityAttributes = {
  [K in EntityKind]: z.infer<(typeof ENTITY_ATTRIBUTE_SCHEMAS)[K]>;
};
