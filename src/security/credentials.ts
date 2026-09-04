import { SECRET_KINDS, isSecretKey } from './secrets.js';

/**
 * Credentials that must not leave this process in a child's environment —
 * EPIC-081 §8.4, corrected by F-71.
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
 * **This module used to be an explicit list, and argued for being one.** The
 * argument was that stripping everything matching `/PASSWORD|TOKEN|SECRET/i`
 * would remove variables belonging to the user rather than to Ferret, and that
 * breaking a credential helper to protect a secret Ferret does not own was not
 * EPIC-081's decision to take. F-71 is what that argument cost:
 * `FERRET_DATABASE_URL` carries the same password, two other modules already
 * treat it as a credential, and it was not on the list — so the list was wrong
 * about Ferret's *own* variables, which is the case it was written to cover.
 *
 * The argument is also no longer true. Every child Ferret starts is `git`, run
 * read-only, with `credential.helper=`, `core.sshCommand=` and
 * `GIT_TERMINAL_PROMPT=0`. Nothing in that process tree has a legitimate use for
 * any credential, the operator's included. So the policy here is
 * deny-by-default and derived, in four independent rules, of which the list is
 * only the first:
 *
 * 1. **Named.** Variables Ferret reads, or that `pg` reads for the same secret.
 * 2. **Registered.** Variables a `$secret` reference actually resolved from, and
 *    values Ferret actually resolved — the operator names those, not this file.
 * 3. **Named like a credential.** The same tokenised key rule errors and logs
 *    redact by, applied to the variable's name.
 * 4. **Shaped like a credential.** A connection URL carrying a password, or any
 *    provider format EPIC-082 detects, whatever the variable is called.
 *
 * What is deliberately *not* done is strip everything. `PATH`, `HOME`,
 * `SystemRoot` and the connection's host, port, database and user survive: an
 * environment scrubbed to nothing breaks Git on the platform nobody tested, and
 * an operator debugging a failed index needs to see what Ferret was pointed at.
 */

/**
 * Variables removed by name.
 *
 * `FERRET_DATABASE_PASSWORD` and `FERRET_DATABASE_URL` are Ferret's own inputs;
 * the URL form carries the password in its userinfo, which is why
 * `storage/export.ts` redacts it before printing a backup command. The `PG*`
 * entries are `pg`'s, which Ferret depends on: they are not read by Ferret's
 * configuration, but a machine configured for `psql` has them set, and each
 * names the same credential or a file holding one.
 */
export const CREDENTIAL_ENV: readonly string[] = Object.freeze([
  'FERRET_DATABASE_PASSWORD',
  'FERRET_DATABASE_URL',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGSERVICEFILE',
  'PGSSLKEY',
]);

/**
 * Shortest value tracked by content.
 *
 * A credential shorter than this is not tracked, because substring removal on a
 * four-character value would delete it from every diagnostic that happened to
 * contain those characters, and a redaction that destroys the message is its own
 * defect. The floor is a stated limit rather than an oversight: rules 1, 3 and 4
 * do not depend on it.
 */
const MIN_TRACKED_VALUE = 8;

/**
 * Shortest value that will cause an argument vector to be *refused*.
 *
 * Higher than {@link MIN_TRACKED_VALUE} because the consequence is different.
 * Removing a value from a log line costs a diagnostic; refusing an argument
 * stops an index. Twelve characters of a real password appearing inside a path
 * or a ref name is not a coincidence worth designing for, and eight might be.
 */
export const MIN_REFUSABLE_VALUE = 12;

/**
 * Variable names that read as a credential and are not one.
 *
 * `isSecretKey` is written for *configuration keys*, where `pwd` means password.
 * As an environment variable, `PWD` is the working directory every POSIX shell
 * sets and several tools read, and removing it from a child is the other half of
 * this file's failure mode — solving disclosure by destroying the environment.
 * Found by measuring `withoutCredentials(process.env)` on a real machine rather
 * than by reasoning about the rule.
 *
 * Deliberately tiny, and additions belong here only with the same evidence: a
 * variable a child legitimately reads, whose name the shared vocabulary reads as
 * a secret.
 */
const NOT_A_CREDENTIAL: ReadonlySet<string> = new Set(['PWD', 'OLDPWD']);

/** A bound, so a pathological configuration cannot grow these without limit. */
const MAX_REGISTERED = 64;

const registeredValues = new Set<string>();
const registeredNames = new Set<string>();

/**
 * Bumped whenever what counts as a credential changes.
 *
 * The decision cache below is keyed by it, so a value registered after a
 * variable was first judged is not answered from a stale verdict.
 */
let generation = 0;

/**
 * Records a value Ferret resolved as one of its own credentials.
 *
 * Called by secret resolution and by the credential registry, so the set is
 * whatever Ferret actually holds on this run rather than whatever this file
 * guessed. Values below {@link MIN_TRACKED_VALUE} are ignored.
 */
export function registerCredentialValue(value: string): void {
  if (typeof value !== 'string' || value.length < MIN_TRACKED_VALUE) return;
  if (registeredValues.size >= MAX_REGISTERED) return;
  if (registeredValues.has(value)) return;
  registeredValues.add(value);
  generation += 1;
}

