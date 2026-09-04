# Batch 3 — Untrusted-input bounds (F-60, F-61, F-95, F-96, F-97)

**Status: IMPLEMENTED, re-audited** · Base `0407618` · Branch `forensic/post-roadmap-audit` · 2026-09-03

> Not merged, not pushed to `main`, not deployed. No Epic status changed, no Epic created,
> no work started on Batch 4. F-44 and F-45 were left alone.

## 1. What was wrong

Five defects, one theme: **content a repository supplies decided how much work Ferret
would do, or where Ferret thought it was in a stream.**

- **F-60** — the ZIP decompression bound was checked against `uncompressedSize` from the
  archive's own central directory, and `inflateRawSync` was called with no output limit.
  An entry could declare one byte and inflate to gigabytes. Measured: 204 KB → 200 MiB,
  3.1× past a 64 MiB bound.
- **F-61** — `.docx` never went through Ferret's bounded reader at all. `mammoth` unpacks
  the archive itself, and `maxBlocks`/`maxCharacters` are applied to a document that has
  already been materialised. Measured: 353 KiB → 480 MiB resident over 5.7 s.
- **F-95** — `parseLog` found record boundaries by recognising *content*: a token shaped
  like a hash followed by fields shaped like dates. Git emits the literal `%aI` for a date
  it cannot parse and `+999:99` for an out-of-range offset, so the boundary was missed, the
  header was consumed as file-change entries, and the reader walked out of step for the
  rest of the page — losing every later commit and writing `{"path":"%aI"}` into the graph
  as a file.
- **F-96** — `emitHistory` had no per-commit boundary. One commit the canonical model
  refused threw out of the middle of the loop, so a 1 000-commit page produced zero
  entities.
- **F-97** — on any non-zero `git log` exit, `readHistory` discarded stdout entirely and
  returned an empty, untruncated page. Git streams what it has walked and *then* fails, so
  a corrupt object mid-history threw away real commits and produced a result identical to
  a repository with no history.

## 2. What changed

| Finding | File | Change |
| --- | --- | --- |
| F-60 | `src/parsers/sheet/zip.ts` | The bound is enforced by the decompressor: `inflateRawSync` gets `maxOutputLength` set to the remaining budget, and the total accumulates **actual** bytes. The declared size survives as a cheap pre-filter, and an entry whose real size disagrees with its declaration is refused. Stored (uncompressed) entries are bounded too. |
| F-61 | `src/parsers/office/document.ts`, `src/parsers/sheet/zip.ts` | The package is put through `assertZipWithinBound` **before** `mammoth` sees it. That helper inflates and discards, so the guarantee costs no retained copy, and it allows the entry count a real document has rather than a workbook's. |
| F-95 | `src/git/history.ts` | Records begin with a marker Git writes (`%x01ferret%x01`), and a boundary is equality against it. Nothing about staying in step depends on a date being well formed. A timestamp Git could not produce is now **absent** rather than stored as `"%aI"`. |
| F-96 | `src/git/provider.ts` | Every mutation inside the commit loop records how to undo itself; a commit that cannot be represented is rolled back, named in `skippedRecords`, and the page continues. |
| F-97 | `src/git/history.ts`, `src/git/provider.ts`, `src/indexing/indexer.ts` | A failed read with output returns those commits plus `incomplete: { reason }`. `since` is validated as an instant, because Git *ignores* an unparseable `--since` rather than refusing it — silently turning an incremental read into a full one. |

## 3. Evidence — the fixtures, red against the baseline

`tests/unit/sheet-parser.test.ts` (F-60):
```
× refuses an entry that inflates past the bound however small it declares — F-60
    AssertionError: expected [Function] to throw an error
× never hands back more inflated bytes than the bound allows — F-60
    AssertionError: expected 1048576 to be less than or equal to 65536
```

`tests/unit/docx-parser.test.ts` (F-61) — the pre-fix run does not fail an assertion, it
**kills the worker**, which is the finding:
```
× refuses a package that inflates past the archive bound — F-61
    Caused by: Error: Worker exited unexpectedly
```
After the fix the same case refuses in 678 ms.

`tests/integration/git/malformed-history.test.ts` (F-95, F-96, F-97):
```
× reads the commits either side of one Git cannot date — F-95
    expected [ 'after the bad one', 'initial' ] to strictly equal [ …(3) ]
× never turns a header field into a file that does not exist — F-95
    expected [ …(3) ] to strictly equal []
× emits the commits it could read when one of them is malformed — F-96
    FerretError: Entity is not valid — sourceObservedAt: Invalid ISO datetime
× keeps the commits Git streamed before it failed, and says it was cut short — F-97
    expected { read: 0, incomplete: false } to strictly equal { read: 5, incomplete: true }
× reports an unreadable revision as a refusal rather than an empty history — F-97
    promise resolved "{ commits: [], truncated: false }" instead of rejecting
```

