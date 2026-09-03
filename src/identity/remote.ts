import { REDACTED } from '../errors/index.js';

/**
 * Normalizing a remote URL — EPIC-036, moved here by EPIC-051.
 *
 * It lived in `src/git/` until a second caller appeared. Reducing
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo` and
 * `owner/repo` to one identifier is what makes two clones — and a clone and a
 * project tracker — the same repository, and none of that is Git-specific. The
 * boundary tests refused the alternative: importing `git/identity.ts` from
 * `src/resolution/` put a subprocess runner's module into the core graph, which
 * is a real objection and not a technicality.
 *
 * `src/git/identity.ts` re-exports these, so every existing caller is unchanged.
 *
 * The second job of this module is **not leaking a token**. Remote URLs carry
 * credentials far more often than anyone expects: `git clone` with a personal
 * access token writes it straight into `.git/config`, where it stays. Ferret
 * reads that config. Userinfo is therefore stripped during normalization, before
 * the URL can reach an entity, a log or an error message.
 */

export interface NormalizedRemote {
  /** Canonical form: `host/path`, no scheme, no credentials, no `.git`. */
  readonly canonical: string;
  /** The URL with any credentials masked, safe to store and display. */
  readonly display: string;
  readonly host: string | undefined;
  readonly path: string;
  /** True when the original carried a username or password. */
  readonly hadCredentials: boolean;
}

/** `git@github.com:owner/repo.git` — SSH's scp-like form, which is not a URL. */
const SCP_LIKE = /^(?:([^@/\\]+)@)?([^:/\\]+):(?!\/)(.+)$/;

/** Ports that add nothing to identity when they are the protocol's default. */
const DEFAULT_PORTS: ReadonlyMap<string, string> = new Map([
  ['ssh:', '22'],
  ['git:', '9418'],
  ['http:', '80'],
  ['https:', '443'],
]);

/**
 * Reduces a remote URL to the identity two clones of it would share.
 *
 * Returns `undefined` for something that is not a remote at all, rather than
 * guessing. A guessed identity is worse than no identity: it silently merges
 * two repositories, and nothing downstream can tell that it happened.
 */
export function normalizeRemote(url: string): NormalizedRemote | undefined {
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;

  const parsed = parseUrl(trimmed) ?? parseScpLike(trimmed);
  if (parsed === undefined) return undefined;

  const path = normalizePath(parsed.path);
  if (path.length === 0) return undefined;

  const host = parsed.host === undefined ? undefined : parsed.host.toLowerCase();
  const canonical = host === undefined ? path : `${host}/${path}`;

  return {
    canonical,
    display: parsed.display,
    host,
    path,
    hadCredentials: parsed.hadCredentials,
  };
}

interface ParsedRemote {
  readonly host: string | undefined;
  readonly path: string;
  readonly display: string;
  readonly hadCredentials: boolean;
}

function parseUrl(value: string): ParsedRemote | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  // A bare Windows path parses as a URL with protocol `c:`, which would produce
  // a nonsense host. Anything whose scheme is a single letter is a drive.
  if (/^[a-z]:$/i.test(url.protocol)) return undefined;

  const hadCredentials = url.username !== '' || url.password !== '';

  if (url.protocol === 'file:') {
    // A local path is not a shared identity — two people's `/home/x/repo` are
    // different repositories — but it is still a valid remote, and the caller
    // decides what to do with a hostless one.
    return { host: undefined, path: decodeSafely(url.pathname), display: value, hadCredentials: false };
  }

  const port = url.port === '' || DEFAULT_PORTS.get(url.protocol) === url.port ? '' : `:${url.port}`;
  const host = `${url.hostname}${port}`;

  const display = hadCredentials
    ? `${url.protocol}//${REDACTED}@${host}${url.pathname}`
    : value;

  return { host, path: decodeSafely(url.pathname), display, hadCredentials };
}

function parseScpLike(value: string): ParsedRemote | undefined {
  const match = SCP_LIKE.exec(value);
  if (match === null) return undefined;

  const user = match[1];
  const host = match[2];
  const path = match[3];
  if (host === undefined || path === undefined || host.length === 0) return undefined;

  // `git@` is the convention, not a credential, and treating it as one would
  // mask the overwhelmingly common case for no benefit. Anything else in that
  // position is a username Ferret has no business repeating.
  const hadCredentials = user !== undefined && user !== 'git';
  const display = hadCredentials ? `${REDACTED}@${host}:${path}` : value;

  return { host, path, display, hadCredentials };
}

/**
 * The path half of a repository identity.
 *
 * Case is preserved. GitHub treats `Indoulia/Ferret` and `indoulia/ferret` as
 * the same repository; a self-hosted Git server on a case-sensitive filesystem
 * does not, and lowercasing would silently merge two of them. Preserving case
 * can only ever *fail to* merge, which EPIC-051 can correct with evidence;
 * merging wrongly cannot be undone by anything.
 */
function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape in a URL from a repository Ferret did not write. The
    // raw form is still a usable identity; refusing the whole repository over
    // it would be a worse answer.
    return value;
  }
}

/**
 * Masks a credential in a remote URL for display.
 *
 * Used wherever a URL is shown but identity is not being computed — an error
 * message naming the remote that failed, for instance.
 */
export function maskRemote(url: string): string {
  const normalized = normalizeRemote(url);
  return normalized?.display ?? url.replace(/\/\/[^/@\s]+@/g, `//${REDACTED}@`);
}
