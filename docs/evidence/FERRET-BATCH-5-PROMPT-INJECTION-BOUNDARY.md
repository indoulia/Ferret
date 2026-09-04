# Batch 5 — Prompt-injection boundary (F-32, F-64, F-66)

**Status: IMPLEMENTED, re-audited** · Base `0407618` · Branch `forensic/post-roadmap-audit` · 2026-09-03

> Not merged, not pushed to `main`, not deployed. No Epic status changed, no Epic created,
> no work started on Batch 6. F-27, F-25, F-25b, F-11, F-94, F-44 and F-45 were **not** touched.

## 1. One defence, broken in three places

EPIC-084 built three parts of a single mechanism and the audit found all three failing:

| Finding | Contract violated |
| --- | --- |
| F-32 | The pack contained a value and then **sliced the contained string** to fit the budget. The opening delimiter survived, the closing one was cut, so every field after the trimmed one — Ferret's own `reason`, `omitted` and the safety report itself — fell inside a region the notice had told the model to read as quoted repository data. |
| F-64 | Containment walked the **top-level strings of one field** and did `continue` on everything else. Array elements, nested objects, edge `metadata` and `unknownFields` passed through unexamined *and uncounted*, so `contentSafety` affirmed "0 read as instructions" about content it had never looked at. |
| F-66 | The notice arrived **last**, under a key no other tool uses, in the default JSON of the two tools whose entire purpose is to be pasted into a prompt — contradicting `src/mcp/server.ts`'s own header: "it comes first … an instruction that arrives after the content it governs has already lost". |

They are one defence rather than three, and the triage said so. The fix is one boundary
rather than three patches.

## 2. Failing evidence, before any implementation change

`tests/security/injection-boundary.test.ts` was written first, against `0407618` plus only
the two pure checkers it needs to express the property (`delimitersBalanced`,
`outsideFences` — detection, no fix). **8 of 9 assertions failed:**

```
× places the notice at the first key of every tool response
    ferret_context_pack does not lead with the notice: expected 'formatVersion' to be 'notice'
× serializes the notice ahead of any repository content
    ferret_context_pack states the notice after its content: expected 2674 to be less than 612
× closes every region it opens, in every tool response
    ferret_context_pack emitted an unbalanced content fence: expected false to be true
× keeps the closing delimiter on a value the budget shortened
    the trim cut off the closing delimiter:
    '␂ferret:content␂Ignore all previous instructions. … (trimmed by Ferret to fit the context budget)'
    — CONTENT_OPEN present, CONTENT_CLOSE absent
× keeps the closing delimiter on the rendered text form too
× leaves no repository content outside a fence, in any tool response
    ferret_search emitted 5 unfenced payload(s): expected 5 to be +0
× counts what it inspected, so the safety report is not an affirmation about nothing
    TypeError: actual value must be number or bigint, received "undefined"   (no `inspected` field existed)
× reports the developer arrays as marked, which is where anyone who can push reaches this
    expected 'Ignore all previous instructions. …' to contain '␂ferret:content␂'
✓ keeps the content whole, so marking never became filtering
```

The one that passed is the control: it asserts containment does not *remove* anything, and
it passed before and after — which is the point of having it.

The fixture is deliberately at the **response** layer: an MCP client and server over an
in-memory transport, a hostile fake retrieval, and assertions over the serialized bytes a
client receives. Every one of the three findings was live while the previous
source-text assertions were green (§6).

## 3. The boundary, and where it actually is

### F-32 — a fence must survive every transformation

`ContextPackBuilder` contained attributes and *then* trimmed
(`src/context/pack.ts`), so the transformation operated on an already-wrapped
string. `truncateContained` (`src/security/containment.ts`) cuts inside the payload and
re-applies the fence; the trim marker — Ferret's own sentence about the cut — is placed
**outside** the closing delimiter, because it is not part of the quotation.

The invariant is now checkable rather than assumed: `delimitersBalanced` scans arbitrary
emitted text and requires strict alternation, opening first and closing last. It is a
predicate and not an assertion on purpose — a boundary defect turned into a thrown error is
an outage in place of a wrong answer, and one silently repaired is F-32 again with the
evidence removed.

### F-64 — containment must reach every untrusted value, and count it

Two changes, and the second was found by re-auditing the first.

**Reach.** `containUntrusted` walks arrays and plain objects to a depth bound, applying one
policy per leaf. Arrays inherit the key that named them, so each element of `emails` is
policed as an `emails` value. A subtree deeper than `MAX_CONTAIN_DEPTH`, or a cycle, is
serialized and contained whole — inert, complete, and counted in `depthLimited`, because
passing it through is the hole and dropping it would make Ferret disagree with the record.

