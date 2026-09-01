import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { ErrorCode, FerretError } from '../errors/index.js';

import { AuditAction, appendAudit, buildAuditEntry, type AuditEntry } from './audit.js';
import { CONFIG_FILE_VERSION, ferretConfigSchema } from './schema.js';
import { readConfigFile, type ConfigFile } from './file-source.js';
import { auditLogPath, userConfigPath } from './paths.js';
import { isSecretRef, resolveSecrets } from './secret-ref.js';

/**
 * Persisting configuration.
 *
 * Three properties, each covered by a test against the real filesystem:
 *
 * 1. **Durability.** A write is atomic. The file is written to a temporary
 *    sibling, flushed to disk, then renamed over the target — `rename` within a
 *    directory is atomic on both POSIX and Windows. A process killed at any
 *    point leaves either the old file or the new one, never a truncated one.
 *    Losing a database password to a power cut during `ferret config set` would
 *    be an unforced error.
 * 2. **Reliability.** Concurrent writers serialize on a lock file, so two
 *    processes doing read-modify-write cannot lose one another's update.
 * 3. **Validity.** The *merged result* is validated before anything is written.
 *    A rejected change leaves the file exactly as it was — EPIC-003 requires
 *    changes to be validated before activation, and a file that has to be
 *    hand-repaired afterwards does not meet that.
 */

/** How long to wait for another process to finish writing. */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
/** A lock older than this is treated as abandoned by a crashed process. */
export const DEFAULT_LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 25;

function lockPathFor(configPath: string): string {
  return `${configPath}.lock`;
}

function sleepSync(ms: number): void {
  // Deliberately synchronous. Configuration writes are short, rare and must not
  // interleave with other work in this process while the lock is held; making
  // the whole path async would buy nothing and add a reentrancy hazard.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
}

/**
 * Acquires the configuration lock.
 *
 * `open(..., 'wx')` is atomic across processes on POSIX and Windows: exactly one
 * caller can create the file. A lock left behind by a crashed process is
 * detected by age and broken, so a crash cannot make configuration permanently
 * unwritable.
 */
export function acquireLock(configPath: string, options: LockOptions = {}): () => void {
  const lockPath = lockPathFor(configPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  mkdirSync(dirname(configPath), { recursive: true });

  for (;;) {
    try {
      const handle = openSync(lockPath, 'wx', 0o600);
      writeSync(handle, `${String(process.pid)}\n`);
      closeSync(handle);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') {
        throw new FerretError(ErrorCode.CONFIG_INVALID, `Cannot create the configuration lock (${lockPath})`, {
          details: { lockPath },
          remediation: `Ferret's user needs write access to ${dirname(configPath)}.`,
          cause: error,
        });
      }
    }

    // Break an abandoned lock rather than blocking forever on a dead process.
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > staleMs) {
        rmSync(lockPath, { force: true });
        continue;
      }
    } catch {
      // The holder released it between our open and our stat: just retry.
      continue;
    }

    if (Date.now() >= deadline) {
      throw new FerretError(
        ErrorCode.CONFIG_INVALID,
        `Another process has held the configuration lock for more than ${String(timeoutMs)} ms`,
        {
          details: { lockPath, timeoutMs },
          remediation: `Wait for the other Ferret process to finish. If none is running, delete ${lockPath}.`,
          retryable: true,
        },
      );
    }
    sleepSync(LOCK_POLL_MS);
  }
}

/**
 * Writes the configuration file atomically.
 *
 * The `fsync` before the rename is what makes the guarantee real: without it the
 * rename can reach disk before the contents, and a crash in that window leaves a
 * correctly-named empty file — the worst outcome, because it looks valid.
 */
export function writeConfigFileAtomically(path: string, config: Record<string, unknown>): void {
  const document: ConfigFile = { version: CONFIG_FILE_VERSION, config };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });

  // Same directory as the target, so the rename is within one filesystem.
  const temporary = join(directory, `.${String(process.pid)}-${randomBytes(4).toString('hex')}.tmp`);
  let handle: number | undefined;
  try {
    // 0o600: the file may hold a database password. Windows ignores the mode
    // and inherits the directory ACL — recorded as a known limitation.
    handle = openSync(temporary, 'wx', 0o600);
    writeSync(handle, text, null, 'utf8');
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Already closed or never opened; nothing useful to do here.
      }
    }
    rmSync(temporary, { force: true });
    throw new FerretError(ErrorCode.CONFIG_INVALID, `Configuration could not be written (${path})`, {
      details: { path },
      remediation: `Ferret's user needs write access to ${directory}.`,
      cause: error,
    });
  }
}

/**
 * Validates a candidate document before it is allowed to become the
 * configuration.
 *
 * Secret references are resolved first, because a reference to a variable that
 * is not set must fail *here* — while the old file is still intact — rather than
 * at the next startup.
 *
 * @throws {FerretError} `E_CONFIG_INVALID` listing every rejected path. Rejected
 * values are never echoed: a rejected value may itself be a credential.
 */
