/**
 * Credentials that must not leave this process in a child's environment —
 * EPIC-081 §8.4.
 *
 * Measured before it was written. `STRIPPED_ENV` in the Git runner removes
 * nineteen variables, every one of which redirects Git or names a program for
 * it to run; not one is a credential. `FERRET_DATABASE_PASSWORD` is a supported
 * configuration input (`src/config/resolve.ts`), so on any machine that uses it
 * every `git log`, `git cat-file` and `git --version` Ferret runs inherits the
 * database password.
 *
 * A child process cannot be trusted with it for the ordinary reason: `git`
 * itself is fine, but `git` runs hooks, credential helpers and pagers, and each
 * of those inherits the environment in turn. The blast radius of a variable is
 * everything downstream of the first process that receives it.
 *
 * **An explicit list, not a pattern.** Stripping everything matching
 * `/PASSWORD|TOKEN|SECRET/i` is tempting and is a different change: it would
 * remove variables belonging to the user rather than to Ferret, and breaking a
 * credential helper to protect a secret Ferret does not own is not this Epic's
 * decision to take. What is listed here is what Ferret itself puts in the
 * environment or reads from it.
 */

/**
 * Variables removed from every child process Ferret starts.
 *
 * `FERRET_DATABASE_PASSWORD` is Ferret's own input. `PGPASSWORD` and
 * `PGPASSFILE` are `pg`'s, which Ferret depends on: they are not read by
 * Ferret's configuration, but a machine configured for `psql` has them set, and
 * they name the same credential.
 */
export const CREDENTIAL_ENV: readonly string[] = Object.freeze([
  'FERRET_DATABASE_PASSWORD',
  'PGPASSWORD',
  'PGPASSFILE',
]);

/**
 * A copy of `source` with every credential-carrying variable removed.
 *
 * Inherit-then-remove, for the reason the Git runner already gives: a
 * hand-built environment breaks in ways that are tedious to discover one
 * platform at a time. Removing a known variable is a claim that can be checked;
 * enumerating a safe environment is a claim that cannot.
 */
export function withoutCredentials(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const name of CREDENTIAL_ENV) delete environment[name];
  return environment;
}
