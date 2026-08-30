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

export const REDACTED = '[redacted]';

/**
 * Key name fragments that mark a value as sensitive. Matched against the
 * tokenized key, so `apiKey`, `api_key`, `API-KEY` and `apikey` all match.
 */
const SECRET_TOKENS: ReadonlySet<string> = new Set([
  'apikey',
  'accesskey',
  'accesstoken',
  'auth',
  'authorization',
  'bearer',
  'certificate',
  'connectionstring',
  'cookie',
  'credential',
  'credentials',
  'dsn',
  'key',
  'passphrase',
  'passwd',
  'password',
  'privatekey',
  'pwd',
  'refreshtoken',
  'secret',
  'secrets',
  'session',
  'sessionid',
  'signature',
  'token',
]);

/** Key names that look sensitive but are safe and useful to keep. */
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['keys', 'keyword', 'keywords', 'public_key_id']);

/**
 * Value patterns redacted regardless of the key they appear under, because
 * their shape alone identifies them as a credential.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
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

function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

/** True when a property name indicates the value must not be disclosed. */
export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ALLOWED_KEYS.has(key.toLowerCase()) || ALLOWED_KEYS.has(normalized)) return false;
  if (SECRET_TOKENS.has(normalized)) return true;

  const tokens = tokenizeKey(key);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token !== undefined && SECRET_TOKENS.has(token)) return true;
    const next = tokens[i + 1];
    if (token !== undefined && next !== undefined && SECRET_TOKENS.has(`${token}${next}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Redacts credentials embedded inside a string while preserving the parts that
 * make the string useful for diagnosis (scheme, host, database name).
 */
export function redactString(value: string): string {
  let result = value;
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
