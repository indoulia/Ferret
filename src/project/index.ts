/**
 * Project knowledge — EPIC-072.
 *
 * The join between what a tracker says and what a repository shows. Records in,
 * canonical entities, relationships and evidence out; no transport and no
 * store, which is what makes it a pure function and testable as one.
 */

export {
  modelProject,
  type ProjectModelInput,
  type ProjectModelResult,
  type SkippedRecord,
} from './model.js';

export {
  CLOSING_KEYWORDS,
  MAX_REFERENCE_SCAN_CHARACTERS,
  findClosingReferences,
  type ClosingReference,
} from './references.js';

// EPIC-073. What shipped, and where it went. The ancestry walk is separate
// because it is the only part that is a claim rather than a translation: no
// release API says which commits a release contains.
export {
  modelReleases,
  type ReleaseModelInput,
  type ReleaseModelResult,
} from './releases.js';

export {
  MAX_RELEASE_COMMITS,
  commitsInRelease,
  type AncestryOptions,
  type AncestryWalk,
} from './ancestry.js';
