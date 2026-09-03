import { describe, expect, it } from 'vitest';

import { Confidence } from '../../src/domain/confidence.js';
import { EntityKind, canonicalId, canonicalKey } from '../../src/domain/index.js';
import { modelProject } from '../../src/project/index.js';
import { Emitter } from '../../src/providers/sdk/emit.js';
import { ProjectItemState } from '../../src/providers/contracts/source-project.js';
import {
  CANONICAL_SOURCE_SYSTEM,
  CrossSourceRule,
  canonicalSourceSystem,
  hasGlobalIdentifier,
  hostOf,
  proposeResolutions,
  repositoryIdentifierFor,
} from '../../src/resolution/index.js';
import type { ActorRecord, IssueRecord } from '../../src/resolution/index.js';
import type { ProjectPullRequest } from '../../src/providers/contracts/source-project.js';

/**
 * EPIC-051. Two mechanisms, and knowing which applies is most of the Epic.
 *
 * The first suite is the interesting one: it asserts a defect this Epic found
 * and fixed, which is a stronger thing for a test to say than that a new
 * function returns what it was written to return.
 */

describe('resolution by construction — the split this Epic found', () => {
  it('gives one commit one identity, whoever mentions it', () => {
    // Before EPIC-051 these differed: `canonicalKey` includes the source
    // system, and GitHub reporting `abc123` produced GitHub's copy of a commit
    // beside Git's. A SHA is a hash of the commit; there is one commit with it.
    const fromGit = canonicalId(
      canonicalKey({ kind: EntityKind.COMMIT, sourceSystem: 'git', sourceId: 'abc123' }),
    );
    const asReported = canonicalId(
      canonicalKey({
        kind: EntityKind.COMMIT,
        sourceSystem: canonicalSourceSystem(EntityKind.COMMIT, 'github'),
        sourceId: 'abc123',
      }),
    );
    expect(asReported).toBe(fromGit);
  });

  it('makes EPIC-072 point its merge-commit edge at Git commit', () => {
    // The consequence, end to end. Every `PULL_REQUEST_PROPOSES_COMMIT` edge
    // used to point at an entity nothing else in the graph knew about.
    const repositoryId = canonicalId(
      canonicalKey({ kind: EntityKind.REPOSITORY, sourceSystem: 'git', sourceId: 'github.com/o/r' }),
    );
    const pull: ProjectPullRequest = {
      id: 'PR_1',
      number: 12,
      title: 'Fix it',
      state: 'closed',
      lifecycle: ProjectItemState.MERGED,
      mergeCommit: 'abc123',
      targetBranch: 'main',
      labels: [],
    };
    const result = modelProject(
      { repositoryId, project: 'o/r', pullRequests: [pull] },
      new Emitter({ sourceSystem: 'github', producer: 'p', producerVersion: '1' }),
    );

    const commit = result.entities.find((one) => one.kind === EntityKind.COMMIT);
    expect(commit?.source.system).toBe('git');
    expect(commit?.id).toBe(
      canonicalId(canonicalKey({ kind: EntityKind.COMMIT, sourceSystem: 'git', sourceId: 'abc123' })),
    );
  });

  it('makes the target branch the branch Git indexed', () => {
    const repositoryId = canonicalId(
      canonicalKey({ kind: EntityKind.REPOSITORY, sourceSystem: 'git', sourceId: 'github.com/o/r' }),
    );
    const result = modelProject(
      {
        repositoryId,
        project: 'o/r',
        pullRequests: [
          {
            id: 'PR_1',
            number: 1,
            title: 'x',
            state: 'open',
            lifecycle: ProjectItemState.OPEN,
            targetBranch: 'main',
            labels: [],
          },
        ],
      },
      new Emitter({ sourceSystem: 'github', producer: 'p', producerVersion: '1' }),
    );
    const branch = result.entities.find((one) => one.kind === EntityKind.BRANCH);
    expect(branch?.id).toBe(
      canonicalId(
        canonicalKey({
          kind: EntityKind.BRANCH,
          sourceSystem: 'git',
          sourceId: 'main',
          scope: repositoryId,
        }),
      ),
    );
  });

  it('leaves everything else scoped to the system that reported it', () => {
    // A GitHub issue 12 and a Jira issue 12 are different things. An identity
    // scheme that ignored the system would merge them, which is the failure
    // `canonicalKey` includes the system to prevent.
    for (const kind of [EntityKind.ISSUE, EntityKind.PULL_REQUEST, EntityKind.RELEASE]) {
      expect(canonicalSourceSystem(kind, 'github')).toBe('github');
      expect(hasGlobalIdentifier(kind)).toBe(false);
    }
    expect(hasGlobalIdentifier(EntityKind.COMMIT)).toBe(true);
    expect(CANONICAL_SOURCE_SYSTEM).toBe('git');
  });
});