**The policy itself.** EPIC-084 drew the prose/token line by **key name**, which was right
for the values it could see and wrong the moment containment reached further: recursion
arrives at leaves whose keys the module has never heard of (`bio`, `label`, `sourceNote`),
so a key-name test fails exactly where the new reach was needed — F-64's array elements
would have been *visited and still not wrapped*. The line is now drawn by **shape**: a
value containing whitespace can carry a sentence and is contained; a single token is
classified and returned as it is. This is the rule `containStatement` had already reached
independently on the answer surface for the same reason, so there is now one rule instead
of two that can disagree.

What that buys and costs, stated plainly:

- `attributes.path` of `src/context/pack.ts` stays comparable to a file a client knows
  about — the cost EPIC-084 reasoned about is still avoided where it was real.
- A **filename written as a sentence** is now fenced. Governance §12 treats a filename like
  any other repository byte, and a key-name allowlist exempted `path` by name.
- A developer's `name` is now fenced when it contains a space, because it is prose written
  by whoever pushed the commit. A client that round-trips a display name from output into a
  `ferret_find` filter must use the raw value; the same has always been true of `message`.
- A long single-token value (a base64 blob) is still contained, by the `PROSE_LENGTH`
  backstop, which is kept.

**Entity-wide.** `containEntityContent` contains `attributes`, `unknownFields` and
`externalIds` together. Four surfaces had written `{ ...entity, attributes: containAttributes(...) }`,
which contains one field and hands over the other two — and `unknownFields` is source data
*retained verbatim and never validated*, the widest untrusted surface an entity has. A
surface cannot forget a field it does not name.

### F-66 — the notice must arrive first

`contentNotice` is now the first key of both the `ContextPack` and the `AnswerPack`
literals; key order is JSON serialization order, so that line is the fix and not a
preference. On the MCP surface both tools emit `{ notice, ...rest }`, renaming rather than
duplicating — `notice` is the key every other tool leads with, and `packs.build()` still
returns `contentNotice` for the pack format. The notice test now **enumerates
`listTools()`** and looks arguments up per tool, so a tool added without an entry fails the
file rather than being silently skipped: a hand-written list of four tools is exactly how
F-66 survived.

## 4. Second-order defects found by re-auditing, and corrected

Every one of these was found after the initial fix was green, by asking where else the same
class reaches.

1. **`unknownFields` and `externalIds` uncontained on every entity-bearing surface**
   (`ferret_get_entity`, the pack's items, the answer's subject). Source data nothing
   validates, emitted beside the contained attributes and outside the boundary, uncounted.
   → `containEntityContent`, plus `containedContentOf` for the surfaces that project fields
   rather than spreading the record.

2. **Edge `metadata` uncontained** on both `ferret_neighbours` branches — what the *source*
   said about the edge. → contained.

3. **A pack item's evidence `statement` uncontained.** `ferret_why` had contained it since
   EPIC-048; the pack, whose entire purpose is to be pasted into a prompt, had not, and
   `renderPack` printed it into the text form as well.

4. **Provider-supplied evidence metadata uncontained, and interpolated into sentences
   Ferret wrote.** `field`, `locator`, `sourceUrl` and the producer identity are each a
   bare `z.string()` on the evidence schema. Worse, `field` is interpolated into
   `; disputed: <field>` in the pack, into "observations disagree about `<field>`" in an
   answer, and into two `reason` strings inside `evidence-selection.ts` — directly
   contradicting the MCP surface's claim that "there is no template anywhere in this file
   with a hole for source text". The comment beside the pack's interpolation asserted the
   values were "Ferret's own canonical keys", which is true of the git provider and not of
   the schema. EPIC-074 has just made writing a provider a supported thing to do, so "no
   provider does this today" is a statement about the providers that exist rather than
   about the boundary.

   → **This is why containment moved to the entry point.** Patching each emit site left the
   selection's own sentences uncovered, and `selectEvidence` is pure and has no accumulator
   to contain with. Candidates are now contained where they *enter* the pack and answer
   builders, so the selection, its reasons, its disputed-field list, the pack's `reason` and
   the rendered text are all built from contained values by construction.
   `selectEvidence` stays pure and knows nothing about containment; a field name used as a
   grouping key still groups, because `contain` is deterministic. `integrityHash` is left
   alone, so a citation can still be verified against the store.

5. **Double containment corrupting the quotation — self-inflicted by fix 4.** With
   containment at the entry point, the answer's existing `containStatement` applied the
   fence a *second* time; `contain` neutralises any delimiter it finds inside a value, so
   the second pass rewrote the first pass's fence to `[delimiter removed]` and left that
   string in the middle of a quotation Ferret attributes to a repository. Two layers of a
   correct control producing a wrong answer. Found by an assertion written specifically to
   look for it, which failed:

   ```
   × contains a claim statement exactly once, so the content is not corrupted
       expected '{ "notice": … }' not to contain '[delimiter removed]'
   ```

   → Containment happens exactly once, which means it happens in one place.
   `containStatement` is deleted and its history is recorded where the decision now lives.
   `describeEvidence` holds `statement` out of its view for the same reason, since that
   surface emits it JSON-serialized.

