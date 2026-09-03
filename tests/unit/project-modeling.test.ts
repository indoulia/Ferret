import { describe, expect, it } from 'vitest';

import {
  EntityKind,
  RelationshipType,
  EvidenceMethod,
  canonicalId,
  canonicalKey,
} from '../../src/domain/index.js';
import { CLOSING_KEYWORDS, findClosingReferences, modelProject } from '../../src/project/index.js';
import { Emitter } from '../../src/providers/sdk/emit.js';
import { ProjectItemState } from '../../src/providers/contracts/source-project.js';
import type {
  ProjectIssue,
  ProjectPullRequest,
  ProjectReview,
} from '../../src/providers/contracts/source-project.js';
import type { CanonicalRelationship } from '../../src/domain/index.js';

/**
 * EPIC-072. Records into canonical knowledge.
 *
 * A pure function, so every acceptance criterion is asserted directly rather
 * than through a fixture that needs a network or a database. That is the
 * property §10 was written for.
 */

const REPOSITORY = canonicalId(
  canonicalKey({ kind: EntityKind.REPOSITORY, sourceSystem: 'github', sourceId: 'o/r' }),
);

function emitter(): Emitter {
  return new Emitter({
    sourceSystem: 'github',
    producer: 'ferret.source.github',
    producerVersion: '1.0.0',
    systemOfRecord: true,
  });
}

const PULL: ProjectPullRequest = {
  id: 'PR_kwDO456',
  number: 12,
  title: 'Fix the symlink refusal',
  body: 'Fixes #7 and mentions #99.',
  state: 'closed',
  lifecycle: ProjectItemState.MERGED,
  url: 'https://github.com/o/r/pull/12',
  mergeCommit: 'a'.repeat(40),
  mergedAt: '2026-02-01T00:00:00.000Z',
  targetBranch: 'main',
  sourceBranch: 'fix/symlink',
  author: { identity: 'U_abc', login: 'octocat', displayName: 'Mona Lisa' },
  labels: ['bug'],
  updatedAt: '2026-02-01T00:00:00.000Z',
};

const ISSUE: ProjectIssue = {
  id: 'I_kwDO123',
  number: 7,
  title: 'Index refuses a symlink',
  state: 'closed',
  lifecycle: ProjectItemState.CLOSED,
  author: { identity: 'U_abc', login: 'octocat' },
  labels: ['bug', 'defect'],
  closedAt: '2026-02-01T00:00:00.000Z',
};

function model(input: Parameters<typeof modelProject>[0]) {
  return modelProject(input, emitter());
}

function edges(
  relationships: readonly CanonicalRelationship[],
  type: string,
): readonly CanonicalRelationship[] {
  return relationships.filter((edge) => edge.type === type);
}

describe('project modelling — identity', () => {
  it('scopes a pull request to its repository — AC-1', () => {
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    const entity = result.entities.find((one) => one.kind === EntityKind.PULL_REQUEST);
    expect(entity?.source.scope).toBe(REPOSITORY);
    // The provider's stable id, not the number: GitHub numbers per repository
    // and Jira per project, so keying on a number makes identity depend on
    // which system was read.
    expect(entity?.source.id).toBe('PR_kwDO456');
    expect(entity?.attributes['number']).toBe('12');
  });

  it('is stable across re-modelling — AC-2', () => {
    const first = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    const second = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    expect(first.entities[0]?.id).toBe(second.entities[0]?.id);
  });

  it('separates the same number in two repositories — AC-3', () => {
    const other = canonicalId(
      canonicalKey({ kind: EntityKind.REPOSITORY, sourceSystem: 'github', sourceId: 'o/other' }),
    );
    const here = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    const there = model({ repositoryId: other, project: 'o/other', pullRequests: [PULL] });
    expect(here.entities[0]?.id).not.toBe(there.entities[0]?.id);
  });
});

