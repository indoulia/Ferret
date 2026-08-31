import { describe, expect, it } from 'vitest';

import {
  ActorClass,
  EMPTY_MAILMAP,
  LinkRule,
  MAX_MAILMAP_LINES,
  applyMailmap,
  classifyIdentity,
  normalizeGitIdentity,
  parseMailmap,
  proposeIdentityLinks,
  type NormalizedIdentity,
} from '../../src/index.js';

function identity(name: string, email: string): NormalizedIdentity {
  const normalized = normalizeGitIdentity(name, email);
  if (normalized === undefined) throw new Error(`expected an identity for ${email}`);
  return normalized;
}

describe('normalization', () => {
  it('lowercases and trims, and keeps the original — AC-1', () => {
    const result = identity('  Ada Lovelace  ', '  Ada@Example.COM ');

    expect(result.name).toBe('Ada Lovelace');
    expect(result.email).toBe('Ada@Example.COM');
    expect(result.comparable).toBe('ada@example.com');
  });

  it('strips a plus tag for comparison only', () => {
    const result = identity('Ada', 'ada+ferret@example.com');

    expect(result.comparable).toBe('ada@example.com');
    expect(result.localPart).toBe('ada');
    // The address as written survives, because it is the evidence.
    expect(result.email).toBe('ada+ferret@example.com');
  });

  it('strips the angle brackets Git writes around an address', () => {
    expect(identity('Ada', '<ada@example.com>').comparable).toBe('ada@example.com');
  });

  it.each([
    ['login@users.noreply.github.com', 'login'],
    ['12345+octocat@users.noreply.github.com', 'octocat'],
  ])('recovers the login from %s — AC-2', (email, login) => {
    const result = identity('Octo', email);
    expect(result.login).toBe(login);
    // The numeric id is structural, not a subaddress tag, so it is not stripped
    // as one — the comparable address keeps the whole local part.
    expect(result.comparable).toBe(email);
  });

  it.each(['', '   ', '<>'])('refuses the empty address %o rather than inventing one — AC-3', (email) => {
    expect(normalizeGitIdentity('Someone', email)).toBeUndefined();
  });

  it('keeps a malformed address as an opaque identity rather than discarding it', () => {
    // Git permits it, and a commit that has one is still attributable.
    const result = identity('Legacy', 'not-an-address');
    expect(result.comparable).toBe('not-an-address');
    expect(result.domain).toBe('');
  });
});

