/** What no arm may read, and why the list is this one's rather than a shared one. */

import { EXCLUDED_PREFIXES } from '../../lib/identity.mjs';

/** Every path prefix withheld from both arms, at read time and at index time. */
export const EXCLUDED = Object.freeze([
  ...EXCLUDED_PREFIXES,
  'docs/evidence/FERRET-CAN-A-FRESH-AGENT-FIND-IT.md',
  'docs/evidence/FERRET-DOES-A-REAL-AGENT-DO-BETTER.md',
  'docs/evidence/FERRET-DELIVERY-COST-MEASURED.md',
  // EPIC-137's own specification, decisions record and registry line. The
  // anchors experiment asks how verification is decided, and all three state
  // the mechanism in prose — the spec gives the six conditions verbatim. A
  // session must reach it from the implementation or not at all.
  'docs/EPICs/EPIC-137-Code-State-Anchored-Durable-Context.md',
  'docs/Architecture/EPIC-137-DECISIONS.md',
  'docs/EPICs/README.md',
]);

/**
 * The same list as patterns Ferret will match, whatever build is under test.
 *
 * `EXCLUDED` carries trailing slashes because those entries are string prefixes.
 * A Ferret `exclude` rule is a glob, and on the tree this phase started from a
 * trailing slash made the rule match nothing — silently, which is how the defect
 * was found. The harness must not depend on its own fix being present: Session A
 * deliberately runs against the tree before it, and an answer key that becomes
 * readable when a fix is reverted is not a guard.
 */
export function ferretExclusions() {
  return EXCLUDED.map((prefix) => prefix.replace(/\/+$/, ''));
}

/** Whether a repository-relative path is withheld. */
export function isExcluded(path) {
  const normalized = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  return EXCLUDED.some((prefix) => normalized.startsWith(prefix));
}
