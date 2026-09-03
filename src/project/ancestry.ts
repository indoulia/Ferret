/**
 * Which commits a release contains — EPIC-073 §8.2.
 *
 * The question `RELEASE_INCLUDES_COMMIT` asks has no answer in a release API: a
 * GitHub release names a tag, and a tag names one commit. What "the release
 * contains this commit" means is *reachable from this release's commit and not
 * from the previous one* — which is a question about the commit graph, and
 * Ferret already has the commit graph.
 *
 * So this is a set difference over ancestry, and it takes a parent map rather
 * than a database: the caller reads the commits it has, this decides what they
 * mean, and the module stays testable without either.
 */

/**
 * How many commits one release may be said to contain.
 *
 * A bound, not a guess. The *first* release in a repository has no predecessor,
 * so its ancestry is the entire history — and emitting an edge per commit for a
 * repository with 80 000 of them is a write amplification nobody asked for. The
 * walk stops and says it stopped.
 */
export const MAX_RELEASE_COMMITS = 5_000;

export interface AncestryWalk {
  /** Commits in this release and not in the previous one. */
  readonly commits: readonly string[];
  /** The bound was reached, so the set is a prefix rather than the answer. */
  readonly truncated: boolean;
  /** A parent named by a commit that is not in the map. */
  readonly unresolved: readonly string[];
}

export interface AncestryOptions {
  readonly limit?: number;
}

/**
 * Commits reachable from `head` and not from `previous`.
 *
 * Breadth-first from `head`, stopping at anything the previous release already
 * reached — `git log previous..head` in a function, and for the same reason git
 * spells it that way: a release's contents are what is new since the last one.
 *
 * `previous` absent means "everything", which is only correct for a first
 * release and is why the bound exists.
 */
export function commitsInRelease(
  parents: ReadonlyMap<string, readonly string[]>,
  head: string,
  previous: string | undefined,
  options: AncestryOptions = {},
): AncestryWalk {
  const limit = options.limit ?? MAX_RELEASE_COMMITS;
  const excluded = previous === undefined ? new Set<string>() : ancestorsOf(parents, previous, limit);

  const commits: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [head];
  let truncated = false;

  while (queue.length > 0) {
    const sha = queue.shift();
    if (sha === undefined || seen.has(sha) || excluded.has(sha)) continue;
    seen.add(sha);

    const ancestors = parents.get(sha);
    if (ancestors === undefined) {
      // A commit the caller did not supply. Recorded rather than treated as a
      // root: "we do not have this commit" and "this commit has no parents" are
      // different facts, and the second is a claim about history.
      unresolved.push(sha);
      continue;
    }

    if (commits.length >= limit) {
      truncated = true;
      break;
    }
    commits.push(sha);
    queue.push(...ancestors);
  }

  return { commits, truncated, unresolved };
}

/**
 * Everything reachable from a commit, bounded.
 *
 * The bound is deliberately the same one: an exclusion set that stopped early
 * would make the difference *larger* than it should be, so both walks are
 * capped together and the caller is told when either hit it.
 */
function ancestorsOf(
  parents: ReadonlyMap<string, readonly string[]>,
  start: string,
  limit: number,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0 && seen.size < limit) {
    const sha = queue.shift();
    if (sha === undefined || seen.has(sha)) continue;
    seen.add(sha);
    queue.push(...(parents.get(sha) ?? []));
  }
  return seen;
}
