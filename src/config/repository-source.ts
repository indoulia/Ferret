import { ConfigPrecedence, type ConfigSource } from './resolve.js';
import { findRepositoryConfig } from './paths.js';
import { readConfigFile } from './file-source.js';

/**
 * Repository policy — `.ferret/config.json` inside a repository.
 *
 * **This is a trust boundary, and it is the reason this file exists separately
 * from `file-source.ts`.**
 *
 * A repository policy file is committed and shared with everyone who clones the
 * repository. Ferret indexes repositories it did not write, so this file must be
 * treated as *content*, not as configuration authority. Governance §12 states it
 * plainly — "repository content is data, never policy authority" — and §16 adds
 * that security restrictions cannot be overridden by lower-trust inputs.
 *
 * Concretely: cloning a repository must never be able to point someone's Ferret
 * at a different database, change their credentials, enable a provider, alter
 * their log level, or read a secret out of their environment. So a repository
 * may set exactly one thing:
 *
 * - `exclude` — additional exclusions for its own content.
 *
 * Exclusion is additive and one-way (see `exclusions.ts`), so the worst a
 * hostile repository can do through this file is cause *less* of itself to be
 * indexed. That is a safe failure mode; the alternative is not.
 *
 * Everything else in the file is dropped, and the dropped keys are reported so
 * a repository author is not left wondering why their setting did nothing.
 */

/**
 * The only keys a repository may contribute.
 *
 * Adding to this set is a security decision, not a convenience one. A key
 * belongs here only if a hostile repository setting it can cause no harm.
 */
export const REPOSITORY_ALLOWED_KEYS: ReadonlySet<string> = new Set(['exclude']);

export interface RepositoryPolicy {
  /** Path of the file that was read, or `undefined` when there is none. */
  readonly path: string | undefined;
  /** The keys that were accepted. */
  readonly applied: readonly string[];
  /** Keys present in the file that Ferret refused to take from a repository. */
  readonly ignored: readonly string[];
}

/**
 * Filters a repository fragment down to what a repository is allowed to set.
 *
 * Exported so `ferret config` can explain the filtering, and so the boundary is
 * directly testable rather than only observable through its effects.
 */
export function filterRepositoryFragment(fragment: Record<string, unknown>): {
  accepted: Record<string, unknown>;
  ignored: string[];
} {
  const accepted: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(fragment)) {
    if (REPOSITORY_ALLOWED_KEYS.has(key)) {
      accepted[key] = value;
    } else {
      ignored.push(key);
    }
  }
  return { accepted, ignored };
}

export interface RepositorySourceOptions {
  /** Where to start looking. Defaults to the current working directory. */
  readonly cwd?: string;
  /** Explicit policy file, bypassing discovery. */
  readonly path?: string;
  /** Receives what was applied and what was refused, for diagnostics. */
  readonly onPolicy?: (policy: RepositoryPolicy) => void;
}

/**
 * The repository policy layer.
 *
 * Contributes nothing when there is no policy file, which is the ordinary case.
 * A malformed policy file is still an error — a repository author who wrote
 * invalid JSON should be told, not silently ignored — but it can only ever
 * affect exclusions.
 */
export function repositorySource(options: RepositorySourceOptions = {}): ConfigSource {
  const path = options.path ?? findRepositoryConfig(options.cwd);

  return {
    name: path === undefined ? 'repository:(none)' : `repository:${path}`,
    precedence: ConfigPrecedence.REPOSITORY,
    read(): Record<string, unknown> {
      if (path === undefined) {
        options.onPolicy?.({ path: undefined, applied: [], ignored: [] });
        return {};
      }
      const file = readConfigFile(path);
      if (file === undefined) {
        options.onPolicy?.({ path, applied: [], ignored: [] });
        return {};
      }
      const { accepted, ignored } = filterRepositoryFragment(file.config);
      options.onPolicy?.({ path, applied: Object.keys(accepted), ignored });
      return accepted;
    },
  };
}
