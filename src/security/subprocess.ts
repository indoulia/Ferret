import { withoutCredentials } from './credentials.js';

/**
 * The environment a child process Ferret starts is allowed to inherit.
 *
 * Here rather than in `git/runner.ts`, where it was written, for an
 * architectural reason that a defect made concrete. Ferret starts children from
 * two places — the Git runner and `environment/detect.ts`'s `git --version` —
 * and they had two different policies, the weaker one being the call nobody
 * looks at. Unifying them by importing the runner from `environment/` made the
 * core reach into `git/`, which EPIC-021's boundary test refuses and is right
 * to: replacing the Git provider must not require a core change.
 *
 * What a child may inherit is a property of Ferret's process boundary, not of
 * Git. So it lives with the other things that guard that boundary, and both
 * spawners import it from here. `git/runner.ts` re-exports it, so no caller and
 * no test had to move with it.
 *
 * The Git-specific *names* are still Git's: this module knows what Git reads
 * from the environment because that is what has to be removed from a child that
 * might be Git — and every child Ferret starts is.
 */

/** Environment variables removed from what a Git subprocess inherits. */
export const GIT_ENVIRONMENT_STRIPPED: readonly string[] = Object.freeze([
  // Any of these silently redirects Git at a different repository than the one
  // Ferret resolved, which would make every fact it reports attach to the wrong
  // entity.
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  // Config injection through the environment, equivalent to editing .git/config.
  // Named here for the record; the rule that actually removes them is the
  // `GIT_CONFIG` prefix in `scrubEnvironment`, because this list was written
  // before `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` existed and did not gain
  // them — a list written by name is always one Git release behind (F-94).
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  // Programs Git would run.
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PROXY_COMMAND',
]);

/**
 * Every variable through which Git reads configuration from the environment.
 *
 * `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, the
 * `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pairs, `GIT_CONFIG_GLOBAL` and
 * `GIT_CONFIG_SYSTEM` — and whatever Git adds next.
 */
const GIT_CONFIG_VARIABLE = /^GIT_CONFIG(?:_|$)/u;

/** Environment variables set on every invocation. */
const FORCED_ENV: Readonly<Record<string, string>> = Object.freeze({
  // A repository that needs credentials must fail, not block a background index
  // on a prompt nobody is watching.
  GIT_TERMINAL_PROMPT: '0',
  // Ferret only ever reads. Taking a lock would make an index compete with the
  // developer working in the same repository.
  GIT_OPTIONAL_LOCKS: '0',
});

/**
 * The environment a Git subprocess receives.
 *
 * Inherit-then-remove rather than build-from-nothing: Git legitimately needs
 * `PATH`, `HOME`, `SystemRoot` and a dozen platform-specific variables, and a
 * hand-built environment would break in ways that are tedious to discover one
 * platform at a time. What is removed is the specific set that can redirect Git
 * at a different repository or name a program for it to run — and, since
 * EPIC-081, every variable carrying a credential Ferret holds.
 */
export function scrubEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Credentials first — EPIC-081 §8.4. The list below was written to stop Git
  // being redirected, not to stop a secret leaving, and the two concerns want
  // different lists in different places: this one is Ferret-wide and applies to
  // every child process, not only to `git`.
  const environment: NodeJS.ProcessEnv = withoutCredentials(source);
  for (const name of GIT_ENVIRONMENT_STRIPPED) delete environment[name];
  // The rule, rather than three more names — F-94. Every `GIT_CONFIG*` variable
  // is configuration injection through the environment, and Git has added two of
  // them since `STRIPPED_ENV` was written. A prefix cannot fall behind.
  for (const name of Object.keys(environment)) {
    if (GIT_CONFIG_VARIABLE.test(name)) delete environment[name];
  }
  return { ...environment, ...FORCED_ENV };
}
