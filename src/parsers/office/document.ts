import { createRequire } from 'node:module';

import mammoth from 'mammoth';

import { readBlocks, type HtmlBlock } from './html.js';

/**
 * The `mammoth` binding — EPIC-027.
 *
 * `provider.ts` knows the parser contract; this knows what a `.docx` is. The
 * split is EPIC-025's and EPIC-026's: a library upgrade should touch one file.
 */

/** How many blocks are kept before the parser stops — EPIC-027 §8.6. */
export const MAX_DOCX_BLOCKS = 5_000;

/** How many extracted characters are kept — EPIC-027 §8.6. */
export const MAX_DOCX_CHARACTERS = 1_000_000;

/** How many of the library's messages are reported — EPIC-027 §8.3. */
export const MAX_DOCX_MESSAGES = 25;

export class DocxReadError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'DocxReadError';
  }
}

export interface DocxExtraction {
  readonly blocks: readonly HtmlBlock[];
  readonly truncated: boolean;
  readonly warnings: readonly { readonly code: string; readonly detail: string }[];
}

export interface DocxReadOptions {
  readonly maxBlocks?: number;
  readonly maxCharacters?: number;
  readonly signal?: AbortSignal;
}

/**
 * What happens to an embedded image — EPIC-027 §8.7, and AC-14.
 *
 * `mammoth`'s default is `images.dataUri`, which base64-encodes every embedded
 * image into the output string: a document with a 3 MB screenshot becomes a
 * 4 MB string of which none is text. The handler below emits an `img` with no
 * source, so the encoding never happens rather than happening and being thrown
 * away.
 *
 * The handler itself stays module-private: exporting it would put `mammoth`'s
 * `ImageConverter` type into Ferret's public declarations, and the parser
 * subpath exists precisely so a consumer needs none of that. The policy is
 * exported instead, and AC-14 asserts it against this file's own source.
 */
export const DOCX_IMAGE_POLICY = 'drop';

const IMAGE_HANDLER = mammoth.images.imgElement(() => Promise.resolve({ src: '' }));

/** The library version, for `producerIdentity` — AC-11. Read, never parsed. */
export function docxLibraryIdentity(): string {
  const require = createRequire(import.meta.url);
  const manifest: unknown = require('mammoth/package.json');
  const version =
    typeof manifest === 'object' && manifest !== null
      ? (manifest as { version?: unknown }).version
      : undefined;
  return `mammoth@${typeof version === 'string' ? version : 'unknown'}`;
}

/**
 * Read a `.docx`.
 *
 * The bytes are copied into a `Buffer` because `mammoth` takes one; the copy
 * also means the caller's array is untouched, which EPIC-026 §8.7 had to make
 * explicit for a library that detaches.
 */
export async function readDocx(
  bytes: Uint8Array,
  options: DocxReadOptions = {},
): Promise<DocxExtraction> {
  options.signal?.throwIfAborted();
  const maxBlocks = options.maxBlocks ?? MAX_DOCX_BLOCKS;
  const maxCharacters = options.maxCharacters ?? MAX_DOCX_CHARACTERS;

  let result: { value: string; messages: readonly { type: string; message: string }[] };
  try {
    result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
      { convertImage: IMAGE_HANDLER },
    );
  } catch (error) {
    // §8.5. The library's own sentence, which is what it was selected for:
    // `python-docx` returns empty text here, and "empty" and "unreadable" must
    // not be the same answer.
    throw new DocxReadError(error instanceof Error ? error.message : String(error));
  }

  options.signal?.throwIfAborted();

  const warnings = result.messages
    .slice(0, MAX_DOCX_MESSAGES)
    .map((message) => ({ code: 'document-message', detail: message.message }));
  if (result.messages.length > MAX_DOCX_MESSAGES) {
    warnings.push({
      code: 'message-limit',
      detail: `${String(result.messages.length)} messages, reporting the first ${String(MAX_DOCX_MESSAGES)}.`,
    });
  }

  const all = readBlocks(result.value);
  const blocks: HtmlBlock[] = [];
  let characters = 0;
  let truncated = false;

  for (const block of all) {
    if (blocks.length >= maxBlocks) {
      truncated = true;
      warnings.push({
        code: 'block-limit',
        detail: `Stopped after ${String(maxBlocks)} of ${String(all.length)} blocks.`,
      });
      break;
    }
    if (characters + block.text.length > maxCharacters) {
      truncated = true;
      warnings.push({
        code: 'character-limit',
        detail: `Stopped at ${String(maxCharacters)} characters, on block ${String(blocks.length + 1)}.`,
      });
      break;
    }
    characters += block.text.length;
    blocks.push(block);
  }

  return { blocks, truncated, warnings };
}
