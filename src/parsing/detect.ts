/**
 * Enough detection to route a file to a parser, and no more.
 *
 * EPIC-022 stopped at the byte boundary on purpose, so this is the first code
 * that looks inside a file. Two questions have to be answered before a parser
 * can be chosen: *is this text*, and *what is it*. Richer metadata — line
 * counts, structure, language statistics — is EPIC-030, and putting it here
 * would mean every caller pays for it to select a parser.
 *
 * Detection never executes content and never runs a parser. A media type
 * selects among providers that are already registered, trusted code; it cannot
 * cause anything new to load.
 */

/** Longest prefix examined. A file's nature is decided in its first bytes. */
export const DETECTION_WINDOW_BYTES = 8192;

export const OCTET_STREAM = 'application/octet-stream';
export const PLAIN_TEXT = 'text/plain';

/**
 * Extension to media type.
 *
 * Deliberately finite and boring. An extension nobody listed returns
 * `undefined` rather than a guess, and {@link detectContent} then decides from
 * the bytes — which is the honest order, because a name is a claim and bytes
 * are evidence.
 */
export const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  // Source
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  mts: 'text/x-typescript',
  cts: 'text/x-typescript',
  js: 'text/javascript',
  jsx: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  swift: 'text/x-swift',
  cs: 'text/x-csharp',
  c: 'text/x-c',
  h: 'text/x-c',
  cc: 'text/x-c++',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  php: 'text/x-php',
  scala: 'text/x-scala',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  ps1: 'application/x-powershell',
  sql: 'application/sql',
  // Data and configuration
  json: 'application/json',
  jsonc: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  ini: 'text/plain',
  env: 'text/plain',
  // Markup and prose
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  rst: 'text/x-rst',
  txt: PLAIN_TEXT,
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  // Documents
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Media and archives
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  gz: 'application/gzip',
});

/**
 * Extensionless files that are conventionally text.
 *
 * Without these, a `Dockerfile` is undetectable by name and falls through to
 * the byte sniff — which gets the right answer but loses the chance for a
 * parser to claim it specifically later.
 */
const KNOWN_FILENAMES: Readonly<Record<string, string>> = Object.freeze({
  dockerfile: PLAIN_TEXT,
  makefile: PLAIN_TEXT,
  license: PLAIN_TEXT,
  licence: PLAIN_TEXT,
  readme: PLAIN_TEXT,
  changelog: PLAIN_TEXT,
  notice: PLAIN_TEXT,
  codeowners: PLAIN_TEXT,
  gitignore: PLAIN_TEXT,
  gitattributes: PLAIN_TEXT,
  npmrc: PLAIN_TEXT,
  editorconfig: PLAIN_TEXT,
});

/** File signatures, checked before any name-based guess is trusted. */
const SIGNATURES: readonly { readonly bytes: readonly number[]; readonly mediaType: string }[] =
  Object.freeze([
    { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mediaType: 'image/png' },
    { bytes: [0xff, 0xd8, 0xff], mediaType: 'image/jpeg' },
    { bytes: [0x47, 0x49, 0x46, 0x38], mediaType: 'image/gif' },
    { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], mediaType: 'application/pdf' },
    { bytes: [0x1f, 0x8b], mediaType: 'application/gzip' },
    // ZIP, which is also every OOXML document. The extension decides between
    // them; this only settles that the content is not text.
    { bytes: [0x50, 0x4b, 0x03, 0x04], mediaType: 'application/zip' },
  ]);

/**
 * Media types whose content is text by definition.
 *
 * Used to resolve a contradiction rather than to classify: when the bytes are
 * binary and the name claims one of these, the name is simply wrong, and
 * reporting `text/plain` for a file full of NULs would send it to a text
 * parser. Anything else — `image/png`, `application/pdf` — is a claim the bytes
 * agree with, so it is kept.
 */
function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'image/svg+xml' ||
    mediaType === 'application/json' ||
    mediaType === 'application/yaml' ||
    mediaType === 'application/toml' ||
    mediaType === 'application/xml' ||
    mediaType === 'application/sql' ||
    mediaType === 'application/x-sh' ||
    mediaType === 'application/x-powershell'
  );
}