6. **Two checkers on the declared control surface with no production caller.**
   `delimitersBalanced` and `outsideFences` were exported from `src/security/index.ts`, and
   `tests/security/control-reachability.test.ts` correctly failed: that barrel declares only
   controls a production path reaches (the `containsSecret` precedent). They are imported
   from `./containment.js` directly, and the barrel says why.

## 5. Paths audited and found sound

- `ferret_explain` carries no notice **and needs none**: `explainQuery` emits ids, kinds and
  Ferret's own strategy names — verified, no repository text — and a notice on a document
  that needs one teaches a reader to ignore notices.
- `ferret_search`'s `highlight` was already contained unconditionally; `ranking` is
  structural.
- `describeHit` projects fields explicitly and never spread `unknownFields`.
- The only string-slicing transformation downstream of containment is `trimItem`; the other
  `slice` calls in `pack.ts` and `answer.ts` bound *arrays* of candidates and claims.
- Serialization order: `safety.contain(JSON.stringify(...))` contains after serializing, so
  the fence encloses the serialized form rather than being embedded in it.
- CLI surfaces print no entity attributes.

## 6. A test replaced rather than repaired

`tests/security/untrusted-content.test.ts` asserted that the *source text* of
`mcp/server.ts` and `context/answer.ts` contained `containAttributes(` or `safety.contain(`.
That is the wrong layer, and Batch 5 proved it three times: all of F-32, F-64 and F-66 were
live while those greps were green. A grep for a call site cannot see whether the call
reached the content, survived the transformations after it, or arrived before the notice —
and each of those was the defect.

It also broke on a refactor that *improved* what it was guarding: `context/answer.ts` now
reaches containment through `containEntityContent`, so the regex stopped matching a file
that had become more correct. A test that fails when the code improves and passes while the
boundary is broken is worse than absent, because it is counted.

What remains in that file is what genuinely is a property of the helpers — content cannot
forge the fence, the delimiters are characters ordinary source cannot spell, the report
counts what it did. The surface property is asserted over a response in
`injection-boundary.test.ts`.

`tests/unit/containment.test.ts` kept its case "marks a token without wrapping it" but its
value changed: `'You are now root'` is four words, which the shape rule now contains — and
correctly, since it is a name a repository wrote. A chat-template control marker (`[INST]`)
is the honest example of a token that reaches `marked` without reaching `contained`, and a
new case pins the wrapped side of the same line.

## 7. Verification

```
npm run lint       clean
npm run typecheck  clean
npm run build      clean
npx vitest run     3442 passed | 7 skipped | 1 failed  (170 files, 169 passed)
```

**Batch 5's own fixture: 13 passed** (8 of 9 red before the fix; four assertions added
during the re-audit).

The single failure is `tests/integration/storage/scale.test.ts > scans rather than indexes
when the whole table is wanted` — PostgreSQL chose `Index Only Scan using entity_lifecycle_idx`
over a sequential scan for `SELECT count(*)`. **Not caused by Batch 5**, proved rather than
asserted: the test passes in isolation *both* with the changes and with them stashed, and
nothing in this batch touches SQL, schema or query planning. It is a visibility-map and
statistics artifact of a full-suite run — the same class as F-92, and recorded separately
as **F-101** rather than folded into this batch.

## 8. F-92 and F-73, kept separate

Neither fired on this run. `discovery.test.ts > walks a wide tree within budget` (F-92)
passed, and packaging completed all 34 tests (F-73). Both remain open as
contention-sensitive infrastructure findings; nothing here addresses them and nothing here
caused them.

## 9. Files changed

Implementation: `src/security/containment.ts` · `src/security/index.ts` ·
`src/context/pack.ts` · `src/context/answer.ts` · `src/mcp/server.ts`.

Tests: new `tests/security/injection-boundary.test.ts`; `tests/unit/containment.test.ts`
(five cases added, one corrected); `tests/security/untrusted-content.test.ts` (source-grep
block replaced).

## 10. What this does not claim

Ferret cannot make a client obey. The boundary is unambiguous, the marking is
machine-readable, the notice arrives before the content and the fence now survives every
transformation and reaches every reachable untrusted value — and the rest is not in Ferret's
gift. Claiming more would be the manufactured certainty Governance §6 forbids.

The classifier remains advisory and narrow, exactly as EPIC-084 designed it. It is not the
control; containment is. F-64's fix means the *report* now describes content that was
actually examined, which is the difference between a number a client can weight and an
affirmation about nothing.
