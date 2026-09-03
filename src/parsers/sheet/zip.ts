import { inflateRawSync } from 'node:zlib';

/**
 * Reading a ZIP, because an OOXML package is one — EPIC-028 §8.1.
 *
 * Not a general archive library. It reads the central directory, refuses
 * anything it does not recognise, and enforces a decompression bound before it
 * inflates — which is the whole reason it exists rather than a dependency:
 * TECHNOLOGY-DECISIONS §4 tested decompression amplification as an adversarial
 * case, and a bound is only trustworthy if it is applied before the allocation.
 */

/** Signatures, little-endian. */
const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;
const CENTRAL_FILE_HEADER = 0x02_01_4b_50;

/** How many entries are read. An OOXML package has tens, not thousands. */
export const MAX_ZIP_ENTRIES = 512;

/**
 * How much inflated content is kept, in total.
 *
 * The framework caps input at 4 MiB, and DEFLATE's ceiling is about 1032:1 — so
 * an unbounded read of a 4 MiB archive could allocate four gigabytes. This is
 * the bound that makes that impossible, and it is checked per entry as the
 * total accumulates rather than after the fact.
 */
export const MAX_ZIP_INFLATED_BYTES = 64 * 1024 * 1024;

export class ZipReadError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ZipReadError';
  }
}

export interface ZipReadOptions {
  readonly maxEntries?: number;
  readonly maxInflatedBytes?: number;
  /** Read only the entries whose name this accepts. */
  readonly wanted?: (name: string) => boolean;
}

/**
 * The archive's entries, by name.
 *
 * Read through the central directory rather than by scanning for local headers:
 * a local header's sizes may be zero with the real values in a trailing data
 * descriptor, and trusting them is how a reader ends up parsing an entry's
 * content as though it were a header.
 */
export function readZip(
  bytes: Uint8Array,
  options: ZipReadOptions = {},
): ReadonlyMap<string, Uint8Array> {
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxInflated = options.maxInflatedBytes ?? MAX_ZIP_INFLATED_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const end = findEndOfCentralDirectory(view, bytes.byteLength);
  const count = view.getUint16(end + 10, true);
  if (count > maxEntries) {
    throw new ZipReadError(`${String(count)} entries, over the ${String(maxEntries)} allowed`);
  }

  let offset = view.getUint32(end + 16, true);
  const entries = new Map<string, Uint8Array>();
  let inflated = 0;

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_FILE_HEADER) {
      throw new ZipReadError('The central directory is damaged');
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (options.wanted !== undefined && !options.wanted(name)) continue;
    // Checked before inflating, not after: an entry that *declares* more than
    // the budget is refused without being allocated.
    if (inflated + uncompressedSize > maxInflated) {
      throw new ZipReadError(`"${name}" would exceed the ${String(maxInflated)}-byte bound`);
    }

    entries.set(name, readEntry(bytes, view, localOffset, method, compressedSize, name));
    inflated += uncompressedSize;
  }

  return entries;
}

function readEntry(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compressedSize: number,
  name: string,
): Uint8Array {
  if (localOffset + 30 > bytes.byteLength) {
    throw new ZipReadError(`"${name}" points outside the archive`);
  }
  // The name and extra lengths are read from the *local* header because they
  // may differ from the central directory's, which is where the data begins.
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + compressedSize);

  if (method === 0) return data;
  if (method !== 8) {
    throw new ZipReadError(`"${name}" uses compression method ${String(method)}`);
  }
  try {
    return new Uint8Array(inflateRawSync(data));
  } catch (error) {
    throw new ZipReadError(
      `"${name}" could not be inflated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The end-of-central-directory record, searched backwards.
 *
 * It is last, but a ZIP comment may follow it, so the search walks back over
 * the 64 KiB a comment length can address and no further.
 */
function findEndOfCentralDirectory(view: DataView, size: number): number {
  const limit = Math.max(0, size - 0x1_00_00 - 22);
  for (let offset = size - 22; offset >= limit; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new ZipReadError('Not a ZIP archive: no end-of-central-directory record');
}
