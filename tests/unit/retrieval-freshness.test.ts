import { describe, expect, it } from 'vitest';

import type { CanonicalEntity } from '../../src/domain/index.js';
import { LIVE_STANDING, rank, standing, type SearchHit } from '../../src/retrieval/index.js';

/**
 * EPIC-057, without a database.
 *
 * Standing is a pure function of a recorded lifecycle and the ordering is a pure
 * function of a pool, so every rule in §8 can be provoked from hand-built hits
 * where the right answer is known on paper. The claim that needs a real index —
 * that a tombstoned entity is *returned* and merely ranked lower — is in the
 * integration suite.
 */

interface Candidate {
  readonly id: string;
  readonly score: number;
  readonly kind?: string;
  readonly lifecycle?: string;
  readonly authority?: number;
  readonly observedAt?: string;
}

function entity(candidate: Candidate): CanonicalEntity {
  return Object.freeze({
    id: candidate.id,
    kind: candidate.kind ?? 'file',
    canonicalKey: `key-${candidate.id}`,
    schemaVersion: 1,
    source: Object.freeze({ system: 'git', id: candidate.id }),
    lifecycle: candidate.lifecycle ?? 'active',
    attributes: Object.freeze({}),
    unknownFields: Object.freeze({}),
    externalIds: Object.freeze([]),
    sourceObservedAt: candidate.observedAt,
    contentHash: `hash-${candidate.id}`,
  }) as CanonicalEntity;
}

function hit(candidate: Candidate): SearchHit & { readonly authority?: number } {
  return {
    source: 'entity',
    entity: entity(candidate),
    evidence: undefined,
    score: candidate.score,
    highlight: undefined,
    ...(candidate.authority === undefined ? {} : { authority: candidate.authority }),
  };
}

const ids = (hits: readonly { entity: CanonicalEntity }[]): string[] =>
  hits.map((one) => one.entity.id);

describe('standing is a band ordered by what the lifecycle says — AC-1 to AC-4', () => {
  it('orders the four recorded states, with unknown between and superseded worst', () => {
    const bands = ['active', 'unknown', 'deleted', 'superseded'].map((lifecycle) =>
      standing(entity({ id: lifecycle, score: 0, lifecycle })),
    );

    expect(bands).toStrictEqual([...bands].sort((a, b) => a - b));
    expect(bands[0]).toBe(LIVE_STANDING);
    // Not merely sorted — the two orderings that are decisions rather than
    // obvious. `unknown` is unassessed, not disbelieved; a superseded entity's
    // replacement is retrievable, so returning the old one is wrong in a way
    // returning a deleted one is not.
    expect(standing(entity({ id: 'u', score: 0, lifecycle: 'unknown' }))).toBeLessThan(
      standing(entity({ id: 'd', score: 0, lifecycle: 'deleted' })),
    );
    expect(standing(entity({ id: 'd', score: 0, lifecycle: 'deleted' }))).toBeLessThan(
      standing(entity({ id: 's', score: 0, lifecycle: 'superseded' })),
    );
  });

  it('ranks a deleted hit below every live one even when it matches better — AC-1', () => {
    // The defect this Epic exists for. Nothing in the read path consulted
    // `lifecycle`, so "where is the retry policy" could answer with a file
    // EPIC-032 tombstoned six months ago because its text matched slightly
    // better.
    const ranked = rank(
      [hit({ id: 'retired', score: 0.99, lifecycle: 'deleted' }), hit({ id: 'live', score: 0.10 })],
      10,
    );

    expect(ids(ranked)).toStrictEqual(['live', 'retired']);
  });

  it('ranks superseded below deleted, and unknown between active and deleted — AC-2, AC-3', () => {
    const ranked = rank(
      [
        hit({ id: 'superseded', score: 0.9, lifecycle: 'superseded' }),
        hit({ id: 'deleted', score: 0.9, lifecycle: 'deleted' }),
        hit({ id: 'unknown', score: 0.9, lifecycle: 'unknown' }),
        hit({ id: 'active', score: 0.9 }),
      ],
      10,
    );

    expect(ids(ranked)).toStrictEqual(['active', 'unknown', 'deleted', 'superseded']);
  });

  it('treats an unrecognised lifecycle as unassessed and does not throw — AC-4', () => {
    // Entities come from providers. A ranking that throws on an unexpected
    // lifecycle takes the whole answer with it.
    const odd = hit({ id: 'odd', score: 0.9, lifecycle: 'quarantined' });
    const ranked = rank([odd, hit({ id: 'live', score: 0.9 }), hit({ id: 'gone', score: 0.9, lifecycle: 'deleted' })], 10);

    expect(ids(ranked)).toStrictEqual(['live', 'odd', 'gone']);
    expect(standing(odd.entity)).toBe(standing(entity({ id: 'u', score: 0, lifecycle: 'unknown' })));
  });
});

