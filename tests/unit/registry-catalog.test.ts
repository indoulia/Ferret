import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EPIC_DOCS, catalogRows } from '../helpers/registry.js';

/**
 * An Epic with a document has a row in the registry.
 *
 * `docs/EPICs/README.md` is the authoritative delivery map, and three times now
 * it has been the last thing to hear that an Epic shipped. EPIC-109–112 were
 * specified, implemented, reviewed and merged before anyone noticed the catalog
 * was silent about them; EPIC-113–117 shipped with validation records the
 * registry never listed; EPIC-118 remembered to add its own row, which is the
 * point — it was remembered rather than checked.
 *
 * **What it refuses:** an Epic with a specification or a validation record and
 * no registry row. **What it permits:** a registry row with no document. Those
 * are different facts. The registry approves Epics 011 onward *by name, domain
 * and priority*, and says plainly that each specification is written as the
 * first part of that Epic's own change — so a row that has no file yet is the
 * documented order of work, and a file that has no row is a delivery the map
 * does not show.
 */

const VALIDATION = join(EPIC_DOCS, 'validation');

interface Document {
  readonly file: string;
  readonly epic: string;
}

/**
 * Every Epic number named by a document's file name.
 *
 * A file may cover several Epics — `EPIC-102-103-104-Distribution.md` and
 * `EPIC-037-038-VALIDATION.md` are both real — so the leading run of numbers is
 * read whole. Only the leading run: a title is not an Epic reference, and
 * matching one would invent Epics out of prose.
 */
function documents(): readonly Document[] {
  const found: Document[] = [];
  const sources: readonly (readonly [string, readonly string[]])[] = [
    [
      EPIC_DOCS,
      readdirSync(EPIC_DOCS, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    ],
    [VALIDATION, readdirSync(VALIDATION)],
  ];

  for (const [dir, names] of sources) {
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const prefix = /^EPIC(?:-\d{3})+/.exec(name);
      if (prefix === null) continue;
      for (const match of prefix[0].matchAll(/(\d{3})/g)) {
        found.push({ file: join(dir, name).slice(EPIC_DOCS.length), epic: match[1] as string });
      }
    }
  }
  return found;
}

describe('the registry lists every Epic that has a document', () => {
  const rows = catalogRows();
  const docs = documents();

  it('finds the registry and the documents, so a pass is not an empty one', () => {
    // The failure mode this guards: a file layout change stops matching and the
    // sweep asserts nothing while still passing.
    expect(rows.size).toBeGreaterThan(100);
    expect(docs.length).toBeGreaterThan(100);
  });

  it('has a catalog row for every specified or validated Epic', () => {
    const missing = docs
      .filter((one) => !rows.has(one.epic))
      .map((one) => `${one.file} documents EPIC-${one.epic}, which the registry does not list`);

    expect([...new Set(missing)].sort()).toStrictEqual([]);
  });
});
