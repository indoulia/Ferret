# EPIC-046 — Confidence & Completeness

**Status: APPROVED | Priority: P1 | Domain: Evidence & Provenance**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Evidence & Provenance, where
> it has been named and prioritised since the registry was written; only the
> specification is new.

## 1. Objective

Make `confidence` and `completeness` mean something: set from what actually
happened, propagated through a derivation chain, and left unassessed wherever
nothing determines them.

## 2. Value — the same shape EPIC-045 found, twice over

Ten records across nine Epics point here, and every one describes a field that
is stored, read, and never written:

- **EPIC-008's validation** — "Confidence is stored but never computed. A
  provider must supply it, and most will not."
- **EPIC-007's validation** — "No confidence on inferred relationships. A
  `commit_resolves_issue` parsed from a commit message is stored with the same
  standing as one from an API."
- **EPIC-009's validation** — "Confidence on an alias is stored but never
  computed."
- **EPIC-048 §4, EPIC-049 §4, EPIC-056 §4, EPIC-057 §4, EPIC-060 §4,
  EPIC-062 §4, EPIC-063 §4** — each reads the field and each names this Epic for
  producing it.

This is precisely the shape EPIC-045 found: `authority` was on every record,
`preferredEvidence` ranked by it first, and nothing set it, so the comparison
never discriminated. Confidence is one step worse — it is the *tiebreak* under
authority in two orderings (`preferredEvidence` and EPIC-062's `compare`), so
today both fall straight through it to recency.

`completeness` is the same story with a different ending: it defaults to
`unknown` on every record ever written, and the signals that would set it are
already computed and thrown away — `OMITTED_REASONS` when a content read could
not take the text, and the `complete` flag on the tree and branch enumerations
that EPIC-032 AC-7 depends on.

## 3. Scope

- **A named confidence scale**, shared with the two producers that already
  compute one, so there is one vocabulary rather than three tables of numbers.
- **Propagation through a derivation chain**: a conclusion is no more certain
  than what it rests on.
- **`completeness` set from what the read did**, from signals already recorded.
- **Application at emission**, at the seam EPIC-045 used, so no call site invents
  a number.
- **An explicit unassessed**, distinct from zero, preserved everywhere.

## 4. Non-scope

- **Deriving confidence from `method`.** §8.1 is why: this is the central
  decision of the Epic, not an omission.
- **Changing EPIC-009's or EPIC-042's numbers.** Both were argued in their own
  Epics and validated. This Epic names the scale they are already on and leaves
  every value where it is.
- **Calibrating against measured accuracy.** EPIC-097 measures parse quality per
  language, and feeding that back into a per-record confidence needs a loop no
  registry entry owns. §16 raises it.
- **Resolving conflicts — EPIC-047.** A low-confidence record that disagrees is
  still a conflict, not a resolved one.
- **Ranking — EPIC-056/057.** They read confidence as a tiebreak; making it
  discriminate is this Epic's job, weighing it is theirs.
- **Confidence on an entity or a relationship row.** EPIC-007's gap is about the
  *evidence* for an inferred relationship, which is where the field lives;
  adding a column to another table would be a schema change §4 declines.
- **A new table, column or migration.** EPIC-008's schema is sufficient.

## 5. Inputs

- The rule or origin a producer used, where it has one.
- `derivedFrom` — the chain EPIC-008 already records.
- `OMITTED_REASONS` from a content read; the `complete` flag from an enumeration.
- `RULE_CONFIDENCE` (EPIC-009) and `ORIGIN_CONFIDENCE` (EPIC-042), unchanged.

## 6. Outputs

- `src/domain/confidence.ts` — the scale, `derivedConfidence`,
  `completenessOf`, `isUnassessedConfidence`.
- `completeness` and propagated `confidence` set at emission.
- No schema change.

## 7. Dependencies

EPIC-008 (the fields and the chain), EPIC-009 and EPIC-042 (the two existing
tables), EPIC-045 (the emission seam and the precedent), EPIC-087 (the omission
reasons), EPIC-032 (the enumeration completeness flag).

## 8. Contracts

### 8.1 Confidence is not derived from `method`

The obvious implementation is a table keyed on `EvidenceMethod`, mirroring
`AUTHORITY_BY_METHOD`. It is wrong, and it is worth saying why in the
specification rather than discovering it in review.

**Authority already encodes method.** EPIC-045's whole table is
method → rank. A confidence keyed on the same input, expressed on a different
scale, says the same thing twice — and `domain/authority.ts` already records
what a number like that becomes: "a continuous score invites tuning, and a tuned
authority number is indistinguishable from a fudge by the time it reaches an
answer." Two orderings that both consult authority *and then* a decimal
restatement of authority have one signal and two chances to look rigorous about
it.

So confidence comes from the **specific rule** that produced a statement, never
from its method class. The distinction is already load-bearing in the codebase:
`SAME_ADDRESS` (0.95) and `SAME_NAME_AND_LOCAL_PART` (0.5) are both `inferred`,
and collapsing them to one number for `inferred` would throw away the only thing
EPIC-009 measured.

Where a producer has no rule, confidence stays **unassessed**. Governance §6:
"omitted says not assessed", and inventing 0.7 for an observation nobody
evaluated is manufacturing certainty in the shape of rigour.

### 8.2 One scale, and it is the one already in use

Two tables exist and already agree in shape, each documented as "stated once so
the ordering is one decision":

| band | value | already used by |
| --- | --- | --- |
| `CERTAIN` | 1 | `LinkRule.MAILMAP` — the project's own `.mailmap` |
| `STRONG` | 0.95 | `LinkRule.SAME_ADDRESS`, `MemoryOrigin.EXPLICIT` |
| `PROBABLE` | 0.8 | `LinkRule.GITHUB_NOREPLY_LOGIN` |
| `PLAUSIBLE` | 0.6 | `MemoryOrigin.EXTRACTED` |
| `EVEN` | 0.5 | `LinkRule.SAME_NAME_AND_LOCAL_PART` |

Every value is one a validated Epic already chose. This Epic **names** them and
gives them one home; it changes none of them, because changing one would be
re-deciding EPIC-009 or EPIC-042 from outside. The bands are named so the next
producer picks a meaning rather than a decimal, which is the failure mode a bare
0..1 field invites.

`EVEN` is the floor and is named for what it is: as likely wrong as right.
Nothing below it is offered, because a producer that believes a statement is
probably false should not be emitting it as evidence.

### 8.3 A conclusion is no more certain than what it rests on

`derivedFrom` forms a chain and nothing propagates through it: a record derived
from a 0.5 alias proposal is stored today with no confidence at all, which reads
as "unassessed" when Ferret in fact knows exactly how shaky it is.

```
derivedConfidence(inputs) =
  undefined              if inputs is empty, or any input is unassessed
  min(inputs)            otherwise
```

A chain is as strong as its weakest link, so the minimum — no constant, nothing
to tune. **Any unassessed input makes the conclusion unassessed**, because "no
more certain than the weakest" cannot be evaluated when the weakest is unknown,
and picking the minimum of the known ones would state a bound Ferret cannot
support. That is the Governance §6 answer and it is deliberately the
conservative one.

A caller that supplies its own `confidence` keeps it. Propagation fills a gap;
it does not overrule a producer that has assessed its own output.

### 8.4 `completeness` is set from what the read did

Three values, and each now has a source:

- **`partial`** — the read did not take everything. A content read that returned
  an `omittedReason` (binary, over the size bound, undecodable, secret scan
  failed) read the file and did not keep its text; a bounded enumeration
  (`complete: false`) saw some refs and not all.
- **`complete`** — the read took everything it set out to.
- **`unknown`** — nothing said either way. Unchanged, and still the default, so a
  producer that does not report gets the honest answer rather than a flattering
  one.

The direction matters and matches EPIC-057 §8.1's reasoning: an *absent* signal
leaves `unknown`, never `partial`. Reporting evidence partial because nobody said
otherwise is the failure EPIC-094 recorded — "584 of 585 indexed scopes were
built by a different Ferret" on a healthy index, after which an operator stops
reading the output.

### 8.5 Confidence is never invented at a call site

The seam is `Emitter#evidence`, which is where EPIC-045 applied authority, for
the same reason: one place to look, and a provider cannot raise its own
confidence by writing a larger number in more files. Propagation lives in
`BatchEmitter`, which is the emitter that holds the chain — the base emitter has
ids and not records, and resolving a chain it cannot see would mean guessing.

## 9. Acceptance criteria

- **AC-1** Every band in §8.2 equals the value the producer that already used it
  chose; `RULE_CONFIDENCE` and `ORIGIN_CONFIDENCE` are unchanged in value.
- **AC-2** No confidence is derived from `EvidenceMethod` anywhere.
- **AC-3** A record whose producer supplies no rule carries `confidence`
  `undefined`, not a default.
- **AC-4** `derivedConfidence` returns the minimum of its inputs.
- **AC-5** `derivedConfidence` returns `undefined` when any input is unassessed.
- **AC-6** `derivedConfidence` returns `undefined` for an empty chain.
- **AC-7** A record emitted with `derivedFrom` referencing emitted records
  carries the propagated confidence.
- **AC-8** A record emitted with its own `confidence` keeps it, propagation
  notwithstanding.
- **AC-9** A `derivedFrom` id the emitter has not seen makes the conclusion
  unassessed rather than throwing.
- **AC-10** `completenessOf` maps an omission reason to `partial`, an incomplete
  enumeration to `partial`, and a clean read to `complete`.
- **AC-11** No signal maps to `unknown` except the absence of one.
- **AC-12** `isUnassessedConfidence` distinguishes `undefined` from `0`.
- **AC-13** A confidence of `0` survives round-tripping and is not treated as
  absent.
- **AC-14** `preferredEvidence` and EPIC-062's ordering now discriminate on
  confidence where authority ties — the tiebreak that previously fell through.
- **AC-15** EPIC-009's and EPIC-042's own tests pass unchanged.

## 10. Test requirements

**Unit** — every band against the producer that chose it; `derivedConfidence`
over the minimum, the unassessed input, the empty chain, and a single input;
`completenessOf` for each omission reason and each enumeration state;
`isUnassessedConfidence` against `0` and `undefined`; the two orderings
discriminating where they previously fell through.

**Integration** — a batch emission with a real chain, asserting the propagated
value on the conclusion and the unchanged value on a producer-supplied record.

**Failure** — a chain referencing an unknown id; a confidence outside 0..1
rejected by the schema as it already is; a chain that references itself.

**Regression** — EPIC-009's, EPIC-042's, EPIC-045's and EPIC-062's suites
unchanged.

## 11. Security requirements

None new. Confidence and completeness are Ferret's own assessments of its own
reads; neither carries source text, and no value here crosses a permission
boundary. A provider cannot raise its own confidence except through a rule this
Epic names (§8.5), which is the same control EPIC-045 put on authority — "a
provider may not promote a guess by declaring itself important."

## 12. Observability

EPIC-062's citation reason already renders `confidence` when present and will now
have something to render. EPIC-063's explanation names it wherever the ordering
used it. No new log line and no new metric.

## 13. Performance constraints

`derivedConfidence` is one pass over a chain that EPIC-008 already bounds.
`completenessOf` is a map lookup. No query, no join.

## 14. Definition of Done

Scope implemented; AC-1 to AC-15 satisfied with evidence in
`validation/EPIC-046-VALIDATION.md`; unit, integration and failure tests present
and passing; `npm run verify` green; the registry updated; the recorded
limitations in EPIC-007's, EPIC-008's and EPIC-009's validation struck with dated
notes rather than edited away.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.1's refusal to invent a number, §8.3's
  refusal to bound by an unknown, §8.4's refusal to call an unreported read
  partial. Three places where the honest answer is the one that says less.
- **§18 Provenance and Explainability** — "explain why evidence was … considered
  authoritative" now has a second dimension that is not a restatement of the
  first.
- **§5 Reuse Before Reinvent** — two existing tables are named, not replaced; the
  emission seam is EPIC-045's; no new storage.
- **§2 Simplicity** — five named bands and one `min`.

## 16. Raised, not absorbed

- **Nothing calibrates these numbers against outcomes.** EPIC-097 measures parse
  quality per language and EPIC-098 measures retrieval; neither feeds back into a
  per-record confidence, and a loop that did would need an owner. The bands are a
  considered starting set, which is the same thing EPIC-045's validation said of
  the authority ranks, recorded rather than hidden.
- **Most evidence will still be unassessed**, and that is the correct outcome of
  §8.1 rather than a shortfall. Git observation has no rule and needs none: what
  a commit contains is not a probabilistic claim. The Epics that will populate
  this field are the inferring ones — EPIC-035, EPIC-047, EPIC-051 — and they are
  unbuilt.
- **EPIC-007's inferred-relationship gap is closed only in part.** The evidence
  for an inferred relationship can now carry a rule's confidence; the
  relationship row still has no confidence column, and adding one is a schema
  change this Epic declines. A consumer reads the evidence.

## 17. Recorded during implementation

- **Propagation happens on the input, not the record.** A record's id and
  integrity hash are derived from its fields, so setting confidence on a
  constructed record would produce one whose id no longer matched its content.
  §8.5's seam is therefore before `createEvidence`, and a unit test rebuilds a
  propagated record to assert both hashes match.
- **`completeness` has the function and not yet a producer.** Every signal the
  codebase records is mapped and tested; threading one into an evidence emission
  is a change to the content store's and the indexer's call sites rather than to
  this seam. Recorded in the validation document as the honest state.