/** The type to report for binary bytes, given whatever the name claimed. */
function binaryMediaType(claimed: string | undefined): string {
  return claimed === undefined || isTextMediaType(claimed) ? OCTET_STREAM : claimed;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

export type ContentEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'unknown';

export interface ContentDetection {
  readonly mediaType: string;
  readonly binary: boolean;
  readonly encoding: ContentEncoding;
  readonly sizeBytes: number;
  /** Decoded content, when the bytes are text. */
  readonly text: string | undefined;
  /**
   * Bytes of the file that come before `text` begins.
   *
   * A byte-order mark is stripped when decoding, so a parser's offsets are
   * relative to text that starts after it. Every span was therefore short by
   * exactly this much, pointing one character into the token before the one it
   * meant to quote.
   */
  readonly textByteOffset: number;
  /**
   * Whether a UTF-8 byte offset into `text`, plus `textByteOffset`, names the
   * file's own bytes.
   *
   * True for UTF-8 with or without a mark. False for UTF-16, where the decoded
   * string has no byte-for-byte relationship with what is on disk — two bytes
   * per code unit, and a parser measuring its output with a UTF-8 encoder
   * produces offsets that land nowhere in particular. A consumer that cannot
   * derive a byte span must not be handed one.
   */
  readonly byteAddressable: boolean;
}

/** The media type a path claims, or `undefined` when the name says nothing. */
export function mediaTypeForPath(path: string): string | undefined {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const lower = name.toLowerCase();

  const known = KNOWN_FILENAMES[lower.startsWith('.') ? lower.slice(1) : lower];
  if (known !== undefined) return known;

  const dot = lower.lastIndexOf('.');
  // A leading dot is not an extension: `.gitignore` is a name, handled above.
  if (dot <= 0 || dot === lower.length - 1) return undefined;
  return MEDIA_TYPES[lower.slice(dot + 1)];
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function signatureOf(bytes: Uint8Array): string | undefined {
  return SIGNATURES.find((signature) => startsWith(bytes, signature.bytes))?.mediaType;
}

/**
 * Decides what a file is, from its bytes first and its name second.
 *
 * The order matters: a PNG named `.txt` is a PNG, and a parser handed it as
 * text would produce mojibake segments that look like real extraction. Bytes
 * are evidence; the name is a claim (Governance §6).
 */
export function detectContent(path: string, bytes: Uint8Array): ContentDetection {
  const sizeBytes = bytes.length;
  const window = bytes.subarray(0, DETECTION_WINDOW_BYTES);
  const claimed = mediaTypeForPath(path);

  if (sizeBytes === 0) {
    return {
      mediaType: claimed ?? PLAIN_TEXT,
      binary: false,
      encoding: 'utf-8',
      sizeBytes: 0,
      text: '',
      textByteOffset: 0,
      byteAddressable: true,
    };
  }

  const signature = signatureOf(window);
  if (signature !== undefined) {
    // The extension refines a ZIP into the OOXML document it actually is; for
    // everything else the signature is more specific than the name.
    const mediaType =
      signature === 'application/zip' && claimed !== undefined && claimed !== 'application/zip'
        ? claimed
        : signature;
    return {
      mediaType,
      binary: true,
      encoding: 'unknown',
      sizeBytes,
      text: undefined,
      textByteOffset: 0,
      byteAddressable: false,
    };
  }

  if (startsWith(window, UTF16LE_BOM) || startsWith(window, UTF16BE_BOM)) {
    const encoding: ContentEncoding = startsWith(window, UTF16LE_BOM) ? 'utf-16le' : 'utf-16be';
    const text = decode(bytes, encoding);
    return {
      mediaType: text === undefined ? binaryMediaType(claimed) : (claimed ?? PLAIN_TEXT),
      binary: text === undefined,
      encoding,
      sizeBytes,
      text,
      // The mark, which decoding removed.
      textByteOffset: 2,
      // Two bytes per code unit: no shift converts a UTF-8 offset into a
      // UTF-16 one, so nothing downstream may treat these offsets as bytes.
      byteAddressable: false,
    };
  }

  const hasBom = startsWith(window, UTF8_BOM);
  // A NUL byte in the first window is the oldest and still the most reliable
  // binary test: no text encoding Ferret decodes produces one.
  if (window.includes(0)) {
    return {
      mediaType: binaryMediaType(claimed),
      binary: true,
      encoding: 'unknown',
      sizeBytes,
      text: undefined,
      textByteOffset: 0,
      byteAddressable: false,
    };
  }

  const encoding: ContentEncoding = hasBom ? 'utf-8-bom' : 'utf-8';
  const text = decode(bytes, encoding);
  if (text === undefined) {
    return {
      mediaType: binaryMediaType(claimed),
      binary: true,
      encoding: 'unknown',
      sizeBytes,
      text: undefined,
      textByteOffset: 0,
      byteAddressable: false,
    };
  }
  return {
    mediaType: claimed ?? PLAIN_TEXT,
    binary: false,
    encoding,
    sizeBytes,
    text,
    textByteOffset: hasBom ? UTF8_BOM.length : 0,
    byteAddressable: true,
  };
}

/** Strict decoding: invalid bytes mean this is not text, not that it is lossy. */
function decode(bytes: Uint8Array, encoding: ContentEncoding): string | undefined {
  const label =
    encoding === 'utf-16le' ? 'utf-16le' : encoding === 'utf-16be' ? 'utf-16be' : 'utf-8';
  try {
    // `ignoreBOM: false` strips the mark, so downstream offsets and the text a
    // parser sees agree with what an editor shows.
    return new TextDecoder(label, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}
