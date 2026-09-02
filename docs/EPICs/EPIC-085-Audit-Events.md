# EPIC-085 — Audit Events

**Status: APPROVED | Priority: P1 | Domain: Security & Authorization**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Security & Authorization;
> only the specification is new.

## 1. Objective

Record the security-relevant things Ferret did — durably, append-only, and
without ever writing the value that was protected.

## 2. Value

Six shipped Epics route audit here by name, and each states the event it wants:
a **denial** (EPIC-058 §4, EPIC-083 §4), an **authorization decision**
(EPIC-068 §4), a **confirmation** (EPIC-069 §4), a **credential read or
resolution** (EPIC-081 §4), a **configuration change** (EPIC-066 §4). EPIC-091
§4 drew the line this Epic sits on: "A log line is diagnostic, best-effort,
level-gated and discardable; an audit event is a durable record with a schema
and a retention policy."

So today every one of those is a `debug` log line on stderr — discardable, and
gone the moment an operator did not capture it. And EPIC-003's checkpoint
records the other half: "The audit journal is never rotated → **EPIC-085**."

## 3. Scope

- An **`AuditEvent`** with a category, an action, an outcome and an actor.
- An **append-only NDJSON journal** with **rotation** — the recorded gap.
- **Sources**: authorization decisions and denials, confirmations, credential
  resolution, and EPIC-003's configuration journal as one of them.
- **Never the protected value** — §8.3.

## 4. Non-scope

- **A database table.** §8.2.
- **Shipping, aggregation or alerting** — an operator's job with NDJSON, exactly
  as EPIC-091 decided for logs.
- **A retention *policy*** — EPIC-088 owns retention. This Epic bounds the
  journal's size so it cannot grow without limit; how long an organisation keeps
  what it copied off is theirs.
- **Changing EPIC-003's on-disk entry format.** §8.4.
- **Auditing reads.** Every search would be an event, which is a log, not an
  audit trail. Only a *denial* is recorded, because that is the security fact.

## 5. Inputs

The authorization guard's decision, the confirmation gate's outcome, the
credential resolver's path, EPIC-003's journal entries, and EPIC-091's actor and
invocation id.

## 6. Outputs

`src/audit/` — the event, the writer and rotation. A journal at
`<config-dir>/audit.ndjson`. No schema change, no migration, no dependency.

## 7. Dependencies

EPIC-003 (the config directory and its journal), EPIC-068/083 (the decisions),
EPIC-069 (confirmations), EPIC-081 (credentials), EPIC-091 (actor, invocation).

## 8. Contracts

### 8.1 An event is durable; a log line is not

An audit event is written with `fsync`-less append but **flushed before the
operation it describes returns**, so a process killed immediately after a denial
still has the denial on disk. A log line is fire-and-forget; an audit event is
not, and that is the whole distinction EPIC-091 named.

**A failed write never fails the operation.** EPIC-003 decided this for the
configuration journal — "an unwritable audit log is a diagnostic problem, and
refusing to let a user configure Ferret because of it is the worse outcome" —
and the same holds for a denial: failing closed on an unwritable journal would
turn a disk-full into an outage. The failure is *reported*, and §12 says where.

### 8.2 NDJSON beside the configuration, not a table

EPIC-003 put its journal on disk "for one reason: configuration has to work
*before* there is a database, and the change most worth auditing is the one that
sets the database up." That reasoning generalises exactly: an authorization
denial happens in an MCP server composed with only a `RetrievalPort`, and a
credential resolution happens before any connection exists. An audit trail that
requires the database is absent when the database is the problem.

So: append-only NDJSON, one event per line, in the configuration directory. No
migration, and the file is readable by `tail`, `jq` and an operator's own
shipper.

### 8.3 The protected value is never recorded

Every source Epic says this and none of them is negotiable. An event records
**what was attempted, by whom, and the decision** — the operation name, the
missing permission, the configuration *key*, the credential's *path*. Never the
value, never the statement, never the argument.

The rule is enforced by shape rather than by discipline: an event's payload is a
fixed set of named fields, none of which accepts a caller's value, and
everything written passes EPIC-091's redactor as a second line of defence.

### 8.4 EPIC-003's journal is a source, and its format does not change

Its entry shape was written "deliberately close to an event so that becoming one
of its sources does not require a format change" (EPIC-003 §D-009's
consequence). So it is not rewritten: the configuration journal keeps writing its
own entries at its own path, **and** emits an `AuditEvent` for the same change.

