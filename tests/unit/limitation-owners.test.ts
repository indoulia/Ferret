import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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

const DOCS = fileURLToPath(new URL('../../docs/EPICs/', import.meta.url));
const VALIDATION = join(DOCS, 'validation');

/** A registry row's status, keyed by Epic number. */
function registryStatuses(): ReadonlyMap<string, string> {
  const registry = readFileSync(join(DOCS, 'README.md'), 'utf8');
  const statuses = new Map<string, string>();
  for (const line of registry.split('\n')) {
    const match = /^- \*\*EPIC-(\d{3})[^*]*\*\*(.*)$/.exec(line.trim());
    if (match === null) continue;
    const rest = match[2] ?? '';
    // The status is the last all-caps word on the row, when there is one.
    const status = /\b(VALIDATED|IMPLEMENTED|APPROVED|DONE|DRAFT)\b/.exec(rest);
    statuses.set(match[1] as string, status === null ? 'OPEN' : (status[1] as string));
  }
  return statuses;
}

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
  const statuses = registryStatuses();
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

    expect(parked.length, parked.join('\n')).toBe(72);
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
