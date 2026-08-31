/**
 * File intelligence — what a file is, beyond its identity.
 *
 * Core logic: deriving line structure and deciding whether a tool wrote a file
 * has nothing to do with Git, PostgreSQL or any provider. EPIC-022 and EPIC-023
 * gave files identity from a tree entry; this says what they are.
 */

export { baseNameOf, extensionOf, normalizeForMatch } from './paths.js';

export {
  FILE_CLASSIFICATIONS,
  FileClassification,
  LineEnding,
  MARKER_WINDOW_BYTES,
  describeFileStructure,
  fileAttributesFrom,
  fileVersionAttributesFrom,
  type FileStructure,
} from './structure.js';
