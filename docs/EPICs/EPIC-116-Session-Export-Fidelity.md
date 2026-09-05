# EPIC-116 — Session Export Fidelity

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Storage & Data Lifecycle · Session & Agent Memory
**Classification:** CONTINUATION

## Outcome

`ferret export` carries sessions — the session, its transcript, its checkpoints
and what it decided — when they are explicitly in scope, and says so when they
are not.

## Problem

EPIC-109 declared all four session tables **excluded** from `ferret export` and
stated the loss in the manifest. That was the right answer to an undecided
question, not an answer to it: a scoped export narrows **by entity id**, and a
session is not an entity — `session.repository_id` is free text precisely so a
session can be recorded outside any repository Ferret has indexed (EPIC-039
AC-3). There was no predicate for "the sessions in this scope" that did not
first decide what one meant.

The cost was stated plainly in the exclusion's own recovery note: session
context did not survive `ferret export` and `ferret import`, and `pg_dump` was
the only way to move it.

## Decisions this Epic implements

Taken by the owner on 2026-09-05 against the
[decision queue](ROADMAP.md#epic-116--session-export-fidelity).

**D-116.1 — a session travels only when it is explicitly in scope.** Membership
is never inferred from `repository_id`. The repository already has the more
precise representation the decision asks for: EPIC-009's `ScopeKind.SESSION`,
which names a session rather than matching one. At the command boundary that is
`--session <id...>`.

**D-116.2 — the transcript belongs in the document.** Captures travel with their
session, with `content_hash` and `captured_at` beside the content, so a reader
elsewhere can check the turn it is quoting. The document does not depend on the
installation that wrote it: `sourceInstanceId` is provenance and is never
restored (EPIC-089 D2), and the restore is read back through the domain.

**D-116.3 — memories travel with their evidence, and the constraint is
authoritative.** `engineering_memory_extracted_has_evidence` is untouched. What
the constraint cannot see — whether the captures a memory's `derived_from`
*names* are present — is measured and reported in the trailer as
`memoryEvidenceGaps`. It is never repaired: dropping the memory would lose what
a session decided, and inventing a capture would fabricate evidence.

## Design

**Two scope dimensions, not one overloaded field.** `TableSpec.scopeColumn`
holds an entity id and is narrowed by the entity closure; `TableSpec.sessionColumn`
is the session dimension and is narrowed by named session ids. A table has one
or the other. Folding them together would be D-116.1's forbidden inference
expressed as a type.

**Three answers, and they are different.**

| Export | Sessions carried |
| --- | --- |
| Full (`ferret export`) | Every session, unnarrowed |
| `--session <id...>` | Exactly those, plus their transcripts, checkpoints and memories |
| `--scope <entityId>` | None, and the manifest says why |

**The omission is stated per document.** The four tables leave
`EXPORT_EXCLUSIONS`, because that constant means "no document ever carries
this" and `backup-contract.test.ts` holds it to exactly that. An export that
carries no session appends a computed exclusion instead, naming the reason for
*this* document — F-45's rule applied to a conditional omission.

**Both identifiers resolve.** `ferret session start` prints a `sessionId` and a
canonical id side by side, so `--session` accepts either. What is asked for and
not found is reported as `sessionScope.unresolved` rather than as a smaller
export.

**Import needed no change.** `ImportService` is generic over `EXPORT_TABLES`,
writes in the order that list declares, and reports a foreign-key failure as an
orphaned row. The session tables are ordered `session` → `session_capture` →
`session_checkpoint` → `engineering_memory` so a parent always precedes its
children and a memory always follows the captures it cites.

## Scope

- `TableSpec.sessionColumn`, and the four session tables in `EXPORT_TABLES`.
- `ExportOptions.sessions`, `ExportManifest.sessionScope`,
  `ExportTrailer.memoryEvidenceGaps`.
- `sessionExclusionsFor` and `SESSION_TABLES`; the four static session entries
  removed from `EXPORT_EXCLUSIONS`.
- `ferret export --session <id...>`, and the disclosures both commands print.
- `ImportReport.sessions` and `ImportReport.memoryEvidenceGaps`.

## Non-scope

- **Weakening `engineering_memory_extracted_has_evidence`.** D-116.3 forbids it
  and a test asserts the constraint still refuses.
- **Redacting a transcript on the way out.** EPIC-087 §8.2 settles where
  redaction belongs — before it lands, never on the way out — and EPIC-112
  already redacts a memory at its constructor. A transcript is stored raw and
  is exported raw; the credential scanner reports what it recognises, as it does
  for every other table.
- **Merging a restored session with an existing one.** EPIC-090 §4 excludes the
  merge problem, and a session id collision is reported as `conflicting` exactly
  as any other row is.
- **A selective transcript.** The roadmap's option B — carrying only the cited
  captures — is not implemented, because D-116.2 decided the transcript travels.
  A partial transcript that looked whole is the failure it would have created.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | A full export carries every session, transcript, checkpoint and memory | `session-export.test.ts` — "carries the session, its transcript, its checkpoints and its memories" |
| 2 | An entity-scoped export carries none, and the manifest says why | "does not match a session against a scope by its free-text repository_id"; `export-cli.test.ts` — "says a repository-scoped export carries no session, and why" |
| 3 | A named session travels, and only that one | "carries exactly the session asked for"; CLI — "carries a named session and its memory" |
| 4 | A named session that is not here is reported | "reports a session it was asked for and does not have"; CLI — "says which named session it could not find" |
| 5 | Either identifier resolves | "resolves the canonical id as well as the session id" |
| 6 | The transcript travels with its content hash | "carries the transcript verbatim, so the document does not need this installation" |
| 7 | An extracted memory whose evidence travelled reports no gap | "reports nothing missing when the transcript came too" |
| 8 | A memory citing an absent capture is reported | "reports a memory whose cited capture is not in the document" |
| 9 | The evidence constraint is not weakened | "refuses a memory the constraint rejects, and does not weaken it" |
| 10 | The document restores into an installation that never saw the session | "restores the session, its transcript, its checkpoints and its memories" |

## Tests

10 integration cases in `tests/integration/storage/session-export.test.ts` and
3 CLI cases in `tests/integration/storage/export-cli.test.ts`, all against real
PostgreSQL. The round trip restores into a **second** database, which is what
makes "portable" a measurement rather than a claim.

## Dependencies

EPIC-089 (export), EPIC-090 (import), EPIC-109 (the session store), EPIC-042
(engineering memory), EPIC-009 (scope).

## Known limitations

- **A transcript is exported as it is stored.** EPIC-112's recorded limitation
  — captures are stored raw and only pattern-redacted where a producer redacted
  before writing — travels with the document. The credential scanner reports
  what it recognises and `--strict` refuses, as for every other table.
- **`memoryEvidenceGaps` is computed for the export's session scope.** A gap in
  a session that did not travel is not reported, because it is not in the
  document being described.
- **Nothing writes a capture yet.** EPIC-112 recorded this: the capture path
  belongs to the client adapters that will own it. What this Epic guarantees is
  that a transcript, once written, travels.

## Definition of done

All acceptance criteria implemented and tested against a real server; the
evidence constraint untouched; merged through normal governance.
