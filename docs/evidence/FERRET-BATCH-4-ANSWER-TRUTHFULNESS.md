# Batch 4 — Answer truthfulness (F-05, F-31, F-28, F-06, F-24; F-27 open)

**Status: IMPLEMENTED, re-audited** · Base `0407618` · Branch `forensic/post-roadmap-audit` · 2026-09-03

> Not merged, not pushed to `main`, not deployed. No Epic status changed, no Epic created,
> no work started on Batch 5. F-07 and F-25b were **not** touched.

## 1. The contract each finding violated

One property, six ways of breaking it: **Ferret must not state what it cannot support.**

| Finding | Contract violated |
| --- | --- |
| F-05 | An answer about a subject the source no longer has was given in the present tense, with `unknowns: []`. Inability to observe became a positive claim. |
| F-31 | Rows removed because a caller may not see them were dropped silently, and the answer then asserted `truncated: false`. "There is nothing there" and "you may not see it" became the same answer. |
| F-28 | A traversal cut by the per-hop SQL bound was returned as exhaustive; at depth 1 no bound was reported at all. |
| F-06 | Members of a multi-valued field were marked "replaced by a newer observation" — false, they are different facts — and the loss was rendered as "a current record covers this field". |
| F-24 | Spans named bytes they did not quote, for BOM'd, UTF-16 and multi-paragraph plain-text files. Every citation over such a file pointed somewhere else. |
| F-27 | Unresolved references were counted and discarded, so "nothing references this" and "we refused to resolve most of them" are the same answer. **Open — see §6.** |

## 2. Failing evidence, before the fix

**F-24** — `tests/unit/span-fidelity.test.ts` slices the *original file bytes* by the span
each segment reported and compares to that segment's own text. Both controls (LF, multi-byte)
passed from the start; the three defects did not:
```
✓ is exact for LF markdown — the control
✓ is exact for multi-byte characters — the control
× is exact for a file with a UTF-8 BOM — F-24        expected [ '0-7', '9-15' ] to strictly equal []
× is exact for plain text separated by more than one blank line — F-24   expected [ '13-26' ]
× is exact for plain text with CRLF separators — F-24                    expected [ '14-28' ]
× claims no precise span for UTF-16, rather than a wrong one — F-24
    expected { precise: true, explained: false } to strictly equal { precise: false, explained: true }
```

**F-05** — `tests/unit/answer-pack.test.ts` and `tests/integration/mcp/tools.test.ts`:
```
× does not answer in the present tense about a deleted subject — F-05
    expected { completeness: 'answered', … } to strictly equal { completeness: 'partial', … }
× renders the standing where a reader will see it — F-05
× names the standing of a subject the source no longer has — F-05
    expected 'undefined' to match /removed/iu
✓ still answers an active subject without qualification — the control
```

**F-31 and F-28** — `tests/integration/mcp/tools.test.ts`, against the pre-fix handlers:
```
× says when the bound cut the hop, at depth one — F-28
    expected undefined to be true
× distinguishes rows withheld from rows that are not there — F-31
    expected undefined to be 3
```

**F-06** — `tests/integration/domain/evidence-store.test.ts`, real PostgreSQL:
```
× keeps every member of a collection current
    expected [ 'superseded', 'superseded', 'current' ] to strictly equal [ 'current', 'current', 'current' ]
× shows every member to a caller, not the last one written
    expected 1 to be greater than or equal to 3
✓ still supersedes a single-valued field — the control
```

Each was re-confirmed red by reverting only the fix and re-running, so the red is the
defect and not a missing field.

## 3. What changed

| Finding | Change |
| --- | --- |
| F-05 | `src/context/answer.ts` reads the subject's `lifecycle`, forces `PARTIAL`, states the standing first in `unknowns`, and renders it beside the subject. `src/mcp/server.ts` reports `standing` on `ferret_why`, on both the `held: true` and `held: false` branches. The sentence is written for an *answer* — EPIC-057's `describeStanding` says "ranked below live results", which is true of a search result and meaningless in an answer. |
| F-31 | `RetrievalPort.findEntities` returns `EntityResult { entities, withheld, more }`; the store over-fetches by one so "is there more" is answered by the database rather than inferred from a list permission filtering already shortened. `ferret_find` reports `withheld` and `more` as **separate facts**. |
| F-28 | `#neighbours` selects `LIMIT n+1` and reports `more`; `HopReader` carries it, and `traverseFrom` records `TraversalBound.LIMIT` when any hop was cut. `ferret_neighbours` reports `truncated`/`more`/`withheld` on the depth-1 branch — the default and every existing caller. |
| F-06 | The evidence input gains `cardinality: 'single' \| 'collection'`, defaulting to `single`. `record()` supersedes only single-valued fields. The three collection producers declare it, and the directive is carried on the in-memory canonical record so evidence emitted through the SDK's `Emitter` does not lose it — excluded from the integrity hash, because it describes how a write is applied rather than what was observed. |
| F-24 | `detectContent` reports `textByteOffset` and `byteAddressable`. The framework shifts spans by the byte-order mark it stripped, and for an encoding whose offsets cannot be converted at all widens the span to the whole file with a stated warning rather than naming unrelated bytes. `#plain` uses a capturing split so a separator's real width is measured. |

