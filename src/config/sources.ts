import type { ConfigSource } from './resolve.js';
import { environmentSource } from './resolve.js';
import { userFileSource } from './file-source.js';
import { repositorySource, type RepositoryPolicy } from './repository-source.js';
import { explicitSource, sessionSource, type MutableConfigSource } from './session-source.js';

/**
 * The layer stack Ferret uses unless a caller supplies its own.
 *
 * Assembling it in one place means the Governance §16 ladder is expressed once
 * and every entry point — CLI, runtime, MCP server — gets the same behaviour.
 */

export interface DefaultSourcesOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit user configuration file, bypassing the platform default. */
  readonly configPath?: string;
  /** Where to look for repository policy. Defaults to the working directory. */
  readonly cwd?: string;
  /** Set false to leave repository policy out entirely. */
  readonly repository?: boolean;
  /** Reports what a repository policy contributed and what was refused. */
  readonly onRepositoryPolicy?: (policy: RepositoryPolicy) => void;
  /** Values supplied by this session. */
  readonly session?: Record<string, unknown>;
  /** Values supplied by the operation being run, such as a CLI flag. */
  readonly explicit?: Record<string, unknown>;
}

export interface DefaultSources {
  readonly sources: readonly ConfigSource[];
  /** The session layer, so a long-running process can change it in place. */
  readonly session: MutableConfigSource;
  /** The explicit-operation layer. */
  readonly explicit: MutableConfigSource;
}

/**
 * Builds the full stack, lowest precedence first.
 *
 * Defaults are not a source: they live in the schema, so a value is defaulted
 * exactly once, at validation, rather than by a layer that could disagree with
 * the schema about what the default is.
 */
export function defaultConfigSources(options: DefaultSourcesOptions = {}): DefaultSources {
  const env = options.env ?? process.env;
  const session = sessionSource(options.session ?? {});
  const explicit = explicitSource(options.explicit ?? {});

  const sources: ConfigSource[] = [
    environmentSource(env),
    options.configPath === undefined ? userFileSource(env) : userFileSource(env, options.configPath),
  ];

  if (options.repository !== false) {
    sources.push(
      repositorySource({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.onRepositoryPolicy === undefined ? {} : { onPolicy: options.onRepositoryPolicy }),
      }),
    );
  }

  sources.push(session, explicit);
  return { sources, session, explicit };
}

/** Convenience for callers that only need the list. */
export function defaultConfigSourceList(options: DefaultSourcesOptions = {}): readonly ConfigSource[] {
  return defaultConfigSources(options).sources;
}