describe('resolution by construction — repositories', () => {
  it('reduces owner/repo to the identifier a remote produces', () => {
    // `owner/repo` on GitHub, `git@github.com:owner/repo.git` in a config and
    // `https://github.com/owner/repo` in a browser are one repository.
    expect(repositoryIdentifierFor('owner/repo', 'github.com')).toBe('github.com/owner/repo');
  });

  it('needs the host, and does not guess it', () => {
    // Guessing `github.com` would be wrong for every Enterprise Server install,
    // and being wrong here merges two organisations' repositories.
    expect(repositoryIdentifierFor('owner/repo', 'ghe.acme.internal')).toBe(
      'ghe.acme.internal/owner/repo',
    );
    expect(repositoryIdentifierFor('owner/repo', '')).toBeUndefined();
  });

  it('refuses a project name that is not one', () => {
    for (const bad of ['owner', 'a/b/c', '../etc', '']) {
      expect(repositoryIdentifierFor(bad, 'github.com')).toBeUndefined();
    }
  });

  it('reads a host from a base URL, and knows api.github.com is not one', () => {
    // A remote points at `github.com`. Identity has to agree with the remote or
    // nothing resolves.
    expect(hostOf('https://api.github.com')).toBe('github.com');
    expect(hostOf('https://ghe.acme.internal/api/v3')).toBe('ghe.acme.internal');
    expect(hostOf('not a url')).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });
});

