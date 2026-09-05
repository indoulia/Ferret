# EPIC-116 — Session export fidelity: validation evidence

**Status: VALIDATED** · four tables moved from declared-excluded to exported. No
schema change and no migration: the constraint EPIC-042 relies on is untouched,
and a test asserts that it still refuses.

## Environment

| | |
| --- | --- |
| Tree | `b2cfb37` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | Real PostgreSQL 17 + pgvector, local container; a **second** database for the restore |
| Date | 2026-09-05 |

## What the Epic does

`ferret export` carries the session domain when it is explicitly in scope. Three
answers, and they are deliberately different from one another: a full export
carries every session; `--session <id...>` carries exactly the sessions named,
with their transcripts, checkpoints and memories; an entity-scoped export carries
none and the manifest states the reason in that document rather than as a
property of the format.

## The decision that shaped it

D-116.1 forbids inferring membership from `session.repository_id`. The test that
matters is the one that would have passed under an inferring implementation and
does not: both fixture sessions carry `repository_id: 'o/scoped'`, an entity of
that name is indexed, and a `--scope` export of it carries **zero** session rows.
An implementation that matched free text against a scope would have carried both
and looked correct.

## Acceptance criteria

Measured runs: `session-export.test.ts` — **10 passed, 1 182 ms**;
`export-cli.test.ts` — **11 passed, 22 108 ms** (3 of them this Epic's);
the pre-existing export and import suites re-run unchanged — `export.test.ts`,
`export-fidelity.test.ts`, `backup-contract.test.ts`, `backup-fidelity.test.ts`,
`import.test.ts`, `tests/unit/export.test.ts`, `tests/unit/import.test.ts`.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 a full export carries every session | PASS | 2 sessions, 2 captures, 2 checkpoints, 2 memories, and the four tables are no longer declared excluded |
| AC-2 an entity-scoped export carries none, and says why | PASS | zero rows for all four tables; each excluded entry's reason contains "not an entity" and its recovery names `--session`. Asserted through the CLI too, where an operator reads it |
| AC-3 a named session travels, and only that one | PASS | `sess-alpha` present, `sess-beta` absent, `sessionScope.resolved` names one |
| AC-4 a named session that is absent is reported | PASS | `unresolved: ['sess-nowhere']`, and the human output reads `1 of 2 named session(s) carried` |
| AC-5 either identifier resolves | PASS | the canonical id resolves to the same `session_id`, with nothing unresolved |
| AC-6 the transcript travels with its content hash | PASS | both turns present verbatim; every `content_hash` is a 64-character digest |
| AC-7 no gap when the evidence travelled | PASS | `memoryEvidenceGaps: []` — the positive claim that the check ran |
| AC-8 a memory citing an absent capture is reported | PASS | one gap, naming the session and the count. Constructed by direct insert, because no path in Ferret produces one: the constraint is satisfied and the id names nothing, which is precisely what the constraint cannot see |
| AC-9 the constraint is not weakened | PASS | an `extracted` memory with an empty `derived_from` is refused by `engineering_memory_extracted_has_evidence`, asserted against the database rather than the domain |
| AC-10 the document restores elsewhere | PASS | imported into a second database that never saw the session; read back through `SessionStore` — the session, its turn, its checkpoint and its memory, and the memory's `derivedFrom[0].captureId` equals the restored capture's id |

## What AC-10 actually measures

The restore is read back through the **domain**, not through SQL. "Rows landed"
and "a session was restored" are different claims, and only the second is what
D-116.2 asked for. The last assertion is the one that makes D-116.3 true rather
than merely stated: the memory's cited capture id equals the id of the capture
that arrived with it, in an installation that has never seen the original.

## Dogfooded — 2026-09-05

`ferret export --session <id>` was run against the dogfood installation, on a
session created through the CLI. The document carried the session, its checkpoint
and its memory; `sessionScope` reported one requested, one resolved, none
unresolved; and `memoryEvidenceGaps` was `[]`.

**It also carried the whole index** — 4 006 entities, 14 144 evidence rows,
38 865 lines. That is the design working as specified: `--session` narrows the
*session* dimension and says nothing about entities, and their independence is
what stops an entity scope being read as a claim about which sessions belong to
it (D-116.1's whole point).

What was wrong was the **wording**. The README's example was named
`one-session.ndjson` and the option's help said nothing about the entity
dimension, so both promised a session-only document. Corrected: the example is
renamed, the help text says it narrows one dimension, and the README shows the
`--scope --session` pair that narrows both.

Deliberately not changed: there is no way to export sessions with *no* entities.
A memory cites evidence, and a document carrying the claims without the graph
they refer to would restore into something that cannot answer why.

## Known limitations

- A transcript is exported as it is stored. EPIC-112's limitation travels with
  the document; the credential scanner reports what it recognises and `--strict`
  refuses, as for every other table.
- `memoryEvidenceGaps` describes the export's own session scope. A gap in a
  session that did not travel is not reported, because it is not in the document.
- Nothing writes a capture yet — EPIC-112 recorded that the capture path belongs
  to the client adapters. What is guaranteed here is that a transcript, once
  written, travels.

## Governance alignment

§6 — three distinct answers where there was one silence, and "carried none" is
never spelled the same way as "there are none". §12 — a capture is untrusted text
and is carried verbatim rather than interpreted. EPIC-042's invariant is asserted
rather than assumed, in the direction that would have been convenient to relax.