describe('within a band, relevance still decides — AC-5', () => {
  it('never puts a lower-relevance hit before a higher one', () => {
    const ranked = rank(
      [
        hit({ id: 'weak', score: 0.2 }),
        hit({ id: 'strong', score: 0.8 }),
        hit({ id: 'middling', score: 0.5 }),
      ],
      10,
    );

    expect(ids(ranked)).toStrictEqual(['strong', 'middling', 'weak']);
  });

  it('does not let authority or recency overturn relevance', () => {
    // A highly authoritative hit that barely matches is not what was asked for.
    // Standing is the only thing that outranks relevance.
    const ranked = rank(
      [
        hit({ id: 'authoritative', score: 0.2, authority: 100, observedAt: '2026-09-01T00:00:00.000Z' }),
        hit({ id: 'relevant', score: 0.8, authority: 20, observedAt: '2020-01-01T00:00:00.000Z' }),
      ],
      10,
    );

    expect(ids(ranked)).toStrictEqual(['relevant', 'authoritative']);
  });
});

describe('authority and recency act where relevance has tied — AC-6, AC-7', () => {
  it('prefers the more authoritative of two equally relevant hits', () => {
    const ranked = rank(
      [hit({ id: 'parsed', score: 0.5, authority: 60 }), hit({ id: 'observed', score: 0.5, authority: 80 })],
      10,
    );

    expect(ids(ranked)).toStrictEqual(['observed', 'parsed']);
  });

  it('treats an absent authority as unassessed, not as weakest — AC-6', () => {
    // `UNKNOWN` is the lowest number and not the lowest meaning. Sorting it as
    // zero would rank every source Ferret has not classified below a model's
    // unverified claim.
    const ranked = rank(
      [hit({ id: 'asserted', score: 0.5, authority: 20 }), hit({ id: 'unassessed', score: 0.5 })],
      10,
    );

    expect(ids(ranked)).toStrictEqual(['unassessed', 'asserted']);
  });

  it('orders equally authoritative hits by recency, newest first — AC-7', () => {
    const ranked = rank(
      [
        hit({ id: 'older', score: 0.5, authority: 80, observedAt: '2024-01-01T00:00:00.000Z' }),
        hit({ id: 'newer', score: 0.5, authority: 80, observedAt: '2026-01-01T00:00:00.000Z' }),
      ],
      10,
    );

    expect(ids(ranked)).toStrictEqual(['newer', 'older']);
  });

  it('does not let a missing timestamp precede a present one — AC-7', () => {
    // An absent timestamp is unknown, not old. It sorts last without being
    // called old, and two hits that both lack one fall through to identity.
    const ranked = rank(
      [
        hit({ id: 'undated', score: 0.5, authority: 80 }),
        hit({ id: 'dated', score: 0.5, authority: 80, observedAt: '2020-01-01T00:00:00.000Z' }),
      ],
      10,
    );

    expect(ids(ranked)).toStrictEqual(['dated', 'undated']);
  });
});

