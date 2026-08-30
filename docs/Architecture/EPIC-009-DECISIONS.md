# EPIC-009 — Architecture Decisions

Decisions taken while implementing the Identity & Scope Model, with the
alternatives considered and the reason for selection (Governance §22, AI
Development Rule §19).

---

## D-001 — Actor aliases are a separate table from `entity_external_id`

**Decision.** `ferret.identity_alias` holds identities for developers and agents.
`entity_external_id` (EPIC-006) keeps mapping any entity to identifiers other
systems use for it.

**Alternatives.** Extend `entity_external_id` with temporal columns, evidence and
confidence; use it as-is.

**Reason.** The distinction is real rather than organisational: **an actor's
identity is contested and evolves; a commit's node id does not.**

"These two email addresses are the same person" is a judgement. It can be wrong,
it can be contested by another provider, and it can stop being true when an
address is reassigned. So it needs evidence, confidence, temporal validity and
collision detection. A commit's GitHub node id needs none of those — it is a
fact, and EPIC-006 correctly replaces those mappings wholesale on re-ingestion,
which would *destroy* the history AC-6 requires.

Extending the shared table would have imposed reconciliation machinery on every
mapping that does not need it, and would have made EPIC-006's
delete-then-insert unsafe.

---

## D-002 — Collisions are reported, never resolved

**Decision.** `link` returns a structured `collision` and writes nothing. Merging
two actors is a separate call that requires evidence.

**Reason.** AC-5 says detected rather than *silently merged*, and the failure it
guards against is specific: two people who once shared a shell account or a
build machine become one contributor, permanently and invisibly, and every
answer about authorship is quietly wrong from then on.

Making the merge a separate, evidence-bearing call means the judgement is
deliberate and recorded, rather than a side effect of ingestion that nobody
chose.

---

## D-003 — Developers and agents never merge

**Decision.** The developer/agent boundary is enforced at alias creation, at
merge, and by a check that the claimed class matches the entity it names.

**Reason.** AC-1 makes them distinct identity classes, and the reason is
practical rather than taxonomic. "Who wrote this code" and "which agent touched
this file" are different questions, and merging the two answers the first with a
bot.

Three enforcement points rather than one because there are three ways in: a
caller can claim the wrong class, point at the wrong entity, or ask to merge
across the boundary. Each would produce a record that contradicts itself, and a
self-contradicting record surfaces much later as a wrong answer about who did
something.

---

## D-004 — Alias identity includes the interval start

**Decision.** An alias id derives from `(system, externalId, actorId, validFrom)`.

**Reason.** The same reasoning as EPIC-007 D-004. A mapping can be true, then
wrong, then true again — an address reassigned within an organisation, a bot
account handed to a different service. Identity without time collapses those and
loses the history AC-6 requires.

`unlink` closes the interval rather than deleting the row, and `merge` closes the
old mapping and opens a new one rather than repointing the existing row. Both
follow from the same rule: attribution of an old commit must not follow a later
reassignment.

---

## D-005 — Reconciliation takes a transaction-scoped advisory lock

**Decision.** `pg_advisory_xact_lock(hash(system, externalId))` before the read
inside `link`.

**Reason.** "Concurrent reconciliation" is an explicit EPIC-009 test requirement,
and the read-decide-write shape here is exactly the one that produced write skew
in EPIC-007 D-007. Without the lock, twelve concurrent claims on one identity
would each read a snapshot with no current mapping and all twelve would insert.

Keyed on the identity, not globally, so reconciling different people does not
queue — a test asserts four parallel links finish within five seconds.

The partial unique index is a **backstop**, not the mechanism. A judgement call
is a poor thing to learn about from a constraint violation, but a code path that
forgets to check must still be unable to corrupt the mapping.

---

## D-006 — Scope dimensions are evaluated independently

**Decision.** Repository, worktree and session are separate dimensions,
evaluated separately and then combined.

**Alternatives.** One ordered list of rules, first match wins.

**Reason.** AC-4 requires repository and session scopes to be includable and
excludable *independently*. "Everything in repository A, except during session S"
is a coherent instruction, and an ordered single list could only express it by
accident of ordering — which means the same intent would behave differently
depending on how the rules happened to be written down.

Worktree is its own dimension for the reason Governance §9 gives: a rule about
one checkout must not become a rule about every checkout of the same repository.

---

## D-007 — Exclusion wins, and cannot be widened

**Decision.** Exclusion is checked first and wins outright. `mergeSelectors`
unions inclusions but accumulates exclusions, so no layer can widen what a
narrower one refused.

**Reason.** Exclusion is the direction that protects, and a rule a broader
inclusion could override would not be a protection. The same one-way rule as
EPIC-003's indexing exclusions, and for the same reason.

An empty `include` means "everything", which is the safe default *for a filter*:
a caller who forgets to configure inclusion sees what they are otherwise
entitled to, rather than silently seeing nothing and concluding the index is
empty. That failure mode is much harder to notice than seeing too much.

---

## D-008 — Absent is not a wildcard

**Decision.** A rule about a dimension the context does not have does not match.

**Reason.** A context with no session is not "in" a session, so a session
exclusion must not exclude it. The alternative — treating absence as matching
everything — would make a rule about sessions silently exclude every
repository-level item that had no session attached, which is both surprising and
undetectable without a test.

`constrains()` exists for the same reason: "this selector says nothing about
sessions" and "this selector excludes every session" are different answers, and a
caller that cannot distinguish them will eventually act on the wrong one.

---

## D-009 — The merge relationship is recorded outside the transaction

**Decision.** `merge` writes the alias moves and the supersession inside one
transaction, and asserts the `entity_supersedes_entity` relationship afterwards.

**Reason.** The relationship is a *description* of what happened, not part of
making it happen. Including it would let a relationship failure roll back a
completed identity merge, which is the wrong trade: an unrecorded-but-correct
merge is recoverable, a half-applied one is not.

The consequence — a merge whose relationship is missing — is visible and
repairable, and the alias history in the table is the authoritative record
either way.