## 4. Second-order defects found while re-auditing

1. **The depth bound overwrote the limit bound.** My first F-28 version set `truncated = LIMIT`
   for a cut hop and then let the end-of-depth branch overwrite it with `DEPTH`. An existing
   test — "prefers the limit reason when both bounds would apply" — caught it, and it was
   right to: the limit is the more useful answer, because raising the depth would not help.
2. **A cut hop would have stopped the walk.** The same version treated "a hop was cut" as a
   reason to stop traversing, discarding paths that were reachable through rows the hop *did*
   return. Separated into `atCapacity` — the result set being full is the only reason to stop.
3. **The cardinality directive was lost through the `Emitter`.** `toEvidenceInput` rebuilds a
   write from a canonical record, so a collection field emitted through the SDK would still
   have collapsed to its last member. The directive is now carried on the record.
4. **The UTF-16 warning would have fired on binary parsers.** `.xlsx`, `.docx` and `.pdf` are
   detected as binary and already emit whole-file spans; the warning is guarded on
   `text !== undefined` and the span rewrite early-returns when the span is already the whole
   file, so nothing about those parsers changes.
5. **`findEntities` over-fetch versus the caller's own over-fetch.** `ferret_find` used to ask
   for `requested + 1` and slice. With the store over-fetching, asking for `requested + 1`
   would have returned one row too many; the handler now asks for exactly what was requested.

Checks made and passed:

- **Withheld stays distinguishable from absent** — `withheld` is its own number on both tools,
  and `truncated` is true when *either* cause applies, with `more` naming which.
- **A traversal limit does not read as exhaustive** — asserted at depth 1 and through the walk.
- **Unsupported spans never identify the wrong bytes** — a parser that cannot map offsets
  reports the whole file and says why; it does not report a narrower guess.
- **Single-valued supersession still works** — asserted as a control beside the collection
  case, because fixing one by breaking the other would be no fix.
- **An active subject still answers `answered`** — asserted as a control, so F-05's fix cannot
  degrade every answer to `partial`.

## 5. Suite

`npm run lint && npm run typecheck && npm run build && vitest run` on the branch, against a
real PostgreSQL container and real `git`:

```
Test Files  169 passed (169)
     Tests  3428 passed | 7 skipped (3435)
  Duration  393.71s
```

**Zero failures, and neither known infrastructure flake fired this run.** F-92
(`discovery.test.ts > walks a wide tree within budget`) passed; F-73 did not recur —
`packaging.test.ts` completed, so the 7 skips are the 4 docker and 3 signals cases only.
Both remain open as recorded findings: they are intermittent, which is the point of them.

An earlier run of this same batch failed two assertions in
`tests/integration/retrieval/retrieval.test.ts` — "returns nothing rather than everything
for a filter that matches nothing" and "returns nothing for an entity nothing is connected
to". Both compared the new result object against `[]`: assertions my adaptation had missed,
not defects. They now assert all three facts an empty result carries — nothing found,
nothing withheld, nothing further — which is a better test than the one they replaced,
because "there is nothing there" must not be reachable by any other route.

The port change rippled into seven test files (fakes implementing `RetrievalPort`, and call
sites that took a bare array). Those were adapted rather than worked around: the traversal
fake now slices to the limit and reports `more`, because a fake that always says "nothing
more" cannot express the case F-28 is about.

## 6. F-27 — open, and why

**Not closed.** Unresolved references are still counted per run and discarded, so a reference
read still cannot distinguish "nothing references this" from "Ferret refused to resolve most
of the references to it".

The root fix has two halves. The first — persist the refusals — has no cheap home: the
counts are computed in the *second* pass, after each file's content artifact has already been
written and after every symbol entity has been written, so recording them requires either a
second symbol write after cross-file resolution or a restructuring of when the artifact is
recorded. The second half — a caveat on the reference read — depends on the first.

That is a structural change to the content stage, and starting one at the end of a batch,
without its own red-green cycle and its own re-audit, is exactly what this discipline exists
to prevent. It is left open with the analysis recorded rather than half-built. It remains a
**P1-A production blocker**.