describe('project modelling — the joins', () => {
  it('joins a merged pull request to the commit Git derives — AC-4', () => {
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    const edge = edges(result.relationships, RelationshipType.PULL_REQUEST_PROPOSES_COMMIT)[0];
    expect(edge).toBeDefined();
    // The commit id Git derives: kind `commit`, global by SHA, no scope, and —
    // since EPIC-051 — in the `git` system whoever reported it. This assertion
    // said `github` until then, which is to say it asserted the defect: the
    // edge landed on GitHub's copy of a commit rather than on the entity
    // EPIC-020 created.
    expect(edge?.toId).toBe(
      canonicalId(canonicalKey({ kind: EntityKind.COMMIT, sourceSystem: 'git', sourceId: 'a'.repeat(40) })),
    );
    expect(edge?.metadata['role']).toBe('merge-commit');
  });

  it('emits no commit edge for an open pull request — AC-5', () => {
    // An open pull request proposes commits on a branch that may never have
    // been fetched. An edge into emptiness is worse than an absent edge.
    const open: ProjectPullRequest = {
      ...PULL,
      lifecycle: ProjectItemState.OPEN,
      state: 'open',
      mergeCommit: undefined,
      mergedAt: undefined,
    };
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [open] });
    expect(edges(result.relationships, RelationshipType.PULL_REQUEST_PROPOSES_COMMIT)).toStrictEqual(
      [],
    );
  });

  it('joins the target branch, and keeps the source branch as an attribute — AC-6', () => {
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    const edge = edges(result.relationships, RelationshipType.PULL_REQUEST_TARGETS_BRANCH)[0];
    // `git`, since EPIC-051: the repository scope already makes the name
    // unique, and deriving in `github` split this `main` from the one the Git
    // provider indexed.
    expect(edge?.toId).toBe(
      canonicalId(
        canonicalKey({
          kind: EntityKind.BRANCH,
          sourceSystem: 'git',
          sourceId: 'main',
          scope: REPOSITORY,
        }),
      ),
    );
    // The source branch is usually deleted after a merge, so an edge to it
    // would dangle. The attribute keeps the fact without the claim.
    const entity = result.entities.find((one) => one.kind === EntityKind.PULL_REQUEST);
    expect(entity?.attributes['sourceRef']).toBe('fix/symlink');
  });

  it('marks a draft pull request as draft', () => {
    const draft: ProjectPullRequest = {
      ...PULL,
      lifecycle: ProjectItemState.OPEN,
      state: 'open',
      draft: true,
      mergeCommit: undefined,
    };
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [draft] });
    expect(result.entities[0]?.attributes['state']).toBe('draft');
  });
});

describe('project modelling — closing references', () => {
  it('reads a closing keyword as an inference — AC-7', () => {
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    const edge = edges(result.relationships, RelationshipType.PULL_REQUEST_RESOLVES_ISSUE)[0];
    expect(edge).toBeDefined();
    expect(edge?.metadata['keyword']).toBe('fixes');

    // Reading text a human wrote is inference, not observation. Labelling it is
    // the whole of Governance §6 in one field.
    const inferred = result.evidence.find((one) => one.method === EvidenceMethod.INFERRED);
    expect(inferred?.field).toBe('resolves');
    expect(inferred?.derivedFrom.length).toBeGreaterThan(0);
    expect(result.inferredResolutions).toBe(1);
  });

  it('does not read a bare mention as a resolution — AC-8', () => {
    // `#99` appears in the body beside `Fixes #7`. Treating a mention as a
    // resolution is how a compliance report starts claiming work was done.
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    expect(edges(result.relationships, RelationshipType.PULL_REQUEST_RESOLVES_ISSUE)).toHaveLength(1);
  });

  it('scopes a cross-repository reference to that repository — AC-9', () => {
    const cross: ProjectPullRequest = { ...PULL, body: 'Fixes owner/other#5' };
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [cross] });
    const edge = edges(result.relationships, RelationshipType.PULL_REQUEST_RESOLVES_ISSUE)[0];
    const foreignRepository = canonicalId(
      canonicalKey({ kind: EntityKind.REPOSITORY, sourceSystem: 'github', sourceId: 'owner/other' }),
    );
    expect(edge?.toId).toBe(
      canonicalId(
        canonicalKey({
          kind: EntityKind.ISSUE,
          sourceSystem: 'github',
          sourceId: 'owner/other#5',
          scope: foreignRepository,
        }),
      ),
    );
  });

  it('reads every documented keyword and no invented one', () => {
    for (const keyword of CLOSING_KEYWORDS) {
      expect(findClosingReferences(`${keyword} #3`)).toHaveLength(1);
    }
    // GitHub's list is GitHub's. A list Ferret invented would be a claim about
    // a convention it does not own.
    for (const keyword of ['addresses', 'refs', 'see', 'relates to', 'part of']) {
      expect(findClosingReferences(`${keyword} #3`)).toStrictEqual([]);
    }
  });

  it('reads GH-7 and owner/repo#7, and deduplicates', () => {
    expect(findClosingReferences('Fixes GH-7')[0]?.number).toBe(7);
    expect(findClosingReferences('Closes o/r#7')[0]?.project).toBe('o/r');
    expect(findClosingReferences('Fixes #7, fixes #7')).toHaveLength(1);
  });

  it('refuses issue zero and a keyword inside a word', () => {
    expect(findClosingReferences('Fixes #0')).toStrictEqual([]);
    // `prefixes #3` must not match `fixes`.
    expect(findClosingReferences('prefixes #3')).toStrictEqual([]);
  });

  it('bounds the scan of an untrusted body', () => {
    // A generated description can be megabytes. The cap bounds the scan rather
    // than the record.
    const body = `${'x'.repeat(200_000)} Fixes #5`;
    expect(findClosingReferences(body)).toStrictEqual([]);
    expect(findClosingReferences(`Fixes #5 ${'x'.repeat(200_000)}`)).toHaveLength(1);
  });
});

