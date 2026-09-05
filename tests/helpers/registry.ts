import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** `docs/EPICs/`, the authoritative delivery map and its validation records. */
export const EPIC_DOCS = fileURLToPath(new URL('../../docs/EPICs/', import.meta.url));

/** The catalog heading a row must live under to be a row. */
const CATALOG = '## Approved functional Epic catalog';

/**
 * Every Epic the registry catalogs, keyed by number, valued by status.
 *
 * **Only the catalog section is read.** The registry's prose uses the same
 * bullet shape — `- **EPIC-094 AC-11 / issue #101.** The filed cause blamed…` —
 * and a parser that reads the whole file takes that sentence for a row and
 * overwrites the real one. It did: EPIC-032, EPIC-094 and EPIC-118 all read as
 * open Epics because a paragraph below the catalog mentioned them at the start
 * of a bullet.
 */
export function catalogRows(): ReadonlyMap<string, string> {
  const lines = readFileSync(join(EPIC_DOCS, 'README.md'), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(CATALOG));
  if (start < 0) throw new Error(`docs/EPICs/README.md has no "${CATALOG}" heading`);
  const after = lines.findIndex((line, index) => index > start && line.startsWith('## '));

  const rows = new Map<string, string>();
  for (const line of lines.slice(start, after < 0 ? lines.length : after)) {
    const match = /^- \*\*EPIC-(\d{3})[^*]*\*\*(.*)$/.exec(line.trim());
    if (match === null) continue;
    // The status is the first all-caps status word on the row, when there is
    // one. `CLOSED` is a status: EPIC-115 is the catalog's first closed row.
    const status = /\b(VALIDATED|IMPLEMENTED|APPROVED|CLOSED|DONE|DRAFT)\b/.exec(match[2] ?? '');
    rows.set(match[1] as string, status === null ? 'OPEN' : (status[1] as string));
  }
  return rows;
}
