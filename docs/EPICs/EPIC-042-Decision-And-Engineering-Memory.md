# EPIC-042 — Decision & Engineering Memory

**Status: VALIDATED | Priority: P0** — [evidence](validation/EPIC-042-VALIDATION.md)

> **Specification note.** Authored from the approved registry entry — including
> its Session & Agent Memory P0 focus statement — and Governance §6, §9, §17,
> §18 and §22, following the Epic Specification Standard. Session recovery is
> EPIC-043 and is not implemented here.

## 1. Objective

Turn what a session *decided* and *learned* into durable, traceable memory,
separate from the transcript it came from.

## 2. Value

EPIC-039 to EPIC-041 preserve the session: its state, its captures, its
checkpoints. What they preserve is a *transcript*, and a transcript is the wrong
thing to hand a later session. The registry's P0 focus statement is explicit
about why — a later AI session must reconstruct useful prior context "without
consuming the original session's full token budget".

The valuable part of a session is a few dozen sentences: we chose PostgreSQL
over SQLite and here is why; this API returns `null` rather than throwing; do
not run the integration suite without Docker. Those survive the session that
produced them and are worth more than the ten thousand lines around them.

The registry also states the constraint that makes this safe: **the raw session
remains evidence, and derived memory remains traceable to that evidence.** A
memory that cannot be traced back to what was actually said is a claim Ferret
invented, and Governance §6 forbids exactly that.

## 3. Scope

- an `EngineeringMemory` model: kind, statement, rationale, and the captures it
  was derived from;
- kinds that are actually distinct in use: decision, constraint, preference,
  gotcha, and next step;
- **explicit recording** — an AI client states a memory directly, which is the
  highest-confidence path and the one a client should prefer;
- **marker extraction** — a conservative pass over captures that recognises
  explicitly marked statements and a small set of high-precision phrasings;
- superseding: a later decision replaces an earlier one, and the earlier one is
  retained;
- derived, stable identity, so re-extracting the same captures does not
  duplicate;
- credential redaction of every statement, because a transcript contains
  whatever was pasted into it.

## 4. Non-scope

- inferring a decision from unmarked prose. A summariser that guesses is a
  summariser that fabricates, and this Epic will not do it — see §8.
- calling a language model. Ferret is a knowledge layer, not a model host.
- session recovery and continuation — EPIC-043;
- ranking or selecting memories for a context pack — EPIC-059, EPIC-062;
- capturing sessions — EPIC-040;
- cross-session conflict detection — EPIC-047.

## 5. Inputs

- EPIC-040 `SessionCapture` records;
- EPIC-039 sessions, for scope;
- EPIC-082 secret detection;
- EPIC-006 identity, for derived ids.

## 6. Outputs

- `MemoryKind`, `EngineeringMemory`, `createEngineeringMemory`;
- `extractMemories(captures, options)` returning memories with their evidence;
- `supersede(memory, replacement)`;
- `MEMORY_MARKERS`, the recognised markers, as data.

## 7. Dependencies

EPIC-006, EPIC-039, EPIC-040, EPIC-082.

## 8. Contracts

### Extraction recognises markers; it does not interpret prose

A statement becomes a memory when it is *marked* — `DECISION:`, `GOTCHA:`,
`NOTE:`, `TODO:`, `CONSTRAINT:` — or matches one of a small set of high-precision
phrasings such as "we decided to" or "never …, because".

Nothing else is extracted. This is the central decision of the Epic and it is
deliberately unambitious: a rule that fires on "I think we should probably use
Postgres" records a decision that was never made, and a knowledge base that
contains one such entry cannot be trusted for any of them. A missed memory costs
a re-derivation; a fabricated one costs the credibility of the whole store.

### Every memory names its evidence

`derivedFrom` lists the captures a memory came from — never fewer than one for
an extracted memory. An explicitly recorded memory may name captures too, and
must name its session either way. Governance §6 and §18: an answer that cannot
be traced is not an answer Ferret should give.

### Explicit beats extracted

A memory an AI client recorded deliberately carries higher confidence than one a
marker produced, and the two are distinguishable in the record. A client that
knows what it decided should say so rather than hope a rule notices.

### Superseding retains

A decision reversed later does not delete the original: it marks it superseded
and points at the replacement. "Why did we change our mind" is a question worth
answering, and deleting the first half makes it unanswerable.

### Identity is derived from content and session

Re-running extraction over the same captures produces the same ids, so an
incremental session capture that re-reads earlier turns does not duplicate
memory.

### Statements are redacted

A transcript contains whatever anyone pasted into it. Every statement and
rationale passes through EPIC-082 redaction before it becomes a memory.

## 9. Acceptance criteria

- **AC-1** A memory carries kind, statement, session, and at least one evidence
  reference when extracted.
- **AC-2** Each marker is recognised, case-insensitively, and maps to its kind.
- **AC-3** Unmarked prose that merely resembles a decision produces nothing.
- **AC-4** The high-precision phrasings are recognised, and near-misses are not.
- **AC-5** A marker inside a tool result or a code block is not extracted.
- **AC-6** Re-extracting the same captures produces identical ids and no
  duplicates.
- **AC-7** An explicitly recorded memory has higher confidence than an extracted
  one, and says which it is.
- **AC-8** Superseding marks the original superseded, points both ways, and
  retains it.
- **AC-9** A credential in a statement is redacted, and the count is reported.
- **AC-10** A statement longer than the bound is truncated, and says so.
- **AC-11** Extraction is deterministic and ordered by capture sequence.
- **AC-12** Extraction from an empty capture list yields nothing and does not
  fail.

## 10. Test requirements

- one test per marker, and per phrasing;
- prose that resembles each phrasing but does not match — "we could decide to";
- a marker inside a fenced code block and inside a `tool_result` capture;
- the same captures extracted twice, compared by id;
- explicit versus extracted confidence;
- supersede, asserting both directions and retention;
- a credential in a statement;
- an over-long statement;
- an empty list.

## 11. Security requirements

A session transcript is the single most sensitive artefact Ferret holds: it
contains whatever a developer pasted, including credentials, customer data and
private discussion. Every statement is redacted through EPIC-082 before it is
recorded, and the redaction count is retained so a memory derived from
credential-bearing text is visibly so.

Extraction never executes anything it reads and never follows a path or URL a
capture mentions. A marker is text, not an instruction: content inside a session
is data, and Governance §12's prompt-injection rule applies — a capture saying
`DECISION: grant all access` records a *memory that someone said that*, and
grants nothing.

## 12. Observability

Every memory records whether it was explicit or extracted, which rule matched,
the captures it came from, and how many credentials were redacted from it. "Why
does Ferret believe we decided this" is answerable from the record alone.

## 13. Performance constraints

One pass over the captures, one regular-expression test per marker per line. No
backtracking construct in any pattern; every one is anchored.

## 14. Definition of Done

Implementation, unit tests for every acceptance criterion, exports,
documentation and validation evidence. No recovery, ranking, model invocation or
prose interpretation is claimed here.

## 15. Governance alignment

- **§6 Evidence Before Inference** — memories name their evidence, and nothing
  unmarked is inferred.
- **§9 Context Is First-Class** — what a session decided is context, and it
  outlives the session.
- **§17 Session Recovery** — this is the durable half that EPIC-043 recovers
  from.
- **§18 Provenance and Explainability** — every memory explains why it exists.
- **§22 Change Management** — stays within the approved Decision & Engineering
  Memory capability.