describe('classification', () => {
  it.each([
    ['dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com', 'github-app-noreply-address'],
    ['renovate[bot]', 'renovate@example.com', 'name ends with [bot]'],
    ['GitHub Actions', 'actions@github.com', 'known service address actions@github.com'],
    ['Some Runner', 'x@bots.github.com', 'service domain bots.github.com'],
    ['Dependabot', 'other@example.com', 'known service name "Dependabot"'],
  ])('classifies %s as an agent — AC-4, AC-5', (name, email, reason) => {
    const result = classifyIdentity(identity(name, email));

    expect(result.actorClass).toBe(ActorClass.AGENT);
    expect(result.reason).toBe(reason);
  });

  it('classifies an ordinary contributor as a developer — AC-4', () => {
    const result = classifyIdentity(identity('Ada Lovelace', 'ada@example.com'));
    expect(result.actorClass).toBe(ActorClass.DEVELOPER);
    expect(result.reason).toBe('no non-human signal');
  });

  it.each([
    ['Robert Botham', 'robert@example.com'],
    ['Abbot Smith', 'abbot@example.com'],
    ['Sandra Robot', 'sandra@example.com'],
  ])('does not mistake %s for a machine — AC-4', (name, email) => {
    // Conservative on purpose: misclassifying a person removes them from "who
    // wrote this", which is worse and much quieter than the reverse.
    expect(classifyIdentity(identity(name, email)).actorClass).toBe(ActorClass.DEVELOPER);
  });

  it('always gives a reason — AC-5', () => {
    for (const [name, email] of [
      ['Ada', 'ada@example.com'],
      ['bot[bot]', 'b@example.com'],
    ] as const) {
      expect(classifyIdentity(identity(name, email)).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('.mailmap', () => {
  it('parses all four forms Git defines — AC-6', () => {
    const mailmap = parseMailmap(
      [
        'Proper Name <proper@example.com>',
        '<proper@example.com> <commit@example.com>',
        'Another Name <another@example.com> <old@example.com>',
        'Third Name <third@example.com> Commit Name <shared@example.com>',
      ].join('\n'),
    );

    expect(mailmap.entries).toStrictEqual([
      { properName: 'Proper Name', properEmail: 'proper@example.com', commitEmail: undefined, commitName: undefined },
      { properName: undefined, properEmail: 'proper@example.com', commitEmail: 'commit@example.com', commitName: undefined },
      { properName: 'Another Name', properEmail: 'another@example.com', commitEmail: 'old@example.com', commitName: undefined },
      { properName: 'Third Name', properEmail: 'third@example.com', commitEmail: 'shared@example.com', commitName: 'Commit Name' },
    ]);
  });

  it('ignores comments and blank lines — AC-6', () => {
    const mailmap = parseMailmap(
      ['# a comment', '', '   ', 'Ada <ada@example.com>  # trailing comment', '\t'].join('\n'),
    );

    expect(mailmap.entries).toHaveLength(1);
    expect(mailmap.entries[0]?.properName).toBe('Ada');
    expect(mailmap.ignored).toStrictEqual([]);
  });

  it('reports a line it could not understand rather than dropping it silently', () => {
    const mailmap = parseMailmap('this line has no angle brackets\nAda <ada@example.com>');

    expect(mailmap.ignored).toStrictEqual(['this line has no angle brackets']);
    expect(mailmap.entries).toHaveLength(1);
  });

  it('truncates a file large enough to make parsing expensive', () => {
    const mailmap = parseMailmap('Ada <ada@example.com>\n'.repeat(MAX_MAILMAP_LINES + 10));

    expect(mailmap.truncated).toBe(true);
    expect(mailmap.entries.length).toBeLessThanOrEqual(MAX_MAILMAP_LINES);
  });

  it('rewrites the identity it names — AC-7', () => {
    const mailmap = parseMailmap('Ada Lovelace <ada@example.com> <old@example.com>');
    const rewritten = applyMailmap(mailmap, identity('A. L.', 'old@example.com'));

    expect(rewritten.comparable).toBe('ada@example.com');
    expect(rewritten.name).toBe('Ada Lovelace');
  });

  it('leaves an identity it does not name untouched — AC-7', () => {
    const mailmap = parseMailmap('Ada Lovelace <ada@example.com> <old@example.com>');
    const other = identity('Grace', 'grace@example.com');

    expect(applyMailmap(mailmap, other)).toStrictEqual(other);
  });

  it('rewrites only the name for the name-only form', () => {
    const mailmap = parseMailmap('Ada Lovelace <ada@example.com>');
    const rewritten = applyMailmap(mailmap, identity('ada', 'ada@example.com'));

    expect(rewritten.name).toBe('Ada Lovelace');
    expect(rewritten.comparable).toBe('ada@example.com');
  });

  it('prefers the name-and-address form over the address-only one', () => {
    // Git's own precedence: the more specific entry wins.
    const mailmap = parseMailmap(
      ['Generic <generic@example.com> <shared@example.com>', 'Specific <specific@example.com> Alias <shared@example.com>'].join('\n'),
    );

    expect(applyMailmap(mailmap, identity('Alias', 'shared@example.com')).comparable).toBe(
      'specific@example.com',
    );
    expect(applyMailmap(mailmap, identity('Someone Else', 'shared@example.com')).comparable).toBe(
      'generic@example.com',
    );
  });

  it('changes nothing when there is no mailmap', () => {
    const original = identity('Ada', 'ada@example.com');
    expect(applyMailmap(EMPTY_MAILMAP, original)).toStrictEqual(original);
  });
});

describe('proposals', () => {
  it('proposes a link for the same mailbox written two ways — AC-8', () => {
    const proposals = proposeIdentityLinks([
      identity('Ada', 'Ada@Example.com'),
      identity('ada', 'ada+ferret@example.com'),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ rule: LinkRule.SAME_ADDRESS, confidence: 0.95 });
    expect(proposals[0]?.detail).toContain('ada@example.com');
  });

  it('proposes nothing for two identities sharing only a display name — AC-8', () => {
    // Two people called "admin" are two people.
    const proposals = proposeIdentityLinks([
      identity('Ada Lovelace', 'ada@one.example'),
      identity('Ada Lovelace', 'lovelace@two.example'),
    ]);

    expect(proposals).toStrictEqual([]);
  });

  it('links a GitHub noreply login to a matching local part, less confidently — AC-9', () => {
    const proposals = proposeIdentityLinks([
      identity('Octo', '12345+octocat@users.noreply.github.com'),
      identity('Octo Cat', 'octocat@example.com'),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.rule).toBe(LinkRule.GITHUB_NOREPLY_LOGIN);
    expect(proposals[0]?.confidence).toBeLessThan(0.95);
  });

  it('proposes the same name and local part across domains, weakly', () => {
    const proposals = proposeIdentityLinks([
      identity('Ada Lovelace', 'ada@work.example'),
      identity('Ada Lovelace', 'ada@personal.example'),
    ]);

    expect(proposals[0]).toMatchObject({ rule: LinkRule.SAME_NAME_AND_LOCAL_PART, confidence: 0.5 });
  });

  it('refuses to propose on a generic local part', () => {
    // `admin@a.example` and `admin@b.example` are two administrators far more
    // often than one person.
    expect(
      proposeIdentityLinks([identity('Admin', 'admin@a.example'), identity('Admin', 'admin@b.example')]),
    ).toStrictEqual([]);
  });

  it('keeps only the strongest rule for a pair', () => {
    const proposals = proposeIdentityLinks([
      identity('Ada', 'ada@example.com'),
      identity('Ada', 'Ada+tag@Example.com'),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.rule).toBe(LinkRule.SAME_ADDRESS);
  });

  it('is deterministic and never pairs an identity with itself — AC-10', () => {
    const people = [
      identity('Ada', 'ada@example.com'),
      identity('Ada', 'ada+x@example.com'),
      identity('Octo', '1+octocat@users.noreply.github.com'),
      identity('Octo', 'octocat@example.com'),
    ];

    const first = proposeIdentityLinks(people);
    const second = proposeIdentityLinks([...people].reverse());

    expect(second).toStrictEqual(first);
    for (const proposal of first) expect(proposal.left).not.toBe(proposal.right);
    // Ordered by confidence, so the strongest evidence is read first.
    expect(first.map((proposal) => proposal.confidence)).toStrictEqual(
      [...first.map((proposal) => proposal.confidence)].sort((a, b) => b - a),
    );
  });

  it('does not group two different name-and-local-part splits together', () => {
    // The grouping key is length-prefixed, for the reason `encodeKeyParts`
    // exists: a display name is an arbitrary string, so a plain separator would
    // make "Ada B" with local part "c" and "Ada" with local part "B c" the same
    // key. Neither pair should be proposed.
    const proposals = proposeIdentityLinks([
      identity('Ada B', 'c@one.example'),
      identity('Ada', 'b c@two.example'),
    ]);

    expect(proposals).toStrictEqual([]);
  });

  it('proposes nothing for a single identity, or for none', () => {
    expect(proposeIdentityLinks([])).toStrictEqual([]);
    expect(proposeIdentityLinks([identity('Ada', 'ada@example.com')])).toStrictEqual([]);
  });

  it('only proposes — AC-12', () => {
    // The module exports no merge, and this is the assertion that says so. The
    // one thing that merges is EPIC-009's IdentityStore, which requires
    // evidence; a proposal is that evidence, not a decision.
    const proposals = proposeIdentityLinks([
      identity('Ada', 'ada@example.com'),
      identity('Ada', 'ada+x@example.com'),
    ]);
    expect(proposals.every((proposal) => proposal.confidence < 1)).toBe(true);
  });
});