Two fixture generators had to be extended before any of this could be expressed at all —
which is why the defects survived a green suite. `deflatedZip` wrote only honest sizes, so
a lying central directory was unrepresentable; `buildZip` wrote only stored entries, so
amplification was unrepresentable. Both now take the adversarial shape.

## 4. Second-order defects found while re-auditing the fixes

Five, all found before any finding was called closed. Three were in the fixes themselves.

1. **The docx pre-flight would have refused ordinary documents.** Routing `.docx` through
   `readZip` imposed `MAX_ZIP_ENTRIES = 512` — written for a workbook — on a document that
   can legitimately have hundreds of image parts, and it retained the whole inflated
   package about to be inflated again by `mammoth`. Replaced with
   `assertZipWithinBound`, which inflates, measures and discards, and allows 8 192 parts.
2. **The discard was not a discard.** The first version stored `entry.subarray(0, 0)`,
   which keeps the backing `ArrayBuffer` alive and saved nothing. Now a new empty array.
3. **`since` validation rejected the honest caller.** `isInstant` was written for Git's
   `%aI`, which has no fractional seconds; `Date.prototype.toISOString` emits them. The
   first version of the validation refused every JavaScript-produced instant — caught by
   an existing test (`reads only what is new when given an instant`), not by a new one.
   Input is now validated by a rule that allows fractional seconds; Git's own output is
   still held to the exact shape.
4. **An incomplete read would have made the gap permanent.** This is the interaction with
   Batch 1: a page that stops early still reported a `tip`, and recording it would tell the
   next run that everything behind it was already known. An incomplete page now records no
   tip, leaves `lastCommitAt` where it was, adds `(history)` to the run's `skipped` list and
   logs at `warn`.
5. **A blanket edit hit two unrelated methods and one self-recursion.** Rewriting
   `evidence.push(` to the journalled `observe(` matched sites in `emitGraph` and inside
   `observe` itself. Caught by the typechecker; restored precisely.

Checks made and passed:

- **Declared-size deception** — the bound no longer consults the archive's number for
  enforcement, and a declaration that disagrees with reality is refused rather than
  trusted. A ZIP64 entry (sizes written as `0xFFFFFFFF`) is refused by the pre-filter as it
  was before, not silently mis-measured.
- **Bounded reading throughout the path** — stored entries are bounded as well as deflated
  ones; the docx path is bounded before the third-party decompressor runs.
- **Marker forgeability** — a commit message equal to the marker is followed by the next
  record's marker rather than a hash, so it cannot start a record. The existing test that a
  file named like a 40-hex hash is not mistaken for a commit still passes.
- **One bad object fails locally** — proved twice: the parser keeps the commits either side
  of an undatable one, and the emitter keeps the page around a commit it cannot represent.
- **Truthful semantics** — nothing was made to succeed quietly. A malformed timestamp is
  absent rather than invented; a cut-short read says so; a refused archive raises; a
  skipped commit is named.

**One test was replaced.** The F-96 case originally relied on an undatable commit — but
F-95 removes that trigger, so the test would have proved the trigger was gone rather than
that a boundary exists. It now hands `emitHistory` a record the canonical model refuses for
an unrelated reason, and asserts the neighbours survive and the loss is named. One
assertion was also weakened deliberately: how many commits Git streams before giving up is
its buffering, not a contract, so the F-97 case asserts that what was streamed is kept and
that the page admits being incomplete.

## 5. Suite

`npm run lint && npm run typecheck && npm run build && vitest run` on the branch, against a
real PostgreSQL container and real `git`:

```
Test Files  1 failed | 167 passed (168)
     Tests  1 failed | 3409 passed | 7 skipped (3417)
  Duration  584.31s
```

The one failure is `tests/integration/git/discovery.test.ts > walks a wide tree within
budget` — 38 769 ms against a 30 000 ms ceiling. That is **F-92**, recorded by the forensic
pass, which failed it twice on this machine (30.0 s, then 38.0 s) before any of this work
existed. It walks a filesystem, not a history, so nothing in this batch touches it, and in
isolation the whole suite passes with that case at **2 242 ms**. It stays open as a P3
contention-sensitive gate and is deliberately not fixed here.

**F-73 did not fire this run**: `packaging.test.ts` completed all 34 tests, so the 7 skips
are the 4 docker and 3 signals cases only. F-73 remains open — it is intermittent, which is
the finding — but the packaging gate did execute this time.

Every new fixture passed in the full run: `sheet-parser` 32, `docx-parser` 24,
`git-history-parser` 30, `malformed-history` 7.

## 6. Not done in this batch

- **No wall-clock deadline on parsing.** F-61's 5.7 s was uninterruptible; the memory bound
  is fixed, the time bound is not. Recorded, not fixed — it needs a decision about where a
  parse deadline belongs.
- **F-44 and F-45** untouched, as instructed.
- **`%x01` in a path** could in principle collide with the record marker if the following
  token were also a 40-hex string. Contrived, strictly narrower than the previous exposure,
  and recorded rather than defended against.
