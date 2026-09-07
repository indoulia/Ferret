import { describe, expect, it } from 'vitest';

import {
  AnchorVerdict,
  CORRESPONDENCE_UNAVAILABLE,
  UnknownReason,
  verifyAnchors,
  type AnchoredObservation,
  type Correspondence,
  type CurrentContent,
  type VerifyInput,
} from '../../src/context/code-state.js';
import { LifecycleState } from '../../src/domain/index.js';

const CORRESPONDS: Correspondence = Object.freeze({
  established: true,
  reason: undefined,
  dirtyPaths: new Set<string>(),
  dirtySampleTruncated: false,
});

function observation(hash: string, path = 'src/config/exclusions.ts', at = '2026-09-08T00:00:00.000Z'): AnchoredObservation {
  return { evidenceId: `ev-${hash}`, observedAt: at, anchors: [{ path, symbol: 'matchesExclusion', contentHash: hash, fileId: 'file-1' }] };
}

function content(entries: Record<string, string | CurrentContent>): ReadonlyMap<string, CurrentContent> {
  return new Map(
    Object.entries(entries).map(([path, value]) => [
      path,
      typeof value === 'string' ? { contentHash: value, withheld: undefined } : value,
    ]),
  );
}

function input(overrides: Partial<VerifyInput> = {}): VerifyInput {
  return {
    lifecycle: LifecycleState.ACTIVE,
    supersededBy: undefined,
    observations: [observation('git-blob:aaa')],
    current: content({ 'src/config/exclusions.ts': 'git-blob:aaa' }),
    correspondence: CORRESPONDS,
    ...overrides,
  };
}