/**
 * Records an environment variable a `$secret` reference read from.
 *
 * `{ "$secret": { "env": "MY_OWN_NAME" } }` is supported configuration, so the
 * set of credential-bearing variable *names* is chosen by the operator at run
 * time and cannot be written down here.
 */
export function registerCredentialVariable(name: string): void {
  if (typeof name !== 'string' || name.length === 0) return;
  if (registeredNames.size >= MAX_REGISTERED) return;
  if (registeredNames.has(name)) return;
  registeredNames.add(name);
  generation += 1;
}

/** The credential values Ferret has resolved on this run. Used by redaction. */
export function knownCredentialValues(): readonly string[] {
  return [...registeredValues];
}

/** The environment variables a secret reference has read from on this run. */
export function knownCredentialVariables(): readonly string[] {
  return [...registeredNames];
}

/** Longest value examined by shape. Beyond it, only the exact-value rule applies. */
const MAX_SHAPE_SCAN = 4096;

/**
 * A URI carrying a non-empty password in its userinfo.
 *
 * Deliberately narrower than "contains an `@`": a scheme, host and user with no
 * password is an address and stays; the same URI with a password in its
 * userinfo is a credential and goes.
 *
 * No worked example in this comment, for the reason `secrets.ts` gives about its
 * own: the packaging scan reads the shipped bytes, and a realistic one here trips
 * it — correctly, which is how this line came to be written the second time.
 */
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;

/**
 * True when a value is a credential whatever the variable is called.
 *
 * Rule 4. The provider formats come from EPIC-082's list rather than a second
 * copy of it, so a credential format added there is stripped from a subprocess
 * environment on the same commit — the composition `errors/redact.ts` already
 * uses, for the same reason.
 */
export function looksLikeCredentialValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SHAPE_SCAN) return false;
  if (URL_WITH_PASSWORD.test(value)) return true;
  for (const { pattern } of SECRET_KINDS) {
    // The kinds carry `g`, which makes `test` stateful. Resetting is not
    // optional: without it every other call answers from the previous match.
    pattern.lastIndex = 0;
    const found = pattern.test(value);
    pattern.lastIndex = 0;
    if (found) return true;
  }
  return false;
}

/** True when `value` contains a credential Ferret resolved on this run. */
export function carriesRegisteredCredential(value: string): boolean {
  for (const secret of registeredValues) {
    if (value.includes(secret)) return true;
  }
  return false;
}

/** True when `value` contains a registered credential long enough to refuse over. */
export function carriesRefusableCredential(value: string): boolean {
  for (const secret of registeredValues) {
    if (secret.length >= MIN_REFUSABLE_VALUE && value.includes(secret)) return true;
  }
  return false;
}

function judge(name: string, value: string): boolean {
  if (CREDENTIAL_ENV.includes(name)) return true;
  if (registeredNames.has(name)) return true;
  // The exemption suspends the *name* rule only. A `PWD` whose value is a
  // connection URL is still a credential, and answering `false` here would have
  // made the exemption a hole rather than a correction.
  if (!NOT_A_CREDENTIAL.has(name) && isSecretKey(name)) return true;
  // Exact-value containment is not length-bounded: it is a substring search, and
  // a long value is exactly where a credential hides from the shape rules.
  if (carriesRegisteredCredential(value)) return true;
  return looksLikeCredentialValue(value);
}

/**
 * Decisions already made, so a rule that runs thirteen regular expressions is
 * paid for once per distinct variable rather than once per subprocess.
 *
 * Measured, and the measurement is worth stating precisely because the first
 * reading of it was wrong. On a 128-variable environment `scrubEnvironment`
 * costs 0.47 ms with this cache and 0.73 ms without — but copying `process.env`
 * at all already cost 0.42 ms before any of this existed. So the four rules are
 * about 0.05 ms of that, and the regular expressions they would otherwise re-run
 * once per `git` for every blob of an index are about 0.35 ms. The cache earns
 * its place; the alarming figure in the first measurement was Node's environment
 * object, not these rules.
 *
 * Keyed by name, with the value *carried in the entry and compared* rather than
 * concatenated into the key. `PATH` is four kilobytes: building a cache key out
 * of it once per variable per invocation cost more than the rules it was meant to
 * save, which the second measurement showed and the first did not. Invalidated by
 * `generation`, so registering a credential re-judges everything already decided.
 */
const decisions = new Map<string, { generation: number; value: string; credential: boolean }>();
const MAX_DECISIONS = 512;

function isCredentialVariable(name: string, value: string): boolean {
  const cached = decisions.get(name);
  if (cached !== undefined && cached.generation === generation && cached.value === value) {
    return cached.credential;
  }

  const credential = judge(name, value);
  if (decisions.size >= MAX_DECISIONS) decisions.clear();
  decisions.set(name, { generation, value, credential });
  return credential;
}

/**
 * A copy of `source` with every credential-carrying variable removed.
 *
 * Inherit-then-remove, for the reason the Git runner already gives: a
 * hand-built environment breaks in ways that are tedious to discover one
 * platform at a time. Removing a known variable is a claim that can be checked;
 * enumerating a safe environment is a claim that cannot.
 */
export function withoutCredentials(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isCredentialVariable(name, value)) continue;
    environment[name] = value;
  }
  return environment;
}
