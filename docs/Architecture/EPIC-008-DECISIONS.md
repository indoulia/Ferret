# EPIC-008 — Architecture Decisions

Decisions taken while implementing the Evidence & Provenance Model, with the
alternatives considered and the reason for selection (Governance §22, AI
Development Rule §19).

---

## D-001 — Content is immutable; interpretation is not

**Decision.** An evidence row's observation half is written once and never
updated. `state`, `superseded_by` and `last_checked_at` may change. The
integrity hash covers only the immutable half.

**Alternatives.** Make the whole row immutable, and represent supersession as a
separate table; make the whole row mutable and rely on discipline.

**Reason.** Governance §6 forbids silently rewriting source evidence, and a store
that *can* update an observation cannot promise it — discipline is not a
mechanism. But Ferret's opinion about an observation genuinely does change: it
learns something newer, or finds the source gone. Those are facts about Ferret,
not about the source.

Excluding state from the hash is what makes the split work. If supersession broke
the hash, integrity checking would fail exactly where history matters most —
on the old records — and would quickly be switched off.

---

## D-002 — A derived fact must name what it was derived from

**Decision.** `inferred`, `generated` and `aggregated` records are rejected
unless `derivedFrom` is non-empty. A foreign key then refuses a citation of
evidence that does not exist.

**Reason.** AC-1 requires derived facts to have evidence references, and a
conclusion that cites nothing cannot be traced — which is the entire purpose of
recording derivation. Enforcing it at creation means an untraceable conclusion is
unrepresentable rather than merely discouraged.

The foreign key matters as much as the check. A dangling provenance link *looks*
like an explanation and leads nowhere, which is worse than having no chain at
all.

`asserted` is exempt: an operator saying "these two issues are duplicates" is the
origin of that fact, not a conclusion from other facts.

---

## D-003 — `generated` is its own method

**Decision.** Model output is `generated`, and `isDirectObservation` returns
false for it.

**Reason.** Governance §6 draws precisely this line — observed evidence versus
derived or AI-generated knowledge. A model's statement is evidence of *what the
model said*, never of what is true, and a system that stores the two in the same
shape will eventually cite one as the other.

---

## D-004 — Absent confidence is not zero confidence

**Decision.** `confidence` is nullable. Zero means "believed false"; null means
"not assessed".

**Reason.** Governance §6 forbids manufacturing certainty, and defaulting an
unassessed value to any number manufactures it. `completeness` defaults to
`unknown` for the same reason: a parser that extracted three of five sheets has
evidence but not the whole answer, and treating it as complete makes a retrieval
confidently omit things.

---

## D-005 — Identity covers the producer and its version

**Decision.** Evidence identity is derived from what was observed, where it came
from, **and what produced it at which version**.

**Reason.** Two halves, both needed. Deduplication: re-indexing an unchanged file
must not multiply its evidence. Reproducibility (Governance §21): a parser
upgrade can legitimately change what was extracted, so the same fact from
`pdf@6.3.289` and from `pdf@7.0.0` are genuinely different observations.

Keeping them separate is what makes "re-extract everything the old parser
touched" answerable — a query on `(producer, producer_version)`, which is
indexed.

---

## D-006 — Provenance is a join table, walked in both directions

**Decision.** `evidence_derivation(evidence_id, source_evidence_id)`, indexed on
both columns.

**Alternatives.** An array column on the evidence row.

**Reason.** The chain is traversed both ways, and only one of those is obvious.
Backwards — "why does Ferret believe this" — is what EPIC-048 turns into a
user-facing explanation. Forwards — "what did this observation go on to support"
— is what a re-extraction needs when a parser version is found to be wrong: every
downstream conclusion has to be located and redone. An array column makes the
second a table scan.

Both traversals are depth-limited rather than trusting the data to be acyclic. A
cycle should not be constructible, and a query that hangs when one appears is not
a defence.

---

## D-007 — Conflicts are detected, never resolved here

**Decision.** `detectConflicts` groups current records that disagree about the
same `(subject, field)`. `preferredEvidence` ranks by authority, then confidence,
then recency — and returns `undefined` when nothing distinguishes the candidates.

**Reason.** Governance §15 forbids silently discarding conflicting evidence, so
detection cannot be allowed to become deletion. EPIC-045 owns which source wins
and EPIC-047 acts on it; reporting the disagreement is the honest answer when no
authority rule applies.

Returning `undefined` rather than picking arbitrarily is the important part. By
the time an arbitrary pick reaches an answer it is indistinguishable from a
considered one, and the user has no way to know which they got.

---

## D-008 — Secrets are masked, not dropped

**Decision.** Evidence content passes through Ferret's existing redaction before
it is hashed or stored, and the record notes that masking occurred.

**Alternatives.** Refuse to store content containing a secret; store it and rely
on access control.

**Reason.** EPIC-008's security requirement is that credentials are never stored
*merely because they were encountered* — and Ferret indexes configuration files,
environment dumps and logs, so it will encounter them.

Dropping the fact loses information that matters: "a database password is
configured at line 42 of this file" is useful, and is exactly what a security
review would want. Storing the value is what must not happen. Masking keeps the
first and prevents the second.

Reusing the existing redaction rather than writing a second one means evidence is
protected by the same rules as logs, errors and configuration output — and means
a gap found in one is fixed for all of them, which is what happened here (D-010).

---

## D-009 — Permission scope travels with the evidence

**Decision.** Each record carries an optional `permissionScope`, and reads take
the scopes the caller holds. Unscoped evidence is visible to all; scoped evidence
only to a holder.

**Reason.** Governance §12 requires authorization to be evaluated *before*
protected information enters retrieval results. Attaching the scope to the
evidence, and filtering in the query, means protected content never reaches an
answer to be filtered out of later — which is the version that leaks when
someone forgets a step.

Omitting the filter means unrestricted, which is right for internal callers and
wrong for a query on a user's behalf. EPIC-058 makes it mandatory on the
retrieval path; EPIC-008 provides the mechanism.

---

## D-010 — A redaction gap found by an evidence test, fixed for everything

**Decision.** `KEYVALUE_SECRET` now allows a `[A-Za-z0-9_]*` prefix before the
secret name.

**Reason.** An evidence test expected `DATABASE_PASSWORD=hunter2` to be masked
and got the real value. The pattern was anchored on `\b(password|…)`, and `\b`
does not match after an underscore — so `DATABASE_PASSWORD=`, `PG_PASSWORD=`,
`GITHUB_TOKEN=` and `FERRET_DATABASE_PASSWORD=` all passed through unredacted.

Those are the shapes secrets take in the environment Ferret runs in. Because logs,
errors and configuration output all redact through the same function, the gap was
never specific to evidence.

The alternation must still be followed immediately by `=`, so `MY_TOKENIZER=lexer`
and `keyword=search` are untouched. Six regression cases cover the fix.

---

## D-011 — The locator is deliberately open

**Decision.** `{ kind, start?, end?, detail? }`, where `kind` names the coordinate
system: `line`, `page`, `cell`, `byte`, `path`.

**Alternatives.** A closed union of typed locators.

**Reason.** Governance §6 asks for source *location* wherever applicable, and the
formats Ferret will index locate things incompatibly — a line range, a PDF page,
a spreadsheet cell with a sheet name, a JSON pointer, a byte offset. A shape that
fitted all of them would fit none of them well, and a closed union would need
widening for every new parser, which is the coupling EPIC-006 AC-4 exists to
prevent.