describe('project modelling — reviews', () => {
  const APPROVED: ProjectReview = {
    id: 'R_1',
    pullRequestId: 'PR_kwDO456',
    state: 'APPROVED',
    approved: true,
    reviewer: { identity: 'U_rev', login: 'reviewer', displayName: 'Ada' },
    submittedAt: '2026-01-31T00:00:00.000Z',
  };

  it('links every review to its pull request, verdict on the entity — AC-10', () => {
    const changes: ProjectReview = {
      ...APPROVED,
      id: 'R_2',
      state: 'CHANGES_REQUESTED',
      approved: false,
    };
    const result = model({
      repositoryId: REPOSITORY,
      project: 'o/r',
      pullRequests: [PULL],
      reviews: [APPROVED, changes],
    });
    expect(edges(result.relationships, RelationshipType.REVIEW_REVIEWS_PULL_REQUEST)).toHaveLength(2);
    const states = result.entities
      .filter((one) => one.kind === EntityKind.REVIEW)
      .map((one) => one.attributes['state']);
    expect(states).toStrictEqual(['approved', 'changes_requested']);
  });

  it('records a reviewer whatever the verdict — AC-11', () => {
    // "Was this approved" and "did anyone look at this" must stay two
    // questions. A person who requested changes did review it.
    const changes: ProjectReview = { ...APPROVED, state: 'CHANGES_REQUESTED', approved: false };
    const result = model({
      repositoryId: REPOSITORY,
      project: 'o/r',
      pullRequests: [PULL],
      reviews: [changes],
    });
    const edge = edges(result.relationships, RelationshipType.DEVELOPER_REVIEWED_PULL_REQUEST)[0];
    expect(edge).toBeDefined();
    expect(edge?.metadata['verdict']).toBe('changes_requested');
  });

  it('skips and counts a review whose pull request is not in the batch', () => {
    const orphan: ProjectReview = { ...APPROVED, pullRequestId: 'PR_elsewhere' };
    const result = model({
      repositoryId: REPOSITORY,
      project: 'o/r',
      pullRequests: [PULL],
      reviews: [orphan],
    });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain('not in this batch');
  });
});

describe('project modelling — actors', () => {
  it('makes an actor a developer, and offers an identity to link — AC-12', () => {
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    const developer = result.entities.find((one) => one.kind === EntityKind.DEVELOPER);
    expect(developer?.source.id).toBe('U_abc');
    expect(developer?.attributes['usernames']).toStrictEqual(['octocat']);

    // Presented as GitHub's own noreply form, which is the one spelling
    // EPIC-036's `GITHUB_NOREPLY_LOGIN` rule can join to a web-UI commit.
    expect(result.identities[0]?.login).toBe('octocat');
  });

  it('merges nothing — AC-14', () => {
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    // Two identifiers for probably one person is not a basis for merging
    // entities. EPIC-009's store is the only thing that merges, with evidence.
    expect(edges(result.relationships, RelationshipType.ENTITY_SUPERSEDES_ENTITY)).toStrictEqual([]);
  });

  it('classifies a bot as an agent, not a developer — AC-13', () => {
    const bot: ProjectPullRequest = {
      ...PULL,
      author: { identity: 'U_bot', login: 'dependabot[bot]', displayName: 'dependabot[bot]' },
    };
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [bot] });
    expect(result.entities.some((one) => one.kind === EntityKind.AGENT)).toBe(true);
    expect(result.entities.some((one) => one.kind === EntityKind.DEVELOPER)).toBe(false);
  });

  it('emits one entity for an actor seen twice', () => {
    const result = model({
      repositoryId: REPOSITORY,
      project: 'o/r',
      pullRequests: [PULL],
      issues: [ISSUE],
    });
    const developers = result.entities.filter((one) => one.kind === EntityKind.DEVELOPER);
    expect(developers).toHaveLength(1);
  });
});