describe('verifyAnchors', () => {
  it('AC-6: matching anchor with correspondence is verified', () => {
    const result = verifyAnchors(input());
    expect(result.verdict).toBe(AnchorVerdict.VERIFIED);
    expect(result.anchors).toHaveLength(1);
    expect(result.anchors[0]).toMatchObject({
      path: 'src/config/exclusions.ts',
      observedHash: 'git-blob:aaa',
      currentHash: 'git-blob:aaa',
      matches: true,
    });
  });

  it('AC-7: a changed anchored file is stale, and stale is not falsity', () => {
    const result = verifyAnchors(input({ current: content({ 'src/config/exclusions.ts': 'git-blob:bbb' }) }));
    expect(result.verdict).toBe(AnchorVerdict.STALE);
    expect(result.anchors[0]).toMatchObject({ observedHash: 'git-blob:aaa', currentHash: 'git-blob:bbb', matches: false });
    expect(result.detail).toContain('not that it is false');
  });

  it('AC-8: an unrelated file changing leaves the verdict verified', () => {
    const result = verifyAnchors(
      input({ current: content({ 'src/config/exclusions.ts': 'git-blob:aaa', 'README.md': 'git-blob:zzz' }) }),
    );
    expect(result.verdict).toBe(AnchorVerdict.VERIFIED);
  });

  it('AC-9: reverting to the observed content verifies again', () => {
    const drifted = verifyAnchors(input({ current: content({ 'src/config/exclusions.ts': 'git-blob:bbb' }) }));
    expect(drifted.verdict).toBe(AnchorVerdict.STALE);
    const reverted = verifyAnchors(input({ current: content({ 'src/config/exclusions.ts': 'git-blob:aaa' }) }));
    expect(reverted.verdict).toBe(AnchorVerdict.VERIFIED);
  });

  it('AC-11: no correspondence is unknown, never verified, even when the hash matches', () => {
    const result = verifyAnchors(input({ correspondence: { ...CORRESPONDS, established: false, reason: UnknownReason.NO_CORRESPONDENCE } }));
    expect(result.verdict).toBe(AnchorVerdict.UNKNOWN);
    expect(result.reason).toBe(UnknownReason.NO_CORRESPONDENCE);
    expect(result.anchors[0]?.matches).toBe(true);
  });

  it('AC-11: a non-local scope is unknown', () => {
    const result = verifyAnchors(input({ correspondence: CORRESPONDENCE_UNAVAILABLE }));
    expect(result.verdict).toBe(AnchorVerdict.UNKNOWN);
    expect(result.reason).toBe(UnknownReason.NOT_LOCAL);
  });

  it('AC-11: a dirty anchored path is unknown rather than verified', () => {
    const result = verifyAnchors({
      ...input(),
      current: content({ 'src/config/exclusions.ts': { contentHash: 'git-blob:aaa', withheld: UnknownReason.PATH_DIRTY } }),
    });
    expect(result.verdict).toBe(AnchorVerdict.UNKNOWN);
    expect(result.reason).toBe(UnknownReason.PATH_DIRTY);
  });

  it('AC-11: an anchor that no longer resolves is unknown, not unchanged', () => {
    const result = verifyAnchors(input({ current: content({}) }));
    expect(result.verdict).toBe(AnchorVerdict.UNKNOWN);
    expect(result.reason).toBe(UnknownReason.ANCHOR_UNRESOLVED);
  });

  it('AC-12: no anchored observation is unanchored, distinct from unknown', () => {
    const result = verifyAnchors(input({ observations: [] }));
    expect(result.verdict).toBe(AnchorVerdict.UNANCHORED);
    expect(result.reason).toBeUndefined();
  });

  it('AC-15: supersession outranks a matching anchor', () => {
    const result = verifyAnchors(input({ supersededBy: 'ctx-2' }));
    expect(result.verdict).toBe(AnchorVerdict.SUPERSEDED);
  });

  it('AC-15: a superseded lifecycle is superseded even with no edge recorded', () => {
    const result = verifyAnchors(input({ lifecycle: LifecycleState.SUPERSEDED }));
    expect(result.verdict).toBe(AnchorVerdict.SUPERSEDED);
  });

  it('an archived statement claims no code state', () => {
    const result = verifyAnchors(input({ lifecycle: LifecycleState.ARCHIVED }));
    expect(result.verdict).toBe(AnchorVerdict.UNANCHORED);
  });

  it('AC-21: a re-anchored observation verifies while the older one stays stale', () => {
    const result = verifyAnchors(
      input({
        observations: [observation('git-blob:aaa'), observation('git-blob:bbb', 'src/config/exclusions.ts', '2026-09-09T00:00:00.000Z')],
        current: content({ 'src/config/exclusions.ts': 'git-blob:bbb' }),
      }),
    );
    expect(result.verdict).toBe(AnchorVerdict.VERIFIED);
    expect(result.anchors[0]?.observedHash).toBe('git-blob:bbb');
  });

  it('reports the newest observation when none matches', () => {
    const result = verifyAnchors(
      input({
        observations: [observation('git-blob:aaa'), observation('git-blob:bbb', 'src/config/exclusions.ts', '2026-09-09T00:00:00.000Z')],
        current: content({ 'src/config/exclusions.ts': 'git-blob:ccc' }),
      }),
    );
    expect(result.verdict).toBe(AnchorVerdict.STALE);
    expect(result.anchors[0]?.observedHash).toBe('git-blob:bbb');
  });

  it('every anchor must match: one drifted file of two is not verified', () => {
    const result = verifyAnchors(
      input({
        observations: [
          {
            evidenceId: 'ev-multi',
            observedAt: '2026-09-08T00:00:00.000Z',
            anchors: [
              { path: 'a.ts', contentHash: 'git-blob:1', fileId: 'f1', symbol: undefined },
              { path: 'b.ts', contentHash: 'git-blob:2', fileId: 'f2', symbol: undefined },
            ],
          },
        ],
        current: content({ 'a.ts': 'git-blob:1', 'b.ts': 'git-blob:9' }),
      }),
    );
    expect(result.verdict).toBe(AnchorVerdict.STALE);
  });

  it('AC-16: a withheld anchor never discloses the path state as a match', () => {
    for (const reason of [UnknownReason.NOT_PERMITTED, UnknownReason.EXCLUDED] as const) {
      const result = verifyAnchors({
        ...input(),
        current: content({ 'src/config/exclusions.ts': { contentHash: undefined, withheld: reason } }),
      });
      expect(result.verdict).toBe(AnchorVerdict.UNKNOWN);
      expect(result.reason).toBe(reason);
      expect(result.anchors[0]?.currentHash).toBeUndefined();
    }
  });
});
