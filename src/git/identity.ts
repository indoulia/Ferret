import { maskRemote, normalizeRemote, type NormalizedRemote } from '../identity/remote.js';

/**
 * A repository's identity.
 *
 * Remote normalization moved to `src/identity/remote.ts` when EPIC-051 needed it
 * without the Git provider attached; it is re-exported here so every caller that
 * imported it from this module is unchanged.
 */

export { maskRemote, normalizeRemote, type NormalizedRemote };

export const RepositoryIdentitySource = {
  /** Derived from the origin remote: shared by every clone of it. */
  REMOTE: 'remote',
  /** Derived from the Git directory's real path: local to this machine. */
  PATH: 'path',
} as const;

export type RepositoryIdentitySource =
  (typeof RepositoryIdentitySource)[keyof typeof RepositoryIdentitySource];

export interface RepositoryIdentity {
  /** The value entity identity is derived from. */
  readonly key: string;
  readonly source: RepositoryIdentitySource;
  /** The normalized remote, when there was one. */
  readonly remote: NormalizedRemote | undefined;
}


/**
 * Decides a repository's identity from what is actually known about it.
 *
 * Prefers the remote, because that is what two clones share. Falls back to the
 * real path of the Git directory, and **says so** — a repository whose identity
 * is local cannot be unified with the same repository on another machine, and an
 * operator wondering why two clones did not merge deserves to be able to see the
 * reason rather than deduce it.
 */
export function repositoryIdentity(
  remoteUrl: string | undefined,
  gitDirRealPath: string,
): RepositoryIdentity {
  const remote = remoteUrl === undefined ? undefined : normalizeRemote(remoteUrl);
  if (remote !== undefined && remote.host !== undefined) {
    return { key: remote.canonical, source: RepositoryIdentitySource.REMOTE, remote };
  }
  return {
    key: normalizeLocalPath(gitDirRealPath),
    source: RepositoryIdentitySource.PATH,
    remote,
  };
}

/**
 * A local path in a form that is stable for identity.
 *
 * Separators are unified and a Windows drive letter is upper-cased, because
 * `c:\repo` and `C:\Repo` are the same directory there and comparing them
 * literally would make one repository look like two. The rest of the path keeps
 * its case: Windows is case-insensitive but its filesystem preserves case, and
 * lowercasing would make Ferret's own record of the path wrong.
 */
function normalizeLocalPath(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return unified.replace(/^([a-z]):\//, (_match, drive: string) => `${drive.toUpperCase()}:/`);
}