describe('project modelling — issues and evidence', () => {
  it('models an issue with the source state beside the comparable one', () => {
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', issues: [ISSUE] });
    const entity = result.entities.find((one) => one.kind === EntityKind.ISSUE);
    expect(entity?.attributes['state']).toBe('closed');
    expect(entity?.attributes['sourceState']).toBe('closed');
    expect(entity?.attributes['labels']).toStrictEqual(['bug', 'defect']);
  });

  it('carries evidence with a locator for the questioned attributes — AC-15', () => {
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', pullRequests: [PULL] });
    const state = result.evidence.find((one) => one.field === 'attributes.state');
    expect(state?.method).toBe(EvidenceMethod.OBSERVED);
    expect(state?.locator?.kind).toBe('pull-request');
    expect(state?.locator?.start).toBe(12);
    expect(result.evidence.some((one) => one.field === 'attributes.mergeCommit')).toBe(true);
  });

  it('redacts a credential pasted into a title', () => {
    const leaky: ProjectIssue = { ...ISSUE, title: 'fails with ghp_0123456789abcdefghijklmnopqrstuvwxyzA' };
    const result = model({ repositoryId: REPOSITORY, project: 'o/r', issues: [leaky] });
    expect(String(result.entities[0]?.attributes['title'])).not.toContain('ghp_0123456789');
  });
});

describe('project modelling — failure', () => {
  it('skips one malformed record and models the rest — AC-16', () => {
    // An attribute schema violation costs one record. A repository with four
    // hundred pull requests and one bad record must produce three hundred and
    // ninety-nine, not an exception.
    const malformed = { ...PULL, id: 'PR_bad', title: 42 as unknown as string };
    const result = model({
      repositoryId: REPOSITORY,
      project: 'o/r',
      pullRequests: [malformed, { ...PULL, id: 'PR_good' }],
    });
    expect(result.skipped.map((one) => one.id)).toStrictEqual(['PR_bad']);
    expect(result.entities.some((one) => one.source.id === 'PR_good')).toBe(true);
  });

  it('models nothing from nothing, without failing', () => {
    const result = model({ repositoryId: REPOSITORY, project: 'o/r' });
    expect(result.entities).toStrictEqual([]);
    expect(result.skipped).toStrictEqual([]);
  });
});

describe('project modelling — the relationship rules', () => {
  it('emits only edges the canonical model permits — AC-18', () => {
    // `createRelationship` validates endpoint kinds against `relationship.ts`,
    // so every edge here has already been checked. Asserting the set is what
    // catches an edge type quietly dropped by a refactor.
    const result = model({
      repositoryId: REPOSITORY,
      project: 'o/r',
      pullRequests: [PULL],
      issues: [ISSUE],
      reviews: [
        {
          id: 'R_1',
          pullRequestId: 'PR_kwDO456',
          state: 'APPROVED',
          approved: true,
          reviewer: { identity: 'U_rev', login: 'ada' },
        },
      ],
    });
    expect([...new Set(result.relationships.map((edge) => edge.type))].sort()).toStrictEqual([
      RelationshipType.DEVELOPER_REVIEWED_PULL_REQUEST,
      RelationshipType.PULL_REQUEST_PROPOSES_COMMIT,
      RelationshipType.PULL_REQUEST_RESOLVES_ISSUE,
      RelationshipType.PULL_REQUEST_TARGETS_BRANCH,
      RelationshipType.REVIEW_REVIEWS_PULL_REQUEST,
    ].sort());
  });
});
