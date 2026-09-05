import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EPIC_DOCS, catalogRows } from '../helpers/registry.js';

/**
 * A limitation may not be parked on a closed Epic — issue #117.
 *
 * Nine limitation rows across four validation documents named **EPIC-032** as
 * the owner of live work whose scope that Epic never covered — and EPIC-032's
 * own §4 says so. EPIC-076 then added a tenth while assigning the file tree
 * *back* to EPIC-032, so two closed Epics pointed at each other over the same
 * work.
 *
 * EPIC-076 named the class of defect and had no scope to fix it: *"Nothing
 * sweeps limitation tables for records the code has outgrown, so the next stale
 * one will also wait for an Epic to be pointed at it."* This is the sweep.
 *
 * **What it refuses:** a limitation whose owner is an Epic the registry records
 * as closed. **What it permits:** a limitation with no owner at all. Those are
 * different facts and only one of them is a defect — an unowned limitation is an
 * honest absence, and issue #117 left three rows that way deliberately rather
 * than guessing. A row pointed at a closed Epic is a promise nobody is keeping.
 */

const VALIDATION = join(EPIC_DOCS, 'validation');

/** An Epic that can still take new work. */
function isOpen(status: string | undefined): boolean {
  // `undefined` means the registry has no such row, which is its own defect and
  // is reported separately below.
  return status === 'OPEN' || status === 'APPROVED' || status === 'DRAFT';
}

interface Reference {
  readonly file: string;
  readonly line: number;
  readonly epic: string;
  readonly text: string;
}

/**
 * Owner cells, and the Epics they name.
 *
 * An **owner** is a table cell that is *entirely* one or more bolded Epic
 * references — `**EPIC-078**`, or `**EPIC-066**, **EPIC-070**`. That precision
 * is the point: the first draft of this sweep matched every `EPIC-0NN` inside a
 * limitation section and found 291, almost all of them references to another
 * Epic's *reasoning* rather than a promise it would do more work. A ceiling of
 * 291 asserts nothing.
 *
 * `**unassigned**` and `*none — accepted*` are owners too, and legitimate ones:
 * issue #117's own distinction is that an unowned limitation is an honest
 * absence while one pointed at a closed Epic is a promise nobody is keeping.
 */
function ownerReferences(): readonly Reference[] {
  const found: Reference[] = [];
  const files = readdirSync(VALIDATION).filter((name) => name.endsWith('.md'));

  for (const file of files) {
    const text = readFileSync(join(VALIDATION, file), 'utf8');

    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim().startsWith('|')) continue;
      // A struck row is a closed one: `~~...~~` is how this project records
      // that a limitation no longer applies, so its old owner is history
      // rather than a live promise.
      if (line.includes('~~')) continue;

      for (const raw of line.split('|')) {
        const cell = raw.trim();
        if (cell.length === 0) continue;
        // Entirely bolded Epic references, and nothing else.
        if (!/^(?:\*\*EPIC-\d{3}\*\*(?:,\s*)?)+$/.test(cell)) continue;
        for (const match of cell.matchAll(/EPIC-(\d{3})/g)) {
          found.push({ file, line: index + 1, epic: match[1] as string, text: line.trim().slice(0, 160) });
        }
      }
    }
  }
  return found;
}

describe('a limitation is not parked on a closed Epic — issue #117', () => {
  const statuses = catalogRows();
  const references = ownerReferences();

  it('finds the registry and the validation documents, so a pass is not an empty one', () => {
    // The failure mode this guards: a regex that stops matching turns the whole
    // sweep into a test that asserts nothing and keeps passing.
    expect(statuses.size).toBeGreaterThan(90);
    expect(references.length).toBeGreaterThan(20);
  });

  it('names every Epic it references in the registry', () => {
    const unknown = references.filter((one) => !statuses.has(one.epic));

    expect(
      unknown.map((one) => `${one.file}:${String(one.line)} names EPIC-${one.epic}, which the registry does not list`),
    ).toStrictEqual([]);
  });

  it('pins how many limitations are owned by a closed Epic — issue #117', () => {
    // **The sweep issue #117 asked for**, and the number it found.
    //
    // 72 owner cells name an Epic the registry now records as closed. Most were
    // correct when written and the owner has since *delivered* the work —
    // "no traversal depth or cycle protection → **EPIC-050**" is a row EPIC-050
    // closed. Those should be struck, not re-owned, and striking each needs a
    // reader to confirm the work actually landed: that is 72 judgements across
    // forty documents, not a mechanical rewrite.
    //
    // So this pins the count rather than asserting zero. A 73rd fails the
    // build, which is the whole ask — EPIC-076 recorded the defect as "nothing
    // sweeps limitation tables for records the code has outgrown, so the next
    // stale one will also wait for an Epic to be pointed at it." The next stale
    // one now fails a test instead.
    //
    // Striking one also fails, deliberately: the number coming down is a good
    // change and still a reviewable one.
    const parked = references
      .filter((one) => !isOpen(statuses.get(one.epic)))
      .map(
        (one) =>
          `${one.file}:${String(one.line)} → EPIC-${one.epic} (${String(statuses.get(one.epic))})`,
      );

    // 72 -> 68 on 2026-09-03, EPIC-021. Not because the sweep changed: making
    // EPIC-021 VALIDATED would have parked a *seventy-third* row, and the row
    // in question -- "seven of eight capabilities have no implementation" --
    // had been stale for a dozen Epics. Re-measured and rewritten rather than
    // re-pinned, which removed five parked owners and added none. The pin
    // moves down when a claim is corrected; that it moves at all is the point.
    // 68 -> 67 on 2026-09-03, EPIC-051: EPIC-006 own "identity resolution is
    // not implemented" row was narrowed rather than struck, and its EPIC-051
    // owner stopped being parked. The pin has now moved down twice for the
    // same reason -- a stale claim corrected -- and up none.
    // 67 -> 68 on 2026-09-05, catalog reconciliation. The first upward move,
    // and no new stale row: this sweep read the whole README, so the prose
    // bullet "- **EPIC-094 AC-11 / issue #101.** ..." was taken for a catalog
    // row and overwrote EPIC-094's real status with an open one. EPIC-032 and
    // EPIC-118 were shadowed the same way. Reading only the catalog section
    // made EPIC-094 closed again and revealed the third owner of a row already
    // parked twice -- EPIC-010's "nothing rebuilds a stale derived artefact",
    // owned by EPIC-031, EPIC-054 and EPIC-094.
    expect(parked.length, parked.join('\n')).toBe(68);
  });

  it('permits a limitation with no owner, which is an honest absence', () => {
    // Issue #117's own distinction, and the reason this sweep does not simply
    // require an owner: three rows had no determinable owner and now read
    // `unassigned` rather than a guess. An unowned limitation is a fact; one
    // pointed at a closed Epic is a promise nobody is keeping.
    const unassigned = readdirSync(VALIDATION)
      .filter((name) => name.endsWith('.md'))
      .filter((name) => readFileSync(join(VALIDATION, name), 'utf8').includes('unassigned'));

    expect(unassigned.length).toBeGreaterThan(0);
  });
});
