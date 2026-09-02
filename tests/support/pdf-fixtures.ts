/**
 * PDFs built rather than checked in — EPIC-026 §10.
 *
 * A binary fixture is unreviewable: nobody diffing this repository can tell a
 * two-page document from a payload. Every PDF here is assembled from readable
 * objects, uncompressed, with a real cross-reference table — which is also the
 * only way to produce the malformed and encrypted cases deliberately rather
 * than by finding a file that happens to be broken.
 */

/** Assemble numbered objects into a PDF with a valid xref table. */
function assemble(objects: readonly string[], trailerExtra = ''): Uint8Array {
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R ${trailerExtra}>>\n`;
  out += `startxref\n${String(startxref)}\n%%EOF\n`;
  // `latin1`: a PDF's structure is bytes, not characters, and a multi-byte
  // encoding here would move every offset the xref table just recorded.
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

export interface PdfFixtureOptions {
  /** One string per page. An empty string is a page with no content stream. */
  readonly pages: readonly string[];
  readonly title?: string;
  readonly author?: string;
  /** Bookmark titles, each pointing at a 1-based page. */
  readonly bookmarks?: readonly { readonly title: string; readonly page: number }[];
}

/** A readable, uncompressed PDF. */
export function buildPdf(options: PdfFixtureOptions): Uint8Array {
  const { pages, bookmarks = [] } = options;
  const objects: string[] = [];

  // 1 catalog, 2 page tree, then two objects per page, then the bookmarks.
  const pageObject = (index: number): number => 3 + index * 2;
  const kids = pages.map((_, index) => `${String(pageObject(index))} 0 R`).join(' ');
  const outlineRoot = 3 + pages.length * 2;

  objects.push(
    bookmarks.length === 0
      ? '<< /Type /Catalog /Pages 2 0 R >>'
      : `<< /Type /Catalog /Pages 2 0 R /Outlines ${String(outlineRoot)} 0 R >>`,
  );
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`);

  for (const [index, body] of pages.entries()) {
    const contents = pageObject(index) + 1;
    const font =
      '/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>';
    objects.push(
      body.length === 0
        ? `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${font} >>`
        : `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${font} /Contents ${String(contents)} 0 R >>`,
    );
    const stream = `BT /F1 12 Tf 72 720 Td (${escapeText(body)}) Tj ET`;
    objects.push(`<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`);
  }

  if (bookmarks.length > 0) {
    const first = outlineRoot + 1;
    const last = first + bookmarks.length - 1;
    objects.push(
      `<< /Type /Outlines /First ${String(first)} 0 R /Last ${String(last)} 0 R /Count ${String(bookmarks.length)} >>`,
    );
    for (const [index, bookmark] of bookmarks.entries()) {
      const self = first + index;
      const links = [
        index > 0 ? `/Prev ${String(self - 1)} 0 R` : '',
        index < bookmarks.length - 1 ? `/Next ${String(self + 1)} 0 R` : '',
      ]
        .filter((part) => part.length > 0)
        .join(' ');
      objects.push(
        `<< /Title (${escapeText(bookmark.title)}) /Parent ${String(outlineRoot)} 0 R ${links} /Dest [${String(pageObject(bookmark.page - 1))} 0 R /Fit] >>`,
      );
    }
  }

  const info = [
    options.title === undefined ? '' : `/Title (${escapeText(options.title)})`,
    options.author === undefined ? '' : `/Author (${escapeText(options.author)})`,
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  return assemble(objects, info.length === 0 ? '' : `/Info << ${info} >> `);
}

/**
 * A PDF that declares encryption — EPIC-026 §8.5.
 *
 * The `/O` and `/U` strings are not derived from any password, so `pdfjs`
 * rejects the empty password and raises `PasswordException` before reading a
 * page. That is the code path under test: refusing without attempting.
 */
export function buildEncryptedPdf(): Uint8Array {
  const id = '<0102030405060708090a0b0c0d0e0f10>';
  return assemble(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
      `<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -1 >>`,
    ],
    `/Encrypt 4 0 R /ID [${id} ${id}] `,
  );
}

/** Bytes that begin like a PDF and are not one. */
export function buildMalformedPdf(): Uint8Array {
  return new Uint8Array(Buffer.from('%PDF-1.7\nthis is not a document\n%%EOF\n', 'latin1'));
}

/** `(`, `)` and `\` end or escape a PDF string literal. */
function escapeText(value: string): string {
  return value.replace(/([\\()])/gu, '\\$1');
}
