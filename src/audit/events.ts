import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';

import { redact } from '../errors/index.js';

/**
 * Audit events — EPIC-085.
 *
 * Six shipped Epics route audit here by name, and each states the event it
 * wants: a denial (EPIC-058, EPIC-083), an authorization decision (EPIC-068), a
 * confirmation (EPIC-069), a credential resolution (EPIC-081), a configuration
 * change (EPIC-066). EPIC-091 §4 drew the line: "A log line is diagnostic,
 * best-effort, level-gated and discardable; an audit event is a durable record
 * with a schema and a retention policy."
 *
 * **NDJSON on disk, not a table.** EPIC-003 put its configuration journal there
 * "for one reason: configuration has to work *before* there is a database, and
 * the change most worth auditing is the one that sets the database up." That
 * generalises exactly — an authorization denial happens in an MCP server
 * composed with only a `RetrievalPort`, and a credential resolution happens
 * before any connection exists. An audit trail that needs the database is
 * absent when the database is the problem.
 *
 * **The protected value is never recorded.** An event names what was attempted,
 * by whom, and the decision. Enforced by shape rather than discipline: the
 * payload is a fixed set of named fields, none of which takes a caller's value,
 * and everything written passes EPIC-091's redactor as a second line.
 */

export const AuditCategory = {
  /** An authorization decision — EPIC-068, EPIC-083. */
  AUTHORIZATION: 'authorization',
  /** A destructive operation's confirmation — EPIC-069. */
  CONFIRMATION: 'confirmation',
  /** A credential was resolved for use — EPIC-081. */
  CREDENTIAL: 'credential',
  /** Ferret's own configuration changed — EPIC-003, EPIC-066. */
  CONFIGURATION: 'configuration',
} as const;

export type AuditCategory = (typeof AuditCategory)[keyof typeof AuditCategory];

export const AuditOutcome = {
  PERMITTED: 'permitted',
  DENIED: 'denied',
  /** Attempted and failed for a reason other than a decision. */
  FAILED: 'failed',
} as const;

export type AuditOutcome = (typeof AuditOutcome)[keyof typeof AuditOutcome];

/**
 * One security-relevant thing Ferret did.
 *
 * Every field is Ferret's own vocabulary or an identifier. **There is no field
 * for a value**, which is EPIC-085 §8.3 expressed as a type rather than as a
 * rule somebody has to remember.
 */
export interface AuditEvent {
  /** ISO-8601 with offset. */
  readonly at: string;
  readonly category: AuditCategory;
  /** What was attempted, in Ferret's own vocabulary: `mcp.search`, `config.set`. */
  readonly action: string;
  readonly outcome: AuditOutcome;
  /** Who, best-effort: a principal id, or the OS user. */
  readonly actor: string;
  /** EPIC-091's per-invocation id, so events and log lines line up. */
  readonly invocation: string;
  /** The permission that was required, when the event is a decision. */
  readonly permission?: string;
  /** What was acted on, as an identifier: a config key, a credential path. */
  readonly subject?: string;
  /** Why, in Ferret's words — never a caller's, and never a value. */
  readonly reason?: string;
  readonly agent: string;
}

/** Bytes a journal reaches before it is rotated. */
export const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;
/** Rotated journals kept, beyond which the oldest is removed. */
export const AUDIT_KEEP_FILES = 5;

