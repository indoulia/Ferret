# EPIC-049 — Relationship Storage

**Status: IMPLEMENTED | Priority: P0 | Domain: Knowledge Graph & Relationships**

> **Specification note.** The registry approved this Epic by name, domain and
> priority; no specification was ever written. This document supplies one.
>
> **EPIC-049 is an audit**, for the same reason EPIC-044 was. Its implementation
> was built as the storage half of EPIC-007 and has never been assessed against
> its own acceptance criteria. Governance §9 forbids reporting an Epic complete
> on the strength of "there is code in that file"; this states the criteria and
> the validation document records the result.
>
> Where the audit finds a requirement already met, **nothing is rewritten to
> claim credit** — Governance §7. An audit that produces a large diff has
> misunderstood its job.

## 1. Objective

Store relationships durably and answer them back — by endpoint, by type, and at a
point in time — without duplicating, losing or reordering what was observed.

## 2. Value

EPIC-007 modelled relationships and EPIC-002's storage layer persisted them, so
this capability substantially exists: `RelationshipStore` is 506 lines covering
assertion, retirement, temporal intervals and traversal, exercised by 28
integration tests against a real PostgreSQL.

What has never happened is checking it against the criteria the registry
approved. EPIC-007's own validation lists five limitations and assigns them to
EPIC-050, EPIC-008, EPIC-046 and EPIC-105 — **none to EPIC-049**, which is a
strong prior that the audit will find little, and not a substitute for running
it.

## 3. Scope

- Assess the existing store against the acceptance criteria below.
- Record the result, including anything not met, as validation evidence.
- Fix only what the audit finds missing.

## 4. Non-scope

- **Traversal beyond one hop, depth limits and cycle protection** — EPIC-050.
  EPIC-007's validation already assigns these there, and taking them here would
  be this Epic claiming another's scope.
- **Cross-source entity resolution** — EPIC-051.
- **Evidence behind a relationship** — EPIC-008. A relationship records which
  system asserted it, not what supports it.
- **Confidence on an inferred relationship** — EPIC-046.
- **Permission-scoped relationship reads** — EPIC-058. The table has no
  `permission_scope` and this Epic does not add one.
- **Rewriting the store.** The audit fixes gaps, not style.
- **A new table, column or migration.**

## 5. Inputs

- EPIC-007's relationship and temporal model, and its validation evidence;
- EPIC-002's storage layer and migration `0003`;
- the existing `RelationshipStore` and its 28 integration tests.

## 6. Outputs

- Validation evidence mapping each criterion to its demonstration;
- fixes for anything the audit finds missing.

## 7. Dependencies

EPIC-002, EPIC-006, EPIC-007 — all VALIDATED.

## 8. Contracts

Unchanged. This Epic asserts no new contract; it checks the one EPIC-007
established still holds and is honestly evidenced.

## 9. Acceptance criteria

- **AC-1** A relationship is stored with its endpoints, type, source and validity
  interval, and reads back identically.
- **AC-2** Re-asserting the same observation does not add a row.
- **AC-3** An assertion whose metadata changed updates in place rather than
  inserting.
- **AC-4** A relationship to an entity that does not exist is refused, not
  stored dangling.
- **AC-5** Superseding an exclusive relationship closes the previous interval and
  opens one, in a single transaction.
- **AC-6** A closed interval is kept, so history stays answerable.
- **AC-7** A query at a past instant returns what was true then, and exactly one
  answer at a handover instant.
- **AC-8** An older observation arriving late does not overwrite newer knowledge,
  and can be inserted between two known intervals without overlapping either.
- **AC-9** Retirement closes an interval rather than deleting a row, and refuses
  to retire before the relationship began.
- **AC-10** Lookup by endpoint and by type uses an index rather than a sequential
  scan.
- **AC-11** Entities from different providers can be connected.
- **AC-12** Concurrent writers of one exclusive type leave exactly one open
  relationship.
- **AC-13** Removing an endpoint entity leaves no dangling edge.

## 10. Test requirements

The audit is satisfied by evidence, not by new tests for their own sake. Where an
existing integration test against a real PostgreSQL demonstrates a criterion,
that is the evidence; a duplicate test asserting the same thing adds nothing and
is not written.

## 11. Security requirements

None beyond EPIC-007's. Relationship metadata is source-derived and is subject to
the same containment as any other indexed content when it reaches a client.

## 12. Observability

`AssertOutcome` distinguishes `opened`, `updated`, `unchanged` and `stale`, so a
caller can report what a write did rather than that it happened.

## 13. Performance constraints

The existing budgets stand: assertion and one-hop traversal each within their
recorded p95, measured against a real PostgreSQL.

## 14. Definition of Done

Validation evidence demonstrates every applicable criterion, and anything not met
is recorded as a limitation with an owner rather than absorbed.

## 15. Governance alignment

- **§7 Smallest correct change** — an audit that finds a requirement met changes
  nothing.
- **§9 No fake completion** — the reason this Epic exists as an audit rather than
  being marked done on the strength of existing code.
- **§15 Data integrity** — idempotence, ordering and interval integrity are the
  criteria above, not aspirations.