describe('resolution by proposal — actors', () => {
  const git: ActorRecord = {
    entityId: 'e-git',
    sourceSystem: 'git',
    identity: 'ada@example.com',
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
  };

  it('proposes the same mailbox across systems', () => {
    const github: ActorRecord = {
      entityId: 'e-github',
      sourceSystem: 'github',
      identity: 'U_1',
      login: 'ada',
      email: 'Ada+ferret@Example.COM',
    };
    const [proposal] = proposeResolutions({ actors: [git, github] });
    // Casing and plus-tags normalized: RFC 5233 at every major provider.
    expect(proposal?.rule).toBe(CrossSourceRule.SAME_ADDRESS);
    expect(proposal?.confidence).toBe(Confidence.STRONG);
    expect(proposal?.rationale).toContain('same mailbox');
  });

  it('joins a web-UI commit to the reviewer through a noreply login', () => {
    // A commit authored through GitHub's web UI carries
    // `12345+octocat@users.noreply.github.com`, and EPIC-036 already recovers
    // the login from it. This is the rule that uses it across systems.
    const webUi: ActorRecord = {
      entityId: 'e-web',
      sourceSystem: 'git',
      identity: 'x',
      displayName: 'Octo Cat',
      email: '12345+octocat@users.noreply.github.com',
    };
    const reviewer: ActorRecord = {
      entityId: 'e-review',
      sourceSystem: 'github',
      identity: 'U_2',
      login: 'octocat',
    };
    const [proposal] = proposeResolutions({ actors: [webUi, reviewer] });
    expect(proposal?.rule).toBe(CrossSourceRule.NOREPLY_LOGIN);
  });

  it('rates a shared username below an address, and a shared name below that', () => {
    const byUsername = proposeResolutions({
      actors: [
        { entityId: 'a', sourceSystem: 'github', identity: '1', login: 'ada' },
        { entityId: 'b', sourceSystem: 'jira', identity: '2', login: 'ada' },
      ],
    });
    expect(byUsername[0]?.rule).toBe(CrossSourceRule.SAME_USERNAME);
    expect(byUsername[0]?.confidence).toBe(Confidence.PLAUSIBLE);

    const byName = proposeResolutions({
      actors: [
        { entityId: 'a', sourceSystem: 'github', identity: '1', displayName: 'Admin' },
        { entityId: 'b', sourceSystem: 'jira', identity: '2', displayName: 'admin' },
      ],
    });
    // Two people called "admin" are two people. This exists to surface a
    // candidate for a human, not to carry one over a threshold.
    expect(byName[0]?.rule).toBe(CrossSourceRule.SAME_DISPLAY_NAME);
    expect(byName[0]?.confidence).toBe(Confidence.EVEN);
  });

  it('never proposes within one system', () => {
    // Two GitHub accounts are two people until GitHub says otherwise, and
    // proposing within one system would rediscover every colleague who shares a
    // surname.
    expect(
      proposeResolutions({
        actors: [
          { entityId: 'a', sourceSystem: 'github', identity: '1', email: 'ada@example.com' },
          { entityId: 'b', sourceSystem: 'github', identity: '2', email: 'ada@example.com' },
        ],
      }),
    ).toStrictEqual([]);
  });

  it('proposes a pair once, at its best rule', () => {
    // Two rules agreeing does not make a pair more certain than its best
    // evidence, and keeping both would let a reviewer count the same fact twice.
    const proposals = proposeResolutions({
      actors: [
        git,
        {
          entityId: 'e-github',
          sourceSystem: 'github',
          identity: 'U_1',
          login: 'Ada Lovelace',
          displayName: 'Ada Lovelace',
          email: 'ada@example.com',
        },
      ],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.rule).toBe(CrossSourceRule.SAME_ADDRESS);
  });

  it('proposes nothing for two unrelated people', () => {
    expect(
      proposeResolutions({
        actors: [
          git,
          { entityId: 'x', sourceSystem: 'github', identity: 'U_9', login: 'grace', email: 'grace@example.com' },
        ],
      }),
    ).toStrictEqual([]);
  });

  it('orders proposals strongest first', () => {
    const proposals = proposeResolutions({
      actors: [
        { entityId: 'a', sourceSystem: 'github', identity: '1', displayName: 'Same Name' },
        { entityId: 'b', sourceSystem: 'jira', identity: '2', displayName: 'Same Name' },
        { entityId: 'c', sourceSystem: 'git', identity: '3', email: 'x@example.com', displayName: 'X' },
        { entityId: 'd', sourceSystem: 'jira', identity: '4', email: 'x@example.com' },
      ],
    });
    expect(proposals[0]?.rule).toBe(CrossSourceRule.SAME_ADDRESS);
    expect(proposals.at(-1)?.rule).toBe(CrossSourceRule.SAME_DISPLAY_NAME);
  });
});

describe('resolution by proposal — issues', () => {
  const jira: IssueRecord = { entityId: 'i-jira', sourceSystem: 'jira', key: 'FER-12' };

  it('proposes an issue that quotes another tracker key', () => {
    const github: IssueRecord = {
      entityId: 'i-github',
      sourceSystem: 'github',
      key: '42',
      title: 'Symlink refusal',
      body: 'Tracked as FER-12 in Jira.',
    };
    const [proposal] = proposeResolutions({ issues: [github, jira] });
    expect(proposal?.rule).toBe(CrossSourceRule.QUOTED_KEY);
    expect(proposal?.kind).toBe(EntityKind.ISSUE);
    // The quotation is in the rationale, so a reviewer can see which of the two
    // readings it was: teams reference a ticket for context as often as to say
    // "this is that".
    expect(proposal?.rationale).toContain('FER-12');
    expect(proposal?.confidence).toBe(Confidence.PROBABLE);
  });

  it('reads a key from a title as well as a body', () => {
    const github: IssueRecord = {
      entityId: 'i-github',
      sourceSystem: 'github',
      key: '42',
      title: 'FER-12: symlink refusal',
    };
    expect(proposeResolutions({ issues: [github, jira] })).toHaveLength(1);
  });

  it('proposes nothing for a key no tracker in the batch has', () => {
    const github: IssueRecord = {
      entityId: 'i-github',
      sourceSystem: 'github',
      key: '42',
      body: 'See OTHER-9',
    };
    expect(proposeResolutions({ issues: [github, jira] })).toStrictEqual([]);
  });

  it('does not propose within one tracker', () => {
    expect(
      proposeResolutions({
        issues: [
          { entityId: 'a', sourceSystem: 'jira', key: 'FER-1', body: 'blocks FER-12' },
          jira,
        ],
      }),
    ).toStrictEqual([]);
  });

  it('proposes nothing from nothing', () => {
    expect(proposeResolutions({})).toStrictEqual([]);
  });
});
