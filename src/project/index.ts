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
