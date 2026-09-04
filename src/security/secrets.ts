/**
 * Credential detection for indexed content — EPIC-082.
 *
 * Separate from `errors/redact.ts`: that redacts errors and logs, where being
 * aggressive costs nothing. Here a false positive silently destroys real
 * content, so only high-precision provider formats are matched. Entropy
 * heuristics are deliberately absent — their precision on source code is poor.
 *
 * Applied at ingestion. A secret in the database is already leaked to anyone
 * with database access, and query-time redaction would depend on every future
 * query path remembering it.
 */

export interface SecretKind {
  readonly kind: string;
  readonly pattern: RegExp;
}

/**
 * Anchored, non-backtracking. Commit messages are attacker-controlled.
 *
 * Each pattern matches a format a provider issues, not "something that looks
 * secret". Ordering matters only for overlapping formats: the private key block
 * runs first so its body is not re-matched piecewise.
 */
export const SECRET_KINDS: readonly SecretKind[] = Object.freeze([
  { kind: 'private-key', pattern: /-----BEGIN[ A-Z]{0,20}PRIVATE KEY-----[\s\S]{0,4096}?-----END[ A-Z]{0,20}PRIVATE KEY-----/g },
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,255}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'openai-api-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,255}\b/g },
  { kind: 'stripe-key', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,255}\b/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // The password half of URL userinfo, and only that half — the scheme, user
  // and host stay. (No worked example here: the packaging scan reads the
  // shipped bytes and a realistic one in a comment trips it, correctly.)
  { kind: 'url-credential', pattern: /(?<=:\/\/[^\s/:@]{1,255}:)[^\s/@]{1,255}(?=@)/g },
  // Anchored on the assignment, so prose about a password is untouched. The
  // trailing run matters: without it `AWS_SECRET_ACCESS_KEY=` did not match,
  // because the keyword then has to be the last token before the `=`.
  { kind: 'assigned-secret', pattern: /(?<=\b[A-Za-z0-9_]{0,60}(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,30}\s{0,4}[=:]\s{0,4})(?!\s)[^\s;,'"]{6,255}/gi },
]);

export interface RedactionResult {
  readonly text: string;
  /** Kind → count. Never the values. */
  readonly found: Readonly<Record<string, number>>;
  readonly redacted: number;
}

/** Longest input scanned. Beyond this the text is dropped rather than stored. */
const MAX_SCANNED = 1_000_000;

/**
 * Removes credentials from text bound for the index.
 *
 * Fails closed: text too large to scan is replaced entirely rather than stored
 * unchecked.
 */
export function redactSecrets(text: string): RedactionResult {
  if (text.length === 0) return { text, found: {}, redacted: 0 };
  if (text.length > MAX_SCANNED) {
    return {
      text: '[redacted: text too large to scan for credentials]',
      found: { unscannable: 1 },
      redacted: 1,
    };
  }

  const found: Record<string, number> = {};
  let result = text;

  for (const { kind, pattern } of SECRET_KINDS) {
    // `lastIndex` is shared state on a `g` regex; reset so one call cannot
    // affect the next.
    pattern.lastIndex = 0;
    result = result.replace(pattern, () => {
      found[kind] = (found[kind] ?? 0) + 1;
      return `[redacted: ${kind}]`;
    });
  }

  const redacted = Object.values(found).reduce((total, n) => total + n, 0);
  return { text: result, found: Object.freeze(found), redacted };
}

/** True when the text carries anything this detector recognises. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text).redacted > 0;
}

/**
 * Paths excluded because of what they hold rather than because they are noise.
 *
 * Additive to EPIC-003's `DEFAULT_EXCLUSIONS`; a repository policy may exclude
 * more and never less.
 */
export const SECRET_PATH_EXCLUSIONS: readonly { pattern: string; reason: string }[] = Object.freeze([
  { pattern: '**/.env', reason: 'Environment file, commonly holds credentials' },
  { pattern: '**/.env.*', reason: 'Environment file, commonly holds credentials' },
  { pattern: '**/*.pem', reason: 'PEM-encoded key or certificate' },
  { pattern: '**/*.key', reason: 'Private key' },
  { pattern: '**/*.p12', reason: 'PKCS#12 key store' },
  { pattern: '**/*.pfx', reason: 'PKCS#12 key store' },
  { pattern: '**/*.keystore', reason: 'Key store' },
  { pattern: '**/*.jks', reason: 'Java key store' },
  { pattern: '**/id_rsa', reason: 'SSH private key' },
  { pattern: '**/id_dsa', reason: 'SSH private key' },
  { pattern: '**/id_ecdsa', reason: 'SSH private key' },
  { pattern: '**/id_ed25519', reason: 'SSH private key' },
  { pattern: '**/.npmrc', reason: 'May hold a registry auth token' },
  { pattern: '**/.pypirc', reason: 'May hold a registry auth token' },
  { pattern: '**/.pgpass', reason: 'PostgreSQL password file' },
  { pattern: '**/.netrc', reason: 'Machine credentials' },
  { pattern: '**/credentials', reason: 'Cloud provider credential file' },
  { pattern: '**/credentials.json', reason: 'Service account credentials' },
  { pattern: '**/service-account*.json', reason: 'Service account credentials' },
]);

/**
 * Directories whose contents are credentials by convention.
 *
 * Deliberately short. A directory called `secrets/` is a strong hint and is
 * still not here: it commonly holds *encrypted* material committed on purpose,
 * and exclusions are additive — a repository may exclude more and never less,
 * so over-excluding cannot be undone by the person it hurts. These four are
 * unambiguous.
 */
const SECRET_DIRECTORIES: readonly string[] = Object.freeze([
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
]);

/**
 * Paths that match an exclusion but hold no secret.
 *
 * `.env.example` is documentation and is the file most likely to explain what a
 * project needs. Excluding it costs real value for no gain.
 */
const SECRET_PATH_ALLOWED = /(^|\/)\.env\.(example|sample|template|dist|defaults?)$/i;

/** True when a path should never be indexed. */
export function isSecretPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (SECRET_PATH_ALLOWED.test(normalized)) return false;

  const segments = normalized.split('/');
  if (segments.slice(0, -1).some((segment) => SECRET_DIRECTORIES.includes(segment))) return true;

  const name = segments[segments.length - 1] ?? '';
  return SECRET_PATH_EXCLUSIONS.some(({ pattern }) => {
    const bare = pattern.replace(/^\*\*\//, '');
    if (bare.startsWith('*.')) return name.endsWith(bare.slice(1));
    if (bare.endsWith('*.json')) {
      const prefix = bare.slice(0, bare.indexOf('*'));
      return name.startsWith(prefix) && name.endsWith('.json');
    }
    if (bare.endsWith('.*')) return name.startsWith(bare.slice(0, -1));
    return name === bare;
  });
}

/**
 * The key-name half of credential detection.
 *
 * It lives beside the value patterns, and not in `errors/redact.ts` where it
 * was written, because two policies now need the same vocabulary: redaction,
 * where a false positive is cosmetic, and `security/credentials.ts`, which
 * decides whether an environment variable reaches a child process. Copying it
 * would have let them drift, and drift between two credential lists is F-71.
 */
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
