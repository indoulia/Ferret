/**
 * Audit events — EPIC-085.
 *
 * A durable, append-only NDJSON trail of the security-relevant things Ferret
 * did. Six shipped Epics route audit here by name; EPIC-091 §4 drew the line
 * between a discardable log line and a durable record.
 */

export {
  AUDIT_KEEP_FILES,
  AUDIT_ROTATE_BYTES,
  AuditCategory,
  AuditOutcome,
  AuditWriter,
  auditEventsPath,
  currentActor,
  readAuditEvents,
  type AuditEvent,
  type AuditWriterOptions,
} from './events.js';
