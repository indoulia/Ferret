import { describe, expect, it } from 'vitest';

import {
  PUBLIC_ACCESS,
  SCOPE_SEPARATOR,
  permits,
  scopeDescendantPattern,
  scopeGrants,
  type AccessContext,
} from '../../src/retrieval/index.js';

/**
 * What a permission scope means — EPIC-083 AC-5, AC-6, AC-7.
 *
 * Until this Epic a scope was an opaque token compared by string equality, and
 * four records parked deciding what one *means* here: `Checkpoints/EPIC-008.md:128`,
 * `validation/EPIC-008-VALIDATION.md:136`, EPIC-058 §4, and
 * `validation/EPIC-066-VALIDATION.md:202` — "EPIC-083 still owns what a scope means".
 *
 * The rule is the smallest useful one: a `:`-separated path where a grant covers
 * itself and its descendants. The tests that matter are the near-misses.
 */

const holding = (...scopes: readonly string[]): AccessContext => ({
  ...PUBLIC_ACCESS,
  permittedScopes: scopes,
});

describe('scopeGrants — AC-5', () => {
  it('grants a scope identical to the grant', () => {
    expect(scopeGrants('jira:proj-a', 'jira:proj-a')).toBe(true);
  });

  it('grants a descendant of the grant', () => {
    expect(scopeGrants('jira:proj-a', 'jira:proj-a:issue-1')).toBe(true);
    expect(scopeGrants('jira', 'jira:proj-a:issue-1')).toBe(true);
  });

  it('does not grant a sibling whose name merely starts the same way', () => {
    // The whole reason this is not `startsWith`. `jira:proj-ab` is a different
    // project, and a bare prefix test would hand it over silently — which is the
    // failure mode of every prefix-matching authorization bug there has been.
    expect(scopeGrants('jira:proj-a', 'jira:proj-ab')).toBe(false);
    expect(scopeGrants('jira:proj-a', 'jira:proj-ab:issue-1')).toBe(false);
  });

  it('does not grant an ancestor of the grant', () => {
    // Holding a leaf must not confer the branch: `jira:proj-a:issue-1` says
    // nothing about the other issues in that project.
    expect(scopeGrants('jira:proj-a:issue-1', 'jira:proj-a')).toBe(false);
  });

  it('does not grant an unrelated scope', () => {
    expect(scopeGrants('jira:proj-a', 'confluence:space-a')).toBe(false);
  });

  it('is case-sensitive, because the token is opaque and not parsed', () => {
    // Ferret compares what a provider wrote. Folding case would be Ferret
    // deciding that two tokens a source considers distinct are the same.
    expect(scopeGrants('jira:Proj-A', 'jira:proj-a')).toBe(false);
  });
});

describe('scopeGrants — AC-7, total and denying what it does not understand', () => {
  it('denies an empty grant rather than treating it as a wildcard', () => {
    // `'' + ':'` is a prefix of every scoped token, so a blank line in a
    // configuration file must never become root access.
    expect(scopeGrants('', 'jira:proj-a')).toBe(false);
    expect(scopeGrants('', '')).toBe(false);
  });

  it('denies an empty scope', () => {
    expect(scopeGrants('jira', '')).toBe(false);
  });

  it('denies a separator-only grant', () => {
    expect(scopeGrants(SCOPE_SEPARATOR, 'jira:proj-a')).toBe(false);
  });

  it('never throws, whatever it is handed', () => {
    // It runs per row on the read path. EPIC-058 already learned that failing
    // loudly there turns a policy typo into an index that looks empty.
    const rubbish = [undefined, null, 42, {}, [], Symbol('s')] as unknown as string[];
    for (const value of rubbish) {
      expect(() => scopeGrants(value, 'jira:proj-a')).not.toThrow();
      expect(() => scopeGrants('jira:proj-a', value)).not.toThrow();
      expect(scopeGrants(value, 'jira:proj-a')).toBe(false);
      expect(scopeGrants('jira:proj-a', value)).toBe(false);
    }
  });

  it('is pure — the same answer every time, with no clock and no state', () => {
    const first = scopeGrants('jira:proj-a', 'jira:proj-a:issue-1');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(scopeGrants('jira:proj-a', 'jira:proj-a:issue-1')).toBe(first);
    }
  });
});

describe('permits, over the whole grant — AC-6', () => {
  it('still shows unscoped content to a caller holding nothing', () => {
    // The rule EPIC-058 chose and this Epic does not disturb: everything Ferret
    // indexes today is unscoped, and hiding it would be a different product
    // rather than a safer one.
    expect(permits(PUBLIC_ACCESS, undefined)).toBe(true);
  });

  it('withholds a scoped record from a caller holding nothing', () => {
    expect(permits(PUBLIC_ACCESS, 'jira:proj-a')).toBe(false);
  });

  it('shows a scoped record to a caller holding it exactly', () => {
    expect(permits(holding('jira:proj-a'), 'jira:proj-a')).toBe(true);
  });

  it('shows a descendant to a caller holding the parent', () => {
    expect(permits(holding('jira:proj-a'), 'jira:proj-a:issue-1')).toBe(true);
  });

  it('withholds the sibling near-miss through the whole grant', () => {
    expect(permits(holding('jira:proj-a'), 'jira:proj-ab')).toBe(false);
  });

  it('grants when any one of several grants matches', () => {
    expect(permits(holding('confluence:x', 'jira:proj-a'), 'jira:proj-a:issue-1')).toBe(true);
  });

  it('ignores an empty grant among real ones', () => {
    expect(permits(holding('', 'jira:proj-a'), 'confluence:space-a')).toBe(false);
  });
});

describe('scopeDescendantPattern — the SQL half of the same rule', () => {
  it('appends the separator and a wildcard', () => {
    expect(scopeDescendantPattern('jira:proj-a')).toBe('jira:proj-a:%');
  });

  it('escapes the LIKE metacharacters, so a grant matches what it names', () => {
    // Without this, a grant containing `%` would match far more than the scope
    // it spells — a caller-controlled pattern rather than a caller-supplied
    // value. `storage/retrieval.ts` guards the same hazard for abbreviated
    // object ids.
    expect(scopeDescendantPattern('jira:100%')).toBe('jira:100\\%:%');
    expect(scopeDescendantPattern('jira:a_b')).toBe('jira:a\\_b:%');
    expect(scopeDescendantPattern('jira:a\\b')).toBe('jira:a\\\\b:%');
  });
});
