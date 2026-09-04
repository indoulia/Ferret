# STATE

**Phase:** COMPLETE, and merged. Seven implementation batches, a read-only final forensic
audit, the F-23 fix, one controlled integration, F-27's read half, a record reconciliation —
**merged to `main` as PR #153** — and then a second cycle against the merged tree.
**All 24 P1-A findings and the P0 are closed on `main`.**

**Base:** `0407618`. **`main` is now `10531e003acc38aff3a656b368cf438580d6dd0f`** — PR #153,
squash-merged, carrying all 92 files. The earlier "`main` contains none of this" was true
until that merge and is kept below as the record of the state this file was written in.
**Post-merge cycle:** branch `forensic/post-merge-remediation` — twelve further findings
fixed, every remaining one given an evidence-backed disposition. **Not merged.**
**Tree:** `C:\AIAgent\Ferret`, branch **`integration/p1a-remediation`** at
**`c696dacff7e9b0ea57329b5b106367764d544ff2`**. The forensic worktree
`C:\AIAgent\ferret-forensic` (branch `forensic/post-roadmap-audit`, `6439449`) is intact and is
now an ancestor of this branch.

**Last action:** documentation and evidence reconciliation — no source or test change.

**Verdict: QUALIFIED**, for fewer reasons than before. CI has now run on three platforms and
a pinned PostgreSQL 17 + pgvector, and the deployment surface is verified end to end. What
remains is human review and four isolated product decisions. See "Verdict" below and the
disposition table at the foot of `.agent/FINDINGS.md`.

**Validation, combined tree at `c696dac6`** — the first valid numbers for the remediation set:
**176 files, 3 542 passed, 7 skipped, 0 failed, exit 0**; lint, typecheck and build/package
clean. Earlier totals (3 513/175 forensic-only, 3 395/164 F-23-only) are stale by construction.

Records: `docs/evidence/FERRET-POST-FORENSIC-FINAL-AUDIT.md` (the audit as taken at `cd3ca85`,
with a supersession note), and `.agent/FINDINGS.md` for current status.

## Done
- Forensic verification — 100 findings (`docs/evidence/FERRET-POST-ROADMAP-FORENSIC.md`).
- Triage — buckets, dependencies, eight batches (`docs/evidence/FERRET-POST-FORENSIC-TRIAGE.md`).
- **Batch 1 — ingestion completeness** (`docs/evidence/FERRET-BATCH-1-INGESTION-COMPLETENESS.md`):
  resume by reachability (`^<tip>`) instead of by commit date, and follow the page cursor
  to its end. Closes F-01 (P0), F-02, F-03, F-04.

- **Batch 2 — small self-contained blockers** (`docs/evidence/FERRET-BATCH-2-BLOCKERS.md`):
  credential redaction in the printed backup command; a catalogue allowlist for imported
  column names; per-value rather than per-line redaction on export; extensions provisioned
  before migrating, plus a repair for installations already past it. Closes F-30, F-29,
  F-17, F-16.

- **Batch 3 — untrusted-input bounds** (`docs/evidence/FERRET-BATCH-3-UNTRUSTED-INPUT-BOUNDS.md`):
  the ZIP bound enforced by the decompressor on real bytes rather than on the archive's
  own claim; `.docx` routed through a bounded reader before `mammoth`; git records found
  by a marker rather than by recognising content; per-commit isolation in the emitter; a
  cut-short read keeping what it read and saying so. Closes F-60, F-61, F-95, F-96, F-97.

- **Batch 5 — prompt-injection boundary** (`docs/evidence/FERRET-BATCH-5-PROMPT-INJECTION-BOUNDARY.md`):
  a fence that survives truncation (the cut is made in the payload and the fence re-applied,
  the trim marker outside it); containment that recurses into arrays and nested objects with
  a depth bound and counts every leaf; the prose/token line redrawn by **shape** rather than
  by key name, because recursion arrives at keys the module never heard of; `unknownFields`,
  `externalIds` and edge `metadata` contained; untrusted records contained where they
  **enter** the pack and answer builders rather than at each place they leave; the notice
  first, under the key every other tool uses, with the test enumerating `listTools()`.
  Closes F-32, F-64, F-66.

