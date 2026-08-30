import { z } from 'zod';

/**
 * Canonical entity kinds.
 *
 * EPIC-006 requires the model to cover repositories, branches, worktrees,
 * developers, agents, sessions, files, file versions, commits, pull requests,
 * reviews, issues, releases, deployments, documents and evidence — provider-
 * neutrally. Nothing here names GitHub, Jira or Git: a *pull request* is a
 * canonical concept that GitHub, GitLab and Bitbucket all map onto, and the
 * mapping is the provider's job.
 *
 * Two distinctions are deliberate and load-bearing:
 *
 * - **`branch` and `worktree` are separate kinds.** Governance §9 forbids
 *   conflating them, and EPIC-007 requires their relationships to stay distinct.
 *   One branch can be checked out in several worktrees, and a worktree can be
 *   detached from any branch. Modelling a worktree as "a branch with a path"
 *   would make both facts unrepresentable.
 * - **`file` and `file_version` are separate kinds.** A file has continuous
 *   identity across a rename or an edit; a version is the immutable content at a
 *   point in time. Merging them would make "what did this file look like at that
 *   commit" unanswerable, which is most of the point of indexing history.
 */
export const EntityKind = {
  /** A source repository, identified by its canonical remote or its path. */
  REPOSITORY: 'repository',
  /** A named ref within a repository. */
  BRANCH: 'branch',
  /** A checkout of a repository on disk. Distinct from the branch it holds. */
  WORKTREE: 'worktree',
  /** A human contributor, resolved across the identities they use. */
  DEVELOPER: 'developer',
  /** A non-human actor: an AI client, a bot, a CI runner. */
  AGENT: 'agent',
  /** One working session of a developer or an agent. */
  SESSION: 'session',
  /** A file's continuing identity within a repository. */
  FILE: 'file',
  /** The immutable content of a file at a point in time. */
  FILE_VERSION: 'file_version',
  /** A commit. */
  COMMIT: 'commit',
  /** A proposed change under review. */
  PULL_REQUEST: 'pull_request',
  /** A review of a proposed change. */
  REVIEW: 'review',
  /** A tracked unit of work. */
  ISSUE: 'issue',
  /** A published version. */
  RELEASE: 'release',
  /** A release reaching an environment. */
  DEPLOYMENT: 'deployment',
  /** A non-code document Ferret has indexed. */
  DOCUMENT: 'document',
  /** An observation, with its provenance. EPIC-008 gives this its semantics. */
  EVIDENCE: 'evidence',
} as const;

export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

export const ENTITY_KINDS: readonly EntityKind[] = Object.freeze(Object.values(EntityKind));

const KNOWN: ReadonlySet<string> = new Set(ENTITY_KINDS);

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && KNOWN.has(value);
}

/**
 * Lifecycle state.
 *
 * `deleted` is a **tombstone**, not a removal. Governance §6 forbids silently
 * rewriting source evidence, and EPIC-032 owns index tombstones: a file that has
 * been deleted upstream must remain answerable — "when was it deleted, by which
 * commit, what did it contain" are exactly the questions Ferret exists to
 * answer. Erasing the row would destroy the answer along with the file.
 */
export const LifecycleState = {
  /** Observed to exist at the source. */
  ACTIVE: 'active',
  /** Observed to have been removed at the source. The entity is retained. */
  DELETED: 'deleted',
  /** Replaced by another entity — a rename, or a merged identity. */
  SUPERSEDED: 'superseded',
  /** Ferret has a reference to it but has not observed it directly. */
  UNKNOWN: 'unknown',
} as const;

export type LifecycleState = (typeof LifecycleState)[keyof typeof LifecycleState];

export const LIFECYCLE_STATES: readonly LifecycleState[] = Object.freeze(Object.values(LifecycleState));

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

export const entityKindSchema = z.enum(ENTITY_KINDS as [EntityKind, ...EntityKind[]]);
export const lifecycleStateSchema = z.enum(LIFECYCLE_STATES as [LifecycleState, ...LifecycleState[]]);
