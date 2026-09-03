import { EntityKind } from '../domain/index.js';
import { normalizeRemote } from '../identity/remote.js';

/**
 * Identifiers that mean the same thing in every system — EPIC-051 §8.2.
 *
 * `canonicalKey` includes the source system because most identifiers are only
 * unique *within* one: GitHub's issue 12 and Jira's issue 12 are different
 * things, and an identity scheme that ignored the system would merge them.
 *
 * A few identifiers are not like that. A Git commit SHA is a hash of the
 * commit; there is exactly one commit with that SHA whoever mentions it. So
 * when GitHub says a pull request merged as `abc123`, that is *the* commit —
 * not GitHub's copy of it — and deriving an entity in the `github` system
 * produced a second entity for one object.
 *
 * This module is the list of such identifiers and the canonical system each
 * belongs to. It resolves by **construction** rather than by proposal, which is
 * always better where it is available: a proposal has to be adjudicated, and a
 * collision by construction is simply right.
 */

/**
 * The system a globally-unique identifier is derived in.
 *
 * `git` for a commit, because a SHA is Git's; `git` for a repository too,
 * because what two clones share is the canonical remote and Git is what
 * normalizes it.
 */
export const CANONICAL_SOURCE_SYSTEM = 'git';

/**
 * Entity kinds whose identifier is global.
 *
 * **Commit** — a SHA is a hash. **Branch** and **worktree** are not: a branch
 * name is unique within a repository, and the repository scope already carries
 * that, so they are here because their *scope* is a repository entity whose id
 * must also be the canonical one. A file is not here: a path is unique within a
 * repository too, and EPIC-023 already scopes it.
 */
const GLOBAL_KINDS: ReadonlySet<string> = new Set([EntityKind.COMMIT]);

/**
 * Which source system an entity of this kind should be identified in.
 *
 * A caller emitting a commit that GitHub told it about passes `github` and gets
 * `git` back, so the entity it derives is the one the Git provider derived.
 * Everything else is returned unchanged, because everything else really is
 * scoped to the system that reported it.
 */
export function canonicalSourceSystem(kind: string, reportedBy: string): string {
  return GLOBAL_KINDS.has(kind) ? CANONICAL_SOURCE_SYSTEM : reportedBy;
}

/** True when this kind's identifier means the same thing everywhere. */
export function hasGlobalIdentifier(kind: string): boolean {
  return GLOBAL_KINDS.has(kind);
}

/**
 * A repository's canonical identifier, from anything that names it.
 *
 * `owner/repo` on GitHub, `git@github.com:owner/repo.git` in a Git remote and
 * `https://github.com/owner/repo` in a browser are one repository. Git's
 * `normalizeRemote` already reduces the last two to `github.com/owner/repo`;
 * this adds the first, which is the form a project tracker uses and which
 * carries no host at all.
 *
 * The host must therefore be supplied. Guessing `github.com` would be wrong for
 * every Enterprise Server install, and being wrong here merges two
 * organisations' repositories of the same name.
 */
export function repositoryIdentifierFor(project: string, host: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(project)) return undefined;
  // A dot is legal in an owner and a repository name, so the character class
  // above admits `../etc` — which normalizes to a plausible-looking identifier
  // for a repository nobody named. A segment that is *only* dots is not a name.
  if (project.split('/').some((segment) => /^\.+$/u.test(segment))) return undefined;
  if (host.length === 0) return undefined;
  const normalized: { host?: string; canonical: string } | undefined = normalizeRemote(
    `https://${host}/${project}`,
  );
  if (normalized === undefined || normalized.host === undefined) return undefined;
  return normalized.canonical;
}

/** The host part of a base URL, for `repositoryIdentifierFor`. */
export function hostOf(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  try {
    const url = new URL(baseUrl);
    // `api.github.com` names the API, not the repositories: a remote points at
    // `github.com`, and identity has to agree with the remote or nothing
    // resolves.
    return url.hostname === 'api.github.com' ? 'github.com' : url.hostname;
  } catch {
    return undefined;
  }
}