- **Batch 4 — answer truthfulness** (`docs/evidence/FERRET-BATCH-4-ANSWER-TRUTHFULNESS.md`):
  lifecycle consulted by the answer surfaces; withheld rows and cut hops reported as
  separate facts; supersession applied only to single-valued fields; spans that name the
  bytes they quote. Closes F-05, F-31, F-28, F-06, F-24. **F-27 remains open** — the fix
  needs a second symbol write after cross-file resolution, which is a structural change to
  the content stage and was not started at the end of a batch.

- **Batch 6 — credential and safety enumeration** (`docs/evidence/FERRET-BATCH-6-CREDENTIAL-AND-SAFETY-ENUMERATION.md`):
  the Git safety configuration extended to the keys that change output *shape* rather than
  only those that name a program, and — because a pin is still an enumeration — the parser
  now **counts** every region of Git's output it cannot read and `readHistory` reports the
  page incomplete, so an unenumerated key produces a page that says it is wrong instead of a
  page that is silently wrong. Credentials judged by four independent rules — named,
  registered (a `$secret` reference's variable and every value Ferret resolves), named like
  a credential, shaped like a credential — with `redactString` removing registered values and
  `gitVector` refusing an argument that carries one. Closes F-94, F-71.

- **Batch 7 — code-intelligence and identity truth** (`docs/evidence/FERRET-BATCH-7-CODE-INTELLIGENCE-TRUTH.md`):
  the receiver carried from the parser so `this.has()` corroborates and `map.has()` does not;
  `line` out of a reference edge's identity, and the indexer closing what a re-derived
  endpoint no longer asserts; per-file resolution counts persisted on the `file` entity and
  replayed through the gate; and an address that is not an address minting no actor — after
  the mailmap, with the commit recording `unattributedAuthor` instead. Closes F-25, F-25b,
  F-27 (persistence half — see below), F-11. **The last implementation batch.**

## Changed
F-27 read half (`c696dac`): `src/retrieval/query.ts` · `src/retrieval/index.ts` ·
`src/storage/retrieval.ts` · `src/mcp/server.ts` · `src/index.ts`. Tests: 7 cases added to
`tests/integration/mcp/tools.test.ts` (and the fake retrieval taught the new optional field),
4 to `tests/integration/indexing/reference-intervals.test.ts`, 3 drift guards to
`tests/unit/code-reference-truth.test.ts`. **No migration** — the counts were already stored.
F-23 (`896bcaa`): `src/parsers/sheet/xlsx.ts` · `src/parsers/sheet/provider.ts`. New test:
`tests/unit/sheet-corruption.test.ts`.
Batch 7: `src/code/references.ts` · `src/code/index.ts` · `src/parsers/code/provider.ts` ·
`src/providers/contracts/parser.ts` · `src/indexing/content.ts` · `src/indexing/indexer.ts` ·
`src/indexing/ports.ts` · `src/storage/relationships.ts` · `src/git/provider.ts` ·
`src/identity/git-identity.ts` · `src/project/model.ts` · `src/domain/attributes.ts`.
New tests: `tests/unit/code-reference-truth.test.ts`,
`tests/integration/indexing/reference-intervals.test.ts`,
`tests/integration/git/identity-collapse.test.ts`; one case in `tests/unit/code-references.test.ts`
corrected and one added.
Batch 6: `src/security/credentials.ts` · `src/security/subprocess.ts` (new) ·
`src/security/secrets.ts` · `src/security/index.ts` · `src/errors/redact.ts` ·
`src/git/runner.ts` · `src/git/history.ts` · `src/git/index.ts` · `src/config/secret-ref.ts` ·
`src/config/credentials.ts` · `src/environment/detect.ts`. New tests:
`tests/security/git-output-integrity.test.ts`, `tests/security/credential-surface.test.ts`;
`credential-isolation`, `credential-containment` and `packaging` updated for what changed
beneath them.
Batch 5: `src/security/containment.ts` · `src/security/index.ts` · `src/context/pack.ts` ·
`src/context/answer.ts` · `src/mcp/server.ts`. New test:
`tests/security/injection-boundary.test.ts`; five cases added and one corrected in
`tests/unit/containment.test.ts`; the source-grep block in
`tests/security/untrusted-content.test.ts` replaced with a behavioural one.
Batch 1: `src/git/history.ts` · `src/git/provider.ts` · `src/indexing/indexer.ts`.
Batch 4: `src/parsing/detect.ts` · `src/parsing/framework.ts` · `src/parsers/text/provider.ts` ·
`src/context/answer.ts` · `src/context/pack.ts` · `src/mcp/server.ts` · `src/retrieval/query.ts` ·
`src/retrieval/traverse.ts` · `src/storage/retrieval.ts` · `src/storage/evidence.ts` ·
`src/domain/evidence.ts` · `src/indexing/content.ts` · `src/indexing/indexer.ts` ·
`src/project/model.ts`. New test: `tests/unit/span-fidelity.test.ts`; cases added to
`answer-pack`, `mcp/tools`, `evidence-store`; seven test files adapted to the port change.
Batch 3: `src/parsers/sheet/zip.ts` · `src/parsers/office/document.ts` ·
`src/git/history.ts` · `src/git/provider.ts` · `src/git/runner.ts` (export `firstLine`) ·
`src/indexing/indexer.ts`. New tests: `tests/integration/git/malformed-history.test.ts`,
plus cases in `sheet-parser`, `docx-parser`, `git-history-parser`; fixture generators
extended in `tests/support/ooxml-fixtures.ts`.
Batch 2: `src/storage/export.ts` · `src/storage/import.ts` · `src/storage/provider.ts` ·
`src/storage/migrator.ts` · `src/cli/commands/init.ts` ·
`src/storage/migrations/0013_embedding_repair.sql` (target schema version 12 -> 13).
New tests: `tests/integration/indexing/history-completeness.test.ts`,
`tests/unit/history-paging.test.ts`, `tests/integration/storage/backup-fidelity.test.ts`,
`tests/integration/storage/embedding-provisioning.test.ts`, plus one case in
`tests/unit/export.test.ts`.

## Verified (combined tree, `c696dac6`)
`npm run lint && tsc --noEmit && npm run build && npx vitest run`:
**176 files, 3 542 passed, 7 skipped, 0 failed**, exit 0. Lint, typecheck and build clean;
13 migrations, 4 grammars and the golden datasets copied; `packaging.test.ts` ran all 34.

**These are the first valid numbers for the remediation set.** Two intermediate points are
recorded because the arithmetic between them is the evidence, not the reassurance:

| Point | Files | Tests |
| --- | --- | --- |
| forensic branch alone, `cd3ca85` | 175 | 3 513 passed, 7 skipped |
| F-23 alone, `896bcaa` | 164 | 3 395 passed, 7 skipped |
| integrated, `3dc8181` | 176 | 3 528 passed, 7 skipped |
| with F-27's read half, `c696dac6` | **176** | **3 542 passed, 7 skipped** |

175 + 1 = 176 and 3 513 + 15 = 3 528 **exactly**, which is what says the two remediation sets
do not interact — nothing was lost or double-counted in the merge. The one semantic pairing
worth naming was tested rather than assumed: F-23's structural guard in `xlsx.ts` reads parts
through `zip.ts`, which Batch 3 rewrote for F-60.

The 7 skips are structural and pre-existing: `docker.test.ts` (4, registry-dependent) and
`signals.test.ts` (3, POSIX signals on Windows). No database suite skipped. F-73, F-92 and
F-101 did not fire in any run — which does not disprove them.

## Proved (F-27, the read half)
The defect was that `count: 0`, `truncated: false` and `withheld: 0` — three fields that
between them assert an answer is whole — came back over a graph Ferret had declined to finish
resolving. Reproduced on both layers before any implementation change:

- **Tool surface, 6 of 7 assertions red.** First message: `an empty reference answer carried no
  completeness at all: expected undefined to be defined`. The one green is the control that a
  verdict must *not* appear on a question that is not about references — it passes on both
  sides, which is the only way it is worth anything.
- **Real store, 2 of 4 red** — real PostgreSQL, real `git`, real grammars. The other two are
  controls (noise, and read idempotency across a second index run) and are not claimed as
  red-first.

Both red sets were produced by stashing only `src/` and re-running the same assertions, so the
red and the green differ by the implementation and by nothing else.

Two second-order defects found by re-auditing the fix rather than by the finding, both
corrected: a comment that **claimed a drift-guard test which did not exist** — storage may not
import `src/code/` (`boundaries.test.ts`), so duplicating the edge-type strings is correct and
the missing half was the check, now written along with a control that every
`UnresolvedReason` is deliberately a refusal or an absence; and a verdict computed on **every**
unfiltered traversal, which is the default path, costing two round trips to tell a commit
about a reference graph it is not an end of — now gated on the subject being an end of a
reference edge.

## Verified (Batch 7)
See the final audit section below — this batch's numbers are the audit's numbers.
One existing assertion changed and it is worth naming: `code-references.test.ts` >
"still resolves a member call to a declaration in the same file" passed **no receiver**, so
what it asserted was that *any* member call resolves to a same-file homonym — the defect
itself, with a comment describing the case it did not test. It now passes `this`, and a
second case asserts the refusal for every other receiver. Corrected rather than deleted, and
not changed merely to make the suite green.

## Verified (Batch 6)
`lint && typecheck && build && vitest run`: **3491 passed, 7 skipped, 0 failed** (172 files, 357 s).
The run before it failed five and every one was real: two `boundaries` failures (the first
attempt at unifying the two spawners imported `git/runner.ts` from `environment/`, which the
core must not do), the packaging secret scan (a credentialled URI in a new comment), the
packaging size bound (+29 207 bytes, 0.50% over — measured on both sides and moved to
2 950 000 with the record the file's convention demands), and `credential-isolation` asserting
the old three-name `CREDENTIAL_ENV`, which is that test doing its job.
**F-92, F-73 and F-101 did not fire**: the wide-tree walk passed, packaging ran all 34 tests,
and `scale.test.ts` passed. F-101 *did* fire in the preceding run with identical code for that
test, which is the intermittent planner behaviour it already records.

## Verified (Batch 5)
`lint && typecheck && build && vitest run`: **3442 passed, 7 skipped, 1 failed** (170 files).
The failure is `scale.test.ts > scans rather than indexes when the whole table is wanted`:
PostgreSQL chose `Index Only Scan using entity_lifecycle_idx` over a sequential scan for
`SELECT count(*)`. **Not caused by Batch 5** — proved by running it with the changes stashed
(passes) and with them restored in isolation (passes); nothing in the batch touches SQL,
schema or query planning. Recorded as **F-101**, a new infrastructure finding of F-92's
class. F-92 and F-73 did not fire this run: the wide-tree walk passed and packaging
completed all 34 tests.

## Proved (Batch 7)
**12 of 20 fixture assertions red first**, each for the reason the finding names.
F-25: 5 of 9 — the resolver refused nothing and the parser reported no receiver.
F-25b/F-27: 5 of 6 — a moved call produced **two open intervals** ("expected [ {…}, {…} ] to
have a length of 1 but got 2"), `line` was in the edge's identity, a deleted call was still
asserted, and `referenceResolution` was undefined. The one green was the control that an
unchanged file's edges must not move, and it stayed green.
F-11: 2 of 5 — three commits by three people (Alice `<unknown>`, Bob `<unknown>`, Carol
`<carol@example.com>`) produced **two** developers, with the surviving display name decided by
Git's return order. Exactly the order-dependent merge the triage predicted.

Six second-order defects found by re-auditing and corrected: a second run would have rewritten
every gate-skipped file (AC-6), because the new attribute was not replayed from the artefact —
the same trap `structure` already documents; one database round trip per symbol in the retire
sweep; the sweep reporting nothing, so "closed none" and "never ran" were one observation; a
commit silently rolled back because the strict attribute schema had not been extended; two
orphaned doc comments from a bad splice; and a **vacuous assertion in my own fixture**
(`?? false` made a missing property read as the desired value, so it was green against the
defect it was written for).

## Proved (Batch 6)
Both fixtures are at the real boundary. F-94: a real repository, real `git`, assertions on
`readHistory`'s return value, every hostile case carrying a **control** that proves the vector
works without Ferret's overrides. **11 of 17 assertions red** — four repository-reachable
configuration paths (`.git/config`, a second encoding key, `include.path`, `config.worktree`)
and two environment-borne ones (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`) each returned
`[]` where three commits exist; `gpg.program` **executed**; no output-shape pins existed;
`parseHistoryOutput` did not exist. F-71: the surface measured against unchanged code —
**6 of 12** variables reached every `git` subprocess (`FERRET_DATABASE_URL`, `PGSERVICEFILE`,
`PGSSLKEY`, a URL-shaped `DATABASE_URL`, a token-named variable, and the password under a
name nothing lists), and `redactString` returned Ferret's own password verbatim; 29 of 31 red.

Eight second-order defects found by re-auditing and corrected: `gpg.program` as an
*execution* vector `SAFETY_CONFIG` missed; `GIT_CONFIG_GLOBAL`/`_SYSTEM` unstripped (fixed by
a prefix rule, not two more names); `incomplete.reason` repeating Git's stderr unredacted;
`redactVector` knowing one credential shape; **`PWD` stripped from every child** — found by
measuring against a real environment, and the reason every derived rule now carries a
preserved-half assertion; two spawners with two policies; a barrel declaring two controls no
production path reached (caught by `control-reachability.test.ts`); and a credentialled URI in
a shipped comment (caught by the packaging secret scan). A performance claim was also
corrected by its own measurement: the four rules cost ~0.05 ms, not the 0.73 ms first read —
copying `process.env` already cost 0.42 ms before any of this existed.

## Proved (Batch 5)
The fixture is at the **response** layer — an MCP client and server over an in-memory
transport with a hostile fake retrieval, asserting over the bytes a client receives. 8 of 9
assertions red before any implementation change: the pack led with `formatVersion` not
`notice`; the notice serialized at offset 2 674 against content at 612; the fence was
unbalanced; the trimmed value carried `CONTENT_OPEN` and no `CONTENT_CLOSE`;
`ferret_search` emitted 5 unfenced payloads; no `inspected` field existed; a developer's
`emails[0]` came back raw. The one that passed is the control that containment removes
nothing — it passed before and after, which is why it is there.

Six second-order defects found by re-auditing the green fix, each corrected:
`unknownFields`/`externalIds` uncontained on four surfaces; edge `metadata` uncontained on
both neighbour branches; a pack item's evidence `statement` uncontained; provider-supplied
`field`/`locator`/`sourceUrl`/producer uncontained **and interpolated into sentences Ferret
wrote** (which moved containment to the entry point); double containment then corrupting
the quotation with `[delimiter removed]` — self-inflicted, caught by an assertion written
to look for it; and two test-only checkers wrongly on the declared control surface, caught
by `control-reachability.test.ts`.

## Proved (Batch 1)
Fixture red before the fix for the four identified reasons (`missing: 5, commitsRead: 1000`
on 1 005 commits, unrepairable by re-run or `--full`; branch, skew and back-dated merge
losses). Green after. One self-inflicted defect found by re-auditing the fix — the
exclusion was carried only onto the first page — is now pinned by a unit test that fails
against it. One regression found and fixed: the report's `watermark` lost the previous
position on a resumed run (EPIC-108 AC-10).

- **F-23 — a corrupt worksheet is not an empty one** (`896bcaa`, branch
  `fix/f-23-corrupt-worksheet-silent-empty`, cut from `main`): a structural root check before
  the regex scanner, so "this is not a worksheet" (`unreadable-sheet`) and "this worksheet did
  not finish arriving" (`truncated-sheet`) are different facts and neither is silence; the
  workbook part refused on the path §8.5 already used for an absent one; and
  `SHEET_PARSER_VERSION` 1.0.0 → 1.1.0, which is what stops the cached silent-empty artefacts
  being replayed out of the store. Closes **F-23**.

- **Integration** (`23b92c7`, `3dc8181`, branch `integration/p1a-remediation` off `main`): the
  forensic branch and F-23 merged into one tree. They had been siblings off the same base —
  never integrated, so no ref had held both and neither branch's total described the
  combination. Zero conflicts, predicted before merging (88 changed files against 3, no
  overlap) rather than discovered during it. `--no-ff`, so each batch keeps its own commit.

- **F-27's read half** (`c696dac`): `ReferenceCompleteness` on `NeighbourResult` and
  `TraversalResult`, aggregated by the store from the counts Batch 7 persisted, bounded by the
  subject's repository and by the caller's scope grants, and rendered by `ferret_neighbours`
  beside `truncated` and `withheld` rather than folded into them. Closes **F-27**, the last
  open P1-A.

## Constraints in force
No new Epics. No Epic status changes. No PRs. No merge. No deploy. No changes to `main`.

## Verdict — QUALIFIED

Two questions, and collapsing them is how a green suite starts reading as permission to ship.

**Technical remediation status: COMPLETE.** The P0 and all 24 P1-A findings are closed on one
tree, validated together: 176 files, 3 542 passed, 7 skipped, 0 failed, exit 0, with lint,
typecheck and build clean. Each closure names the commit that made it and the test that holds
it — the discipline F-23 cost us. Every earlier per-branch total is superseded.

**Release / readiness status: QUALIFIED — not READY.** What is closed is closed; what remains
is that the tree has never been anywhere but this machine.

- ~~**It has run on one platform, once.**~~ **Closed.** CI ran on `fda7531` — Ubuntu, macOS,
  PostgreSQL 17 + pgvector, dependency audit, all pass — and again on merged `main`
  (`33864075157`), which adds Windows. **F-101 fired on that merged-`main` run**, and the
  useful part is what it turned out to be: not a flaky environment but a wrong assertion,
  pinning one of two valid query plans. Fixed. F-73 and F-92 did not fire, which still proves
  nothing about them.
- **Nothing has reviewed it.** No push, no PR, no second pair of eyes on 46 changed source
  files. Two of Batch 6's eight second-order defects were found by Ferret's own controls
  rather than by re-reading a diff, which is the argument for review, not against it.
- ~~**The merge is untested against a moving base.**~~ **Closed by the merge itself** — PR #153
  landed on an unmoved `main` and merged-`main` CI then ran on the result.
- ~~**F-102 is reachable and unclassified.**~~ **Fixed** in the post-merge cycle, on code
  reachability alone — the corpus question never needed answering, because a valid prefixed
  workbook reading as empty is wrong whatever its prevalence.
- **Partly closed. The upgrade path is verified end to end** —
  `tests/integration/storage/upgrade-deployment-path.test.ts` upgrades a *populated* pre-`0013`
  database, asserts the pre-upgrade rows survived, indexes a real git repository into it and
  reads entities and edges back; and asserts an upgraded installation reaches the same schema
  as one installed today, with data carried across. **Still unexercised:** a repository at a
  scale none of these fixtures reach, and `import` of a backup taken from a pre-`0013`
  installation — which is entangled with the undecided F-44/F-45.

None of these is a defect. They are the difference between *proven correct here* and *ready to
release*, and the record should not blur them.

**What is left, after the post-merge cycle:** human review of the diff, four isolated product
decisions (F-41/F-42, F-44, F-45, F-10), a scale surface, and a P2/P3 tail with no data-loss,
security or truthfulness consequence. The disposition of every one is at the foot of
`.agent/FINDINGS.md`.

## Next action
**Nothing. Stopped, as instructed.** Nothing pushed, no PR, nothing merged, nothing deployed;
`main` is untouched at `0407618`.

The owner decides whether and when this reaches `main`. What would move QUALIFIED to READY, in
the order it is cheapest to get: a CI run on the combined tree (Linux especially), review of
the diff, a classification decision on F-102, and a re-run of the gate after any rebase.

**The process lesson outlived the defect and is kept.** F-23 was marked CLOSED, propagated
through five documents, and survived a full audit without a line of code having changed. Every
CLOSED status in this record was re-checked the way F-23 finally was — against
`git log 0407618..HEAD -- <the module the finding names>` — and each finding's named module is
in the changed set. That check is the reason the current statuses are worth anything.

Still open and untouched: Batch 8 (record correction, no code); F-73, F-92, F-101 as
infrastructure findings; the 14 open P1-B; F-20 and F-21 as documentation work; F-102 as an
unclassified candidate.

## Open decisions for a human
1. F-21 — is GitHub/Jira ingestion meant to be reachable in this release, or library-only?
2. F-20 — same question for Session & Agent Memory.
3. F-10 — issue identity keying, best decided before any data exists.