/** The OS user, or `unknown`. */
export function currentActor(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

export interface AuditWriterOptions {
  readonly path: string;
  readonly invocation: string;
  readonly agent: string;
  readonly rotateBytes?: number;
  readonly keepFiles?: number;
}

/**
 * Appends events, and rotates.
 *
 * **A failed write never fails the operation.** EPIC-003 decided this for the
 * configuration journal — "an unwritable audit log is a diagnostic problem, and
 * refusing to let a user configure Ferret because of it is the worse outcome" —
 * and it holds harder for a denial: failing closed on an unwritable journal
 * turns a full disk into an outage. The failure is *returned* so the caller can
 * warn, which EPIC-085 §12 makes the one place a log line is the right response
 * to an audit failure.
 */
export class AuditWriter {
  readonly #path: string;
  readonly #invocation: string;
  readonly #agent: string;
  readonly #rotateBytes: number;
  readonly #keepFiles: number;

  constructor(options: AuditWriterOptions) {
    this.#path = options.path;
    this.#invocation = options.invocation;
    this.#agent = options.agent;
    this.#rotateBytes = options.rotateBytes ?? AUDIT_ROTATE_BYTES;
    this.#keepFiles = options.keepFiles ?? AUDIT_KEEP_FILES;
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Records one event.
   *
   * Returns the failure rather than throwing, and returns `undefined` on
   * success. Redaction runs over the assembled record even though no field
   * accepts a value: §8.3's second line of defence, and the cost is one pass
   * over eight short strings.
   */
  record(
    event: Omit<AuditEvent, 'at' | 'invocation' | 'agent'> & { readonly at?: string },
  ): Error | undefined {
    const record: AuditEvent = {
      at: event.at ?? new Date().toISOString(),
      category: event.category,
      action: event.action,
      outcome: event.outcome,
      actor: event.actor,
      invocation: this.#invocation,
      ...(event.permission === undefined ? {} : { permission: event.permission }),
      ...(event.subject === undefined ? {} : { subject: event.subject }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      agent: this.#agent,
    };

    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      // Rotation before the append, so the bound is a bound on the file rather
      // than on the file plus one more line.
      this.#rotate();
      const line = `${JSON.stringify(redact(record))}\n`;
      // One append of a complete line: concurrent writers interleave whole
      // records rather than splicing one into the middle of another — the same
      // reasoning EPIC-003's journal records.
      appendFileSync(this.#path, line, { encoding: 'utf8', mode: 0o600 });
      return undefined;
    } catch (error) {
      return error as Error;
    }
  }

  /**
   * Renames the journal at the size bound and drops the oldest.
   *
   * **Best-effort, and never fails a write.** A journal that cannot be rotated
   * keeps being appended to, which is the failure mode that loses nothing —
   * refusing to append because a rename failed would discard the event to
   * protect a file size.
   *
   * By size rather than age: an audit journal's risk is unbounded growth on a
   * busy install, and deleting by age would discard the only copy of a
   * month-old denial on a quiet one.
   */
  #rotate(): void {
    try {
      const size = statSync(this.#path).size;
      if (size < this.#rotateBytes) return;

      // Shift the suffixes up, oldest first, so nothing is overwritten while a
      // lower number still needs it.
      for (let index = this.#keepFiles - 1; index >= 1; index -= 1) {
        const from = `${this.#path}.${String(index)}`;
        const to = `${this.#path}.${String(index + 1)}`;
        try {
          statSync(from);
          if (index + 1 > this.#keepFiles) rmSync(from, { force: true });
          else renameSync(from, to);
        } catch {
          // Absent, which is the common case for a young journal.
        }
      }
      renameSync(this.#path, `${this.#path}.1`);
      // Anything beyond the kept count, including a file left by an older bound.
      rmSync(`${this.#path}.${String(this.#keepFiles + 1)}`, { force: true });
    } catch {
      // Includes the journal not existing yet, which is not a rotation.
    }
  }
}

/**
 * Reads a journal, oldest first.
 *
 * A damaged line is skipped rather than failing the read: a partially written
 * record must not make the whole history unreadable — EPIC-003's journal reader
 * made the same choice for the same reason.
 */
export function readAuditEvents(path: string): AuditEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const events: AuditEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      // Skipped, deliberately.
    }
  }
  return events;
}

/** Where the journal lives, beside a configuration directory. */
export function auditEventsPath(configDirectory: string): string {
  return join(configDirectory, 'audit-events.ndjson');
}
