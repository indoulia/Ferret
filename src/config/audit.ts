import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';

import { REDACTED, isSecretKey, redact } from '../errors/index.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

import { auditLogPath } from './paths.js';

/**
 * Configuration change auditing.
 *
 * EPIC-003 requires configuration changes to be auditable. The journal lives
 * beside the configuration file as append-only NDJSON, rather than in the
 * database, for one reason: configuration has to work *before* there is a
 * database, and the change most worth auditing is the one that sets the
 * database up.
 *
 * EPIC-085 owns the general audit-event model. When it arrives this journal
 * becomes one of its sources; the entry shape below is deliberately close to an
 * event so that does not require a format change.
 *
 * Values are never recorded — only which key changed, and whether it now has a
 * value. Auditing a password change by writing the password down would defeat
 * the point.
 */

export const AuditAction = {
  SET: 'set',
  UNSET: 'unset',
  /** The file was created for the first time. */
  CREATE: 'create',
  /** Written wholesale, e.g. by `ferret init --save`. */
  REPLACE: 'replace',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  /** ISO-8601 instant, with offset. */
  readonly at: string;
  readonly action: AuditAction;
  /** Dotted configuration path, e.g. `database.host`. */
  readonly path: string;
  /**
   * The new value, redacted. `undefined` for an unset. A secret-named key is
   * always `[redacted]`, so the journal records *that* it changed, never *to
   * what*.
   */
  readonly value?: unknown;
  /** Whether a value was present before the change. Never the old value. */
  readonly hadPreviousValue: boolean;
  /** Who made the change, best-effort. */
  readonly actor: string;
  /** Which Ferret wrote the entry. */
  readonly agent: string;
}

/** The OS user, or `unknown` where it cannot be determined. */
function currentActor(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

/**
 * Redacts a value for the journal.
 *
 * Two layers: a secret-named key is masked whatever it holds, and the value
 * itself is walked by {@link redact} so a credential embedded in an
 * innocuously-named field is caught too.
 */
export function auditValue(path: string, value: unknown): unknown {
  const leaf = path.split('.').at(-1) ?? path;
  if (isSecretKey(leaf)) return REDACTED;
  return redact(value);
}

export interface RecordChangeOptions {
  readonly action: AuditAction;
  readonly path: string;
  readonly value?: unknown;
  readonly hadPreviousValue: boolean;
  readonly at?: Date;
  readonly actor?: string;
}

/** Builds an entry without writing it, so the shape can be tested directly. */
export function buildAuditEntry(options: RecordChangeOptions): AuditEntry {
  const entry: {
    at: string;
    action: AuditAction;
    path: string;
    value?: unknown;
    hadPreviousValue: boolean;
    actor: string;
    agent: string;
  } = {
    at: (options.at ?? new Date()).toISOString(),
    action: options.action,
    path: options.path,
    hadPreviousValue: options.hadPreviousValue,
    actor: options.actor ?? currentActor(),
    agent: `${PACKAGE_NAME}@${VERSION}`,
  };
  if (options.action !== AuditAction.UNSET) {
    entry.value = auditValue(options.path, options.value);
  }
  return entry;
}

/**
 * Appends entries to the journal.
 *
 * Failure to write the journal must never fail the configuration change itself:
 * an unwritable audit log is a diagnostic problem, and refusing to let the user
 * configure Ferret because of it would be a worse outcome than a gap in the
 * journal. The failure is returned so the caller can warn.
 */
export function appendAudit(
  entries: readonly AuditEntry[],
  path: string = auditLogPath(),
): Error | undefined {
  if (entries.length === 0) return undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    // A single append of complete lines: concurrent writers interleave whole
    // records rather than splicing one into the middle of another.
    appendFileSync(path, lines, { encoding: 'utf8', mode: 0o600 });
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

/**
 * Reads the journal, newest last.
 *
 * A damaged line is skipped rather than failing the read: a partially written
 * record must not make the whole history unreadable.
 */
export function readAudit(path: string = auditLogPath()): AuditEntry[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  const entries: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      entries.push(JSON.parse(trimmed) as AuditEntry);
    } catch {
      continue;
    }
  }
  return entries;
}