Two files rather than one migration of somebody's installed journal. What that
costs is stated: a configuration change appears in both, and §16 records why
that is the cheaper mistake.

### 8.5 Rotation is by size, with a bounded number kept

The recorded gap. At a size bound the journal is renamed with a numeric suffix
and a new one started; beyond a kept count the oldest is deleted. Size rather
than age, because an audit journal's risk is unbounded growth on a busy install
rather than staleness, and deleting by age would discard the only copy of a
month-old denial on a quiet one.

Rotation is **best-effort and never fails a write**: a journal that cannot be
rotated keeps being appended to, which is the failure mode that loses nothing.

## 9. Acceptance criteria

- **AC-1** An event is appended as one NDJSON line, parseable on its own.
- **AC-2** Events append in order; a second write does not truncate the first.
- **AC-3** An event carries category, action, outcome, actor, invocation and an
  ISO-8601 instant with offset.
- **AC-4** A denial is recorded with the operation and the missing permission.
- **AC-5** A permitted decision is recorded, so the trail is not only failures.
- **AC-6** A confirmation records the operation and whether it was confirmed.
- **AC-7** A credential resolution records the *path*, never the value.
- **AC-8** No event contains a protected value: asserted over a payload built
  from secret-shaped input.
- **AC-9** An unwritable journal does not fail the operation, and is reported.
- **AC-10** The journal rotates at the size bound, and the previous file is kept.
- **AC-11** Beyond the kept count the oldest is removed.
- **AC-12** Rotation failure does not fail the write.
- **AC-13** A configuration change produces both its EPIC-003 entry and an
  event, and the EPIC-003 entry's shape is byte-identical to before.
- **AC-14** Reading back a journal yields the events that were written, in
  order.
- **AC-15** Every source is wired: a denial, a decision, a confirmation, a
  credential resolution and a configuration change each produce an event in a
  real run.

## 10. Test requirements

**Unit** — the event shape, append order, redaction over secret-shaped input,
rotation at the bound and past the kept count, an unwritable path, and a
rotation failure.

**Integration** — AC-13 and AC-15 through the real config store and the real MCP
guard.

**Security** — AC-8, over every source's payload.

**Regression** — EPIC-003's and EPIC-083's suites unchanged.

## 11. Security requirements

§8.3 is the requirement. Two controls: the payload has no field that takes a
caller's value, and everything written passes EPIC-091's redactor. The journal's
file mode matches the configuration file's, because an audit trail readable by
every local user is a disclosure of who did what.

## 12. Observability

A failed audit write is logged at `warn` with the reason — the one place a
diagnostic log line is the correct response to an audit failure, because the
alternative is silence about the silence.

## 13. Performance constraints

One append per event, no read, no lock. Rotation is one `stat` per write and a
rename at the bound.

## 14. Definition of Done

Scope implemented; AC-1 to AC-15 with evidence in
`validation/EPIC-085-VALIDATION.md`; `npm run verify` green; the registry
updated; EPIC-003's rotation gap struck with a dated note.

## 15. Governance alignment

- **§12 Security** — the decision is recorded where it was made, and the
  protected value is not.
- **§20 Observability** — "errors must be inspectable", durably rather than only
  on a stream somebody may not have captured.
- **§14 Lightweight Infrastructure** — §8.2 needs no table and no daemon.
- **§6 Evidence Before Inference** — §8.5's size-based rotation declines to
  discard the only copy of an old event on a quiet install.

## 16. Raised, not absorbed

- **A configuration change appears in two files.** Rewriting EPIC-003's journal
  into this one would change a format already on disk in installs, for a
  duplicate line in a diagnostic trail. The cheaper mistake is the duplicate.
- **Retention is EPIC-088's.** This Epic bounds size; how long a copy is kept is
  a policy.
- **No signing or tamper-evidence.** An append-only file a local root can edit is
  not an attestation. Chaining hashes per line would make tampering *detectable*
  and is the obvious next increment; it has no owner.
- **Reads are not audited** (§4), so "who searched for what" is unanswerable from
  this trail by design.

## 17. Recorded during implementation

- **Rotation happens before the append**, so the bound is a bound on the file
  rather than on the file plus one more line.
- **The writer is optional on every source.** A caller composing a server with
  only a `RetrievalPort`, or a `ConfigStore` with no directory, still works —
  absent means the log line is the only record, which is the state this Epic
  exists to end and still better than refusing to serve.
