/**
 * Secret redaction.
 *
 * Governance §12 and EPIC-001 require that errors, logs and diagnostics never
 * expose credentials. Redaction is applied at the boundary where data leaves
 * the process (error serialization, log emission, config introspection) so a
 * caller cannot forget to apply it.
 *
 * The strategy is deliberately conservative: over-redaction is a cosmetic
 * defect, under-redaction is a security defect.
 */

import { knownCredentialValues } from '../security/credentials.js';
import { SECRET_KINDS, isSecretKey } from '../security/secrets.js';

/**
 * Re-exported, not redefined.
 *
 * `isSecretKey` moved to `security/secrets.ts` so the subprocess-environment
 * policy could share one vocabulary with redaction rather than keep a second
 * copy of it. This export path is unchanged for every caller.
 */
export { isSecretKey };

export const REDACTED = '[redacted]';

/**
 * Value patterns redacted regardless of the key they appear under, because
 * their shape alone identifies them as a credential.
 *
 * **A superset of EPIC-082's kinds, never a subset — EPIC-091 §8.** Two
 * redactors exist by design: this one for errors and logs, where
 * over-redaction is cosmetic, and `security/secrets.ts` for indexed content,
 * where a false positive destroys data. The split is right; the coverage was
 * not. This list carried six patterns and EPIC-082's carried twelve, so a Slack
 * token, a Google API key, an npm token and a Stripe key were values Ferret
 * refused to *store* and printed verbatim to an operator's terminal, a CI
 * transcript and a client's captured stderr.
 */
const OWN_VALUE_PATTERNS: readonly RegExp[] = [
  // PEM-encoded private key blocks.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // GitHub tokens (classic, fine-grained, OAuth, app, refresh).
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS access key identifiers and their secrets when labelled.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // OpenAI-style and generic long prefixed secrets.
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
];

/**
 * The patterns above, plus every kind EPIC-082 detects.
 *
 * Composed rather than copied. A credential format added to
 * `security/secrets.ts` is redacted here on the same commit, which is the only
 * version of parity that survives the next one.
 *
 * The overlap is deliberate and harmless: several entries above are *looser*
 * than EPIC-082's equivalents -- a 16-character GitHub token body rather than
 * 36 -- because a log line may be truncated and over-redacting one costs
 * nothing. Keeping both means neither list has to be the weaker one.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  ...OWN_VALUE_PATTERNS,
  ...SECRET_KINDS.map((kind) => kind.pattern),
];

/** The userinfo segment of a URI, such as the credentials in a `postgres://` connection URL. */
const URI_USERINFO = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/:@]+)(:[^\s/@]*)?@/gi;

/**
 * Key/value pairs inside strings, such as an assigned `password=` entry.
 *
 * The leading `[A-Za-z0-9_]*` is load-bearing. `\b(password)` alone does **not**
 * match `DATABASE_PASSWORD=hunter2`: the character before `PASSWORD` is an
 * underscore, which is a word character, so there is no boundary there. That is
 * exactly the shape secrets take in the environment Ferret runs in —
 * `FERRET_DATABASE_PASSWORD`, `PG_PASSWORD`, `GITHUB_TOKEN` — so the original
 * pattern missed the cases most likely to occur.
 *
 * Found by an EPIC-008 test that expected a masked value in evidence content and
 * got the real one. The gap affected logs, errors and configuration output too,
 * since they all redact through here.
 *
 * The alternation must still be followed immediately by `=`, so `MY_TOKENIZER=x`
 * and `keyword=fine` are left alone.
 */
const KEYVALUE_SECRET = /\b([A-Za-z0-9_]*(?:passwd|password|pwd|secret|token|api[_-]?key))\s*=\s*[^;,\s]+/gi;

/**
 * Redacts credentials embedded inside a string while preserving the parts that
 * make the string useful for diagnosis (scheme, host, database name).
 */
export function redactString(value: string): string {
  let result = value;
  // The credentials Ferret actually resolved on this run, removed by value —
  // F-71. A database password has no shape a pattern can recognise, so before
  // this it was redacted only where it happened to sit inside a URL or after an
  // `=`. Git's stderr, a `trace` field and a `cause` chain are none of those.
  for (const secret of knownCredentialValues()) {
    if (result.includes(secret)) result = result.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  result = result.replace(URI_USERINFO, (_match, scheme: string, user: string, password?: string) =>
    password === undefined ? `${scheme}://${user}@` : `${scheme}://${user}:${REDACTED}@`,
  );
  result = result.replace(KEYVALUE_SECRET, (_match, key: string) => `${key}=${REDACTED}`);
  return result;
}

const MAX_DEPTH = 8;

/**
 * Deeply copies a value, replacing anything that looks like a credential.
 *
 * Cycles are broken with `[circular]`; depth is capped so a pathological object
 * cannot stall error reporting. Non-plain objects are reduced to a type marker
 * rather than being walked, so class internals never leak.
 */
export function redact(value: unknown): unknown {
  return redactAt(value, 0, new WeakSet<object>());
}

function redactAt(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'symbol':
      return value.toString();
    case 'function':
      return '[function]';
    default:
      break;
  }

  if (depth >= MAX_DEPTH) return '[truncated]';

  // Every remaining `typeof` case is an object, so the switch above has already
  // narrowed `value`.
  const object = value;
  if (seen.has(object)) return '[circular]';
  seen.add(object);

  try {
    if (object instanceof Error) {
      return {
        name: object.name,
        message: redactString(object.message),
      };
    }
    if (object instanceof Date) return object.toISOString();
    if (object instanceof RegExp) return object.source;
    if (object instanceof Map) return '[Map]';
    if (object instanceof Set) return '[Set]';
    if (Array.isArray(object)) {
      return object.map((entry) => redactAt(entry, depth + 1, seen));
    }

    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      return `[${object.constructor?.name ?? 'object'}]`;
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object)) {
      result[key] = isSecretKey(key) ? REDACTED : redactAt(entry, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(object);
  }
}