describe('the order stays total, and nothing is dropped — AC-8, AC-9', () => {
  it('ranks a pool identically however it arrives', () => {
    const pool = [
      hit({ id: 'b', score: 0.5, lifecycle: 'deleted' }),
      hit({ id: 'a', score: 0.5 }),
      hit({ id: 'c', score: 0.5, authority: 80 }),
      hit({ id: 'd', score: 0.5, lifecycle: 'superseded' }),
    ];

    expect(ids(rank(pool, 10))).toStrictEqual(ids(rank([...pool].reverse(), 10)));
  });

  it('returns the deleted hit rather than filtering it — AC-9', () => {
    // Standing reorders and nothing else. A deleted file that matches is still
    // an answer to "what used to be here"; it is just not the answer while
    // something live matches too.
    const pool = [hit({ id: 'live', score: 0.5 }), hit({ id: 'gone', score: 0.9, lifecycle: 'deleted' })];
    const ranked = rank(pool, 10);

    expect(ranked).toHaveLength(2);
    expect(new Set(ids(ranked))).toStrictEqual(new Set(ids(pool)));
  });

  it('returns the deleted hit alone when it is the only one', () => {
    const ranked = rank([hit({ id: 'gone', score: 0.9, lifecycle: 'deleted' })], 10);

    expect(ids(ranked)).toStrictEqual(['gone']);
  });
});

describe('the breakdown says which it was — AC-10', () => {
  it('names the standing on every hit and explains only the ones it moved', () => {
    const ranked = rank(
      [
        hit({ id: 'live', score: 0.5 }),
        hit({ id: 'gone', score: 0.5, lifecycle: 'deleted' }),
        hit({ id: 'replaced', score: 0.5, lifecycle: 'superseded' }),
        hit({ id: 'unseen', score: 0.5, lifecycle: 'unknown' }),
      ],
      10,
    );
    const [live, unseen, gone, replaced] = ranked;

    expect(live?.ranking.standing).toBe(LIVE_STANDING);
    // A sentence on every result saying "this is live" is noise a reader learns
    // to skip, and then does not read the one that matters.
    expect(live?.ranking.why).toBeUndefined();

    expect(gone?.ranking.why).toContain('removed');
    expect(replaced?.ranking.why).toContain('replacement');
    expect(unseen?.ranking.why).toContain('has not observed');
    for (const one of [gone, replaced, unseen]) {
      expect(one?.ranking.standing).toBeGreaterThan(LIVE_STANDING);
    }
  });

  it('explains an unrecognised lifecycle by naming it', () => {
    const ranked = rank([hit({ id: 'odd', score: 0.5, lifecycle: 'quarantined' })], 10);

    expect(ranked[0]?.ranking.why).toContain('quarantined');
  });
});

describe('a malformed hit ranks rather than throws', () => {
  it('ranks an authority off the scale as the number it is', () => {
    const ranked = rank(
      [hit({ id: 'off-scale', score: 0.5, authority: 999 }), hit({ id: 'observed', score: 0.5, authority: 80 })],
      10,
    );

    expect(ids(ranked)).toStrictEqual(['off-scale', 'observed']);
  });

  it('ranks an unparseable observation time without throwing', () => {
    const ranked = rank(
      [
        hit({ id: 'nonsense', score: 0.5, authority: 80, observedAt: 'not-a-date' }),
        hit({ id: 'dated', score: 0.5, authority: 80, observedAt: '2026-01-01T00:00:00.000Z' }),
      ],
      10,
    );

    // Compared as strings, which is what an ISO-8601 instant is ordered by
    // anyway. Garbage sorts somewhere; it does not crash the answer.
    expect(ranked).toHaveLength(2);
    expect(new Set(ids(ranked))).toStrictEqual(new Set(['nonsense', 'dated']));
  });
});
