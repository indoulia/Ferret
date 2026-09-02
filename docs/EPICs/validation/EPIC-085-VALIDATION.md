# EPIC-085 — Audit Events · Validation Evidence

**Assessed against:** working tree on top of `f2d968b`
**Date:** 2026-09-02
**Environment:** real filesystem journals; the real MCP protocol over an
in-memory transport; the real `ConfigStore`.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 one parseable NDJSON line | **MET** | `tests/unit/audit-events.test.ts` "appends one parseable NDJSON line" |
| AC-2 appends in order | **MET** | "appends in order without truncating" |
| AC-3 category, action, outcome, actor, invocation, instant | **MET** | "carries the fields that identify the event" |
| AC-4 a denial names the missing permission | **MET** | "records a denial with the operation and the missing permission" |
| AC-5 a permitted decision is recorded | **MET** | unit, and `tools.test.ts` "records a permitted decision durably" through the real protocol |
| AC-6 a confirmation records whether a token was presented | **MET** | "records a confirmation and a credential path"; the token itself is never written |
| AC-7 a credential resolution records the path | **MET** | same test — `database.password`, never its value |
| AC-8 no protected value | **MET** | unit "writes no secret-shaped value even when one is smuggled into a field"; a type test asserting the event has **no value field at all**; `tools.test.ts` "records no query text" over a real search |
| AC-9 an unwritable journal does not fail the operation | **MET** | "returns the failure instead of throwing" — a file where the parent directory must go, so `mkdirSync` cannot win |
| AC-10 rotates at the bound, keeps the previous | **MET** | "rotates at the size bound and keeps the previous file" |
| AC-11 drops the oldest beyond the kept count | **MET** | `.1` and `.2` present, `.3` absent |
| AC-12 rotation failure does not fail the write | **MET** | "keeps appending when rotation cannot happen" — a directory where the rotated file must go |
| AC-13 config writes both, entry shape untouched | **MET** | "writes its own entry and an event, with the entry shape untouched" |
| AC-14 reading back yields what was written | **MET** | "skips a damaged line rather than failing the whole read" — a partial record must not make the history unreadable |
| AC-15 every source wired | **MET** | authorization decisions and denials (the MCP guard), confirmations (the destructive guard), credential resolution and configuration changes (`ConfigStore`) |

Fifteen of fifteen MET. `npm run verify` green: 134 files, 2860 passed, 3 skipped.

## Decisions worth recording

**NDJSON on disk, not a table.** EPIC-003 put its configuration journal there
"for one reason: configuration has to work *before* there is a database, and the
change most worth auditing is the one that sets the database up." That
generalises exactly — a denial happens in an MCP server composed with only a
`RetrievalPort`, and a credential resolution happens before any connection
exists. An audit trail that needs the database is absent when the database is
the problem. No migration.

**The event has no field for a value**, which is §8.3 expressed as a type rather
than as a rule somebody has to remember; EPIC-091's redactor is the second line
over the assembled record. A test asserts the key set, so a future field that
accepts a value fails the build.

**Rotation is by size and best-effort.** Size rather than age, because the risk
is unbounded growth on a busy install and deleting by age would discard the only
copy of a month-old denial on a quiet one. A journal that cannot be rotated keeps
being appended to — refusing to append because a rename failed would discard the
event to protect a file size.

## Limitations, recorded

- **A configuration change appears in two files.** EPIC-003's journal format is
  already on disk in installs, and its entry shape was written "deliberately
  close to an event so that becoming one of its sources does not require a
  format change". The duplicate line is a cheaper mistake than migrating
  somebody's journal.
- **Retention is EPIC-088's.** This Epic bounds size; how long a copy is kept is
  a policy.
- **No signing or tamper-evidence.** An append-only file a local root can edit is
  not an attestation. Chaining hashes per line would make tampering detectable
  and is the obvious next increment; it has no owner.
- **Reads are not audited**, by design: every search would be an event, which is
  a log rather than an audit trail. Only a denial is recorded, so "who searched
  for what" is unanswerable from this trail.
