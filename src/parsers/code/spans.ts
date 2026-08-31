/**
 * Converting tree-sitter positions into EPIC-024 spans.
 *
 * tree-sitter indexes the JavaScript string it was given, so its offsets are in
 * UTF-16 code units. EPIC-024 spans are UTF-8 byte offsets into the original
 * content, deliberately, so that evidence can point at the file a human opens.
 * For ASCII the two are identical; for anything else they are not, and a span
 * that is silently wrong by a few bytes is worse than one that is obviously
 * wrong.
 *
 * The conversion is per line rather than per character. tree-sitter reports a
 * row and a column with every node, so a byte offset is the line's byte start
 * plus the encoded length of that line's first `column` code units — one short
 * slice, rather than a table with an entry per character.
 */

export interface SourcePosition {
  /** 0-based line, as tree-sitter reports it. */
  readonly row: number;
  /** 0-based offset within the line, in UTF-16 code units. */
  readonly column: number;
}

const encoder = new TextEncoder();

export class ByteOffsets {
  readonly #lines: readonly string[];
  /** Byte offset of the start of each line. */
  readonly #lineStarts: Int32Array;
  /** True when every code unit is one byte, which makes conversion a no-op. */
  readonly #ascii: boolean;
  readonly #totalBytes: number;

  constructor(text: string) {
    this.#lines = text.split('\n');
    this.#lineStarts = new Int32Array(this.#lines.length + 1);
    let offset = 0;
    for (let index = 0; index < this.#lines.length; index += 1) {
      this.#lineStarts[index] = offset;
      // `+ 1` for the newline that `split` removed. The last line has none, and
      // the extra entry past the end is never read as a line start.
      offset += encoder.encode(this.#lines[index] ?? '').length + 1;
    }
    this.#totalBytes = encoder.encode(text).length;
    this.#lineStarts[this.#lines.length] = this.#totalBytes;
    this.#ascii = this.#totalBytes === text.length;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  /** The UTF-8 byte offset of a tree-sitter position. */
  byteAt(position: SourcePosition, utf16Index: number): number {
    if (this.#ascii) return Math.min(utf16Index, this.#totalBytes);
    const row = Math.min(Math.max(position.row, 0), this.#lines.length - 1);
    const line = this.#lines[row] ?? '';
    const prefix = line.slice(0, Math.max(position.column, 0));
    const start = this.#lineStarts[row] ?? 0;
    return Math.min(start + encoder.encode(prefix).length, this.#totalBytes);
  }
}