export function validateCandidate(candidate: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  const resolved = resolveSecrets(candidate, { env });
  const result = ferretConfigSchema.safeParse(resolved);
  if (result.success) return;

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    rule: issue.code,
    message: issue.message,
  }));
  throw new FerretError(
    ErrorCode.CONFIG_INVALID,
    `The change was rejected and nothing was written — ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    {
      details: { issues },
      remediation: 'Correct the listed values and try again. The stored configuration is unchanged.',
    },
  );
}

/**
 * Keys that address JavaScript's object machinery rather than a value.
 *
 * The same three, for the same reason, as `FORBIDDEN_KEYS` in
 * `providers/sdk/operation.ts` — EPIC-011 needed them for a decoded cursor.
 * Duplicated rather than imported because configuration must not depend on the
 * provider SDK; three language constants and a shared comment is the cheaper
 * price than that dependency.
 */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Refuses segments that address object internals.
 *
 * `setAt(document, ['__proto__', 'polluted'], v)` walks into `Object.prototype`
 * — `isRecord` says yes, because it is one — and assigns to it, polluting every
 * object in the process. It then leaves no trace: `JSON.stringify` serializes own
 * enumerable properties only, so the document written to disk is clean and
 * `validateCandidate` never sees anything to reject.
 *
 * A local operator could only ever have done this to their own process. EPIC-066
 * puts configuration writes on the MCP surface, where the path is a string a
 * model chooses and EPIC-084's threat model says indexed content can influence
 * what a model asks for. Same defect, materially different blast radius.
 *
 * Called from `parsePath`, which every surface inside Ferret goes through, **and**
 * from `setAt` and `unsetAt`, which are exported: the guarantee should belong to
 * the function that does the dangerous thing rather than to the discipline of
 * whoever calls it.
 *
 * `USAGE` rather than `CONFIG_INVALID`: the stored configuration is fine, and what
 * arrived was a malformed request.
 *
 * @throws {FerretError} `E_USAGE`
 */
function assertAddressable(segments: readonly string[]): void {
  const forbidden = segments.filter((segment) => FORBIDDEN_SEGMENTS.has(segment));
  if (forbidden.length === 0) return;
  throw new FerretError(
    ErrorCode.USAGE,
    `Configuration path addresses JavaScript object internals: ${forbidden.join(', ')}`,
    {
      details: { path: segments.join('.'), forbidden },
      remediation: `A configuration path may not contain: ${[...FORBIDDEN_SEGMENTS].join(', ')}.`,
    },
  );
}

/**
 * Splits a dotted path, rejecting shapes that cannot address a value.
 *
 * Segments addressing object internals are refused here, at the one place every
 * surface inside Ferret turns a caller's string into a path — see
 * {@link assertAddressable}.
 */
export function parsePath(path: string): string[] {
  const segments = path.split('.').filter((segment) => segment !== '');
  if (segments.length === 0 || segments.length !== path.split('.').length) {
    throw new FerretError(ErrorCode.USAGE, `"${path}" is not a valid configuration path`, {
      details: { path },
      remediation: 'Use a dotted path such as `database.host` or `logLevel`.',
    });
  }

  assertAddressable(segments);
  return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


/** Reads a dotted path out of a document. */
export function getAt(document: Record<string, unknown>, segments: readonly string[]): unknown {
  let cursor: unknown = document;
  for (const segment of segments) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** Returns a copy of `document` with `segments` set to `value`. */
export function setAt(
  document: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): Record<string, unknown> {
  assertAddressable(segments);
  const clone = structuredClone(document);
  let cursor = clone;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!isRecord(existing)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = segments.at(-1);
  if (leaf !== undefined) cursor[leaf] = value;
  return clone;
}

/** Returns a copy of `document` with `segments` removed. */
export function unsetAt(
  document: Record<string, unknown>,
  segments: readonly string[],
): Record<string, unknown> {
  assertAddressable(segments);
  const clone = structuredClone(document);
  let cursor: Record<string, unknown> = clone;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!isRecord(existing)) return clone;
    cursor = existing;
  }
  const leaf = segments.at(-1);
  if (leaf !== undefined) delete cursor[leaf];
  return clone;
}

export interface ConfigStoreOptions {
  readonly path?: string;
  readonly auditPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly lock?: LockOptions;
}

export interface ChangeResult {
  /** The stored document after the change. */
  readonly config: Record<string, unknown>;
  readonly path: string;
  readonly entries: readonly AuditEntry[];
  /** Set when the change succeeded but could not be journalled. */
  readonly auditError: Error | undefined;
}

/**
 * Read-modify-write access to the persisted configuration.
 *
 * Every mutation takes the lock, re-reads from disk, applies the change,
 * validates the result, writes atomically and journals — in that order. Holding
 * the lock across the read is what makes concurrent `ferret config set` safe:
 * without it, two processes would each read the old document and the second
 * write would silently discard the first change.
 */
export interface SetManyOptions {
  /**
   * Leave a stored `$secret` reference exactly as it is — EPIC-081 §8.2.
   *
   * For a caller writing values that have already been through
   * `resolveSecrets`, where "the same value" and "the same configuration" are
   * different things.
   */
  readonly preserveSecretRefs?: boolean;
}

export class ConfigStore {
  readonly path: string;
  /**
   * The journal this store appends to.
   *
   * Public because a caller that reads the journal back must read *this* store's
   * one. EPIC-066 read the platform default instead and reported an empty journal
   * beside a store with two entries in it.
   */
  readonly auditPath: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #lock: LockOptions;

  constructor(options: ConfigStoreOptions = {}) {
    this.#env = options.env ?? process.env;
    this.path = options.path ?? userConfigPath(this.#env);
    this.auditPath = options.auditPath ?? auditLogPath(this.#env);
    this.#lock = options.lock ?? {};
  }

  /** The stored document, or an empty one when no file exists yet. */
  read(): Record<string, unknown> {
    return readConfigFile(this.path)?.config ?? {};
  }

  /** True when a configuration file exists. */
  get exists(): boolean {
    return readConfigFile(this.path) !== undefined;
  }

  #commit(
    mutate: (current: Record<string, unknown>) => { next: Record<string, unknown>; entries: AuditEntry[] },
  ): ChangeResult {
    const release = acquireLock(this.path, this.#lock);
    try {
      // Re-read *inside* the lock. Anything read before it may already be stale.
      const existed = this.exists;
      const current = this.read();
      const { next, entries } = mutate(current);

      validateCandidate(next, this.#env);
      writeConfigFileAtomically(this.path, next);

      const journal = existed
        ? entries
        : [
            buildAuditEntry({ action: AuditAction.CREATE, path: '(file)', hadPreviousValue: false }),
            ...entries,
          ];
      const auditError = appendAudit(journal, this.auditPath);

      return { config: next, path: this.path, entries: journal, auditError };
    } finally {
      release();
    }
  }

  /** Sets one dotted path. */
  set(path: string, value: unknown): ChangeResult {
    const segments = parsePath(path);
    return this.#commit((current) => ({
      next: setAt(current, segments, value),
      entries: [
        buildAuditEntry({
          action: AuditAction.SET,
          path,
          value,
          hadPreviousValue: getAt(current, segments) !== undefined,
        }),
      ],
    }));
  }

  /** Removes one dotted path, restoring whatever default applies. */
  unset(path: string): ChangeResult {
    const segments = parsePath(path);
    return this.#commit((current) => ({
      next: unsetAt(current, segments),
      entries: [
        buildAuditEntry({
          action: AuditAction.UNSET,
          path,
          hadPreviousValue: getAt(current, segments) !== undefined,
        }),
      ],
    }));
  }

  /**
   * Applies several dotted-path changes as one atomic, validated write.
   *
   * {@link SetManyOptions.preserveSecretRefs} exists because the one caller that
   * writes a whole connection at once writes *resolved* values — EPIC-081 AC-3.
   * The check belongs here rather than in that caller: `#commit` re-reads the
   * unresolved document inside the lock, and a caller reading it beforehand
   * would be deciding from a document another process may already have changed.
   */
  setMany(changes: Readonly<Record<string, unknown>>, options: SetManyOptions = {}): ChangeResult {
    const parsed = Object.entries(changes).map(([path, value]) => ({ path, segments: parsePath(path), value }));
    return this.#commit((current) => {
      let next = current;
      const entries: AuditEntry[] = [];
      for (const change of parsed) {
        // The stored form wins. A `$secret` reference is a deliberate choice not
        // to keep the credential here, and overwriting it with the value it
        // resolved to destroys exactly the mitigation D-011 offers — silently,
        // and by the command that recommends it.
        if (options.preserveSecretRefs === true && isSecretRef(getAt(next, change.segments))) continue;
        entries.push(
          buildAuditEntry({
            action: AuditAction.SET,
            path: change.path,
            value: change.value,
            hadPreviousValue: getAt(next, change.segments) !== undefined,
          }),
        );
        next = setAt(next, change.segments, change.value);
      }
      return { next, entries };
    });
  }

  /** Replaces the whole document. */
  replace(document: Record<string, unknown>): ChangeResult {
    return this.#commit(() => ({
      next: structuredClone(document),
      entries: [
        buildAuditEntry({
          action: AuditAction.REPLACE,
          path: '(all)',
          value: Object.keys(document),
          hadPreviousValue: true,
        }),
      ],
    }));
  }
}
