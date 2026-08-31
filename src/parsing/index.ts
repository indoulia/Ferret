/**
 * Turning a file's bytes into one uniform, addressable extraction — EPIC-024.
 *
 * Core logic, like `indexing/`: choosing a parser, bounding it and redacting
 * what it produces has nothing to do with any particular format. The framework
 * names no concrete parser, and `boundaries.test.ts` proves it.
 */

export {
  DETECTION_WINDOW_BYTES,
  MEDIA_TYPES,
  OCTET_STREAM,
  PLAIN_TEXT,
  detectContent,
  mediaTypeForPath,
  type ContentDetection,
  type ContentEncoding,
} from './detect.js';

export {
  DEFAULT_MAX_PARSE_BYTES,
  UNPARSED_REASONS,
  ParserFramework,
  UnparsedReason,
  parsersFrom,
  type ParseInput,
  type ParseOutcome,
  type ParsedContent,
  type ParserFrameworkOptions,
  type UnparsedContent,
} from './framework.js';
