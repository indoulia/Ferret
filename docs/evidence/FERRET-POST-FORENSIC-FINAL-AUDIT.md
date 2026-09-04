# FERRET POST-FORENSIC FINAL AUDIT

Read-only. No implementation, no PR, no merge, no deploy, no Epic touched. This record
establishes the evidence-based final state of the forensic branch; it does not improve it.

> ## SUPERSEDED IN PART — read §11 first
>
> **This document is the audit as it was taken, at `cd3ca85` on `forensic/post-roadmap-audit`.**
> Its observations were true of that tree and are left standing, because how the conclusion was
> reached is part of the evidence. Two of them are no longer true of the current tree:
>
> | Recorded here at `cd3ca85` | Now, at `c696dac6` |
> | --- | --- |
> | F-23 **OPEN** — the blocker | **CLOSED** at `896bcaa` |
> | F-27 **PARTIALLY CLOSED** — read half open | **CLOSED** at `c696dac` |
> | Verdict **NOT FORENSICALLY READY** | **QUALIFIED** — see §11 |
>
> One scope error in this document is corrected in place rather than annotated, because it was
> a mislabelling and not an observation: §3's table was headed "Every P0 / P1-A finding" while
> carrying rows for **F-96 and F-97, which the triage rates P2**. The rows and their evidence
> are unchanged; the heading and the two IDs now say what they are.
>
> §11 records the combined tree, its validation, and the current verdict.
> `.agent/FINDINGS.md` is the current status of record.

> **Corrected after first issue — the verdict changed.** The first version of this audit
> recorded F-23 as closed with a broken evidence chain, and returned FORENSICALLY READY. On
> re-examination F-23 is **not closed at all**: no batch ever modified the module it is about,
> and the test the audit cited proves a different, pre-existing behaviour. The verdict is now
> **NOT FORENSICALLY READY**, blocked by F-23. §3, §6 and §9 are corrected; the test results in
> §2 are unchanged and were never in question. The correction is documentation only.

## 1. Baseline

| | |
| --- | --- |
| Branch | `forensic/post-roadmap-audit` |
| HEAD | `cd3ca85e2c9423bab495017927470d4ead666d42` |
| `main` | `0407618e2001435f2ec861f324ed75cd5e5e08be` — **untouched**, identical to the base the audit opened against |
| Working tree | clean at audit time (all Batch 7 work committed) |
| Commits since base | 9 (2 evidence, 7 implementation batches) |
| Diff since base | 78 files, ~9 400 insertions |
| Migrations | `0001`–`0013`; `0013_embedding_repair.sql` added by Batch 2, target schema version 12 → 13. No migration added by Batches 3–7 |
| Worktree | `C:\AIAgent\ferret-forensic`, separate from `C:\AIAgent\Ferret` (which remains on `main`) |

```
cd3ca85 fix(batch-7): what a call graph knows, and who wrote the code — the last implementation batch
f3795a4 fix(batch-6): the credential and safety enumeration — judged by what a thing is, not what it is called
0f109d9 fix(batch-5): the prompt-injection boundary — one fence, reaching everything, arriving first
cb39678 fix(context,retrieval,parsing): stop stating what cannot be supported          [Batch 4]
42c85ed fix(parsers,git): bound untrusted archives and isolate malformed objects       [Batch 3]
0c108c0 fix(storage): close four blockers in export, import and provisioning           [Batch 2]
bc33fb7 fix(indexing): resume history by reachability, and follow the page             [Batch 1]
4b555a3 docs(evidence): triage the 100 forensic findings
3e8862d docs(evidence): post-roadmap forensic verification
```

## 2. Full regression surface

`npm run lint && tsc --noEmit && npm run build && npx vitest run` — one clean pass at
`cd3ca85`, **exit 0**:

```
Test Files  175 passed (175)
     Tests  3513 passed | 7 skipped (3520)
  Duration  427.05s
```

Nothing failed. The 7 skips are structural and pre-existing: `docker.test.ts` (4 — the
registry-dependent cases) and `signals.test.ts` (3 — POSIX-signal cases on Windows). They are
not database skips: every PostgreSQL-backed suite ran.

Coverage of the surfaces the audit asks for, each confirmed present in this run:

| Surface | Evidence in this run |
| --- | --- |
| Packaging / install | `packaging.test.ts` **34 tests, all ran** (172 s) — F-73 did not fire |
| Storage / schema / migration | `storage/*` incl. `scale.test.ts` (19), `backup-fidelity`, `embedding-provisioning`, `migrations` |
| Indexing / retrieval | `indexing/*` incl. `history-completeness`, `content-indexing`, `reference-intervals` |
| Security / injection | `tests/security/*` — 9 files incl. `injection-boundary`, `credential-surface`, `git-output-integrity`, `control-reachability` |
| Identity / code intelligence | `identity-collapse`, `code-reference-truth`, `code-references`, `developer-identity` |
| Batch 1–7 forensic fixtures | all present and green (§3) |

**One failure occurred earlier in the batch and is recorded rather than hidden.** The run
before this one reported `1 failed | 3511 passed`: `code-references.test.ts > still resolves a
member call to a declaration in the same file`. Classification: **regression caused by
forensic work, and an intended one** — that test passed *no receiver*, so what it asserted was
that any member call resolves to a same-file homonym, which is F-25 itself. It was corrected
to assert the case its own comment describes, and a second case was added for the refusal.
Not deleted, and not weakened.

## 3. Every P0 / P1-A finding, re-verified at HEAD — plus two P2s closed alongside them

The point of this table is not that each batch went green in its own run — it is that they are
all still green **with every other batch's changes present**.

**Scope, corrected.** This table was headed as covering P0 and P1-A only, and two of its rows
are neither: **F-96 and F-97 are P2** (`FERRET-POST-FORENSIC-TRIAGE.md` §384-385, small
correctness), promoted into Batch 3 because they are the same defect class as F-95. They are
marked as such below and are **not** counted in the P1-A totals. The authoritative P1-A roster
is the triage's §9 table — 24 findings — enumerated in `.agent/FINDINGS.md`. With the two P2
rows set aside, the rows here and the count in the summary line agree.

| ID | Original failure | Batch | Regression test | Result |
| --- | --- | --- | --- | --- |
| **F-01** (P0) | History capped at 1 000 commits; watermark advanced to the newest of a newest-first page — permanent silent loss, unrecoverable by `--full` | 1 | `history-completeness`, `history-paging`, `observability` | **CLOSED** |
| F-02 | All branches share one watermark | 1 | `history-completeness` | **CLOSED** |
| F-03 | A future-dated commit stalls ingestion for ever | 1 | `history-completeness` | **CLOSED** |
| F-04 | Back-dated merge → parentless stub commits | 1 | `history-completeness` | **CLOSED** |
| F-16 | `init` migrates before pgvector; unrepairable, version lies | 2 | `embedding-provisioning` | **CLOSED** |
| F-17 | Export writes a backup import refuses | 2 | `backup-fidelity` | **CLOSED** |
| F-29 | Document-supplied column names interpolated into SQL | 2 | `backup-fidelity` | **CLOSED** |
| F-30 | Database password to stdout, exit 0 | 2 | `export.test.ts` | **CLOSED** |
| F-60 | ZIP bound trusts the archive's declared size | 3 | `sheet-parser` | **CLOSED** |
| F-61 | `.docx` bypasses the bounded reader | 3 | `docx-parser` | **CLOSED** |
| F-23 | Corrupt spreadsheet parses as a successful empty one | **none at `cd3ca85`** | none then; `sheet-corruption` now | **OPEN here — CLOSED at `896bcaa`, §11** |
| F-95 | Undatable commit desyncs `parseLog`, fabricates file entities | 3 | `malformed-history` | **CLOSED** |
| F-96 *(P2)* | A malformed commit costs the page | 3 | `malformed-history` | **CLOSED** — not P1-A |
| F-97 *(P2)* | Streamed-then-failed history discarded | 3 | `malformed-history` | **CLOSED** — not P1-A |
| F-05 | `plan.partial` constant | 4 | `answer-pack`, `mcp/tools` | **CLOSED** |
| F-06 | Supersession collapsed a collection | 4 | `evidence-store` | **CLOSED** |
| F-24 | Byte spans point at the wrong bytes | 4 | `span-fidelity` | **CLOSED** |
| F-28 | Per-hop `LIMIT` truncation reported as complete | 4 | `traversal`, `mcp/tools` | **CLOSED** |
| F-31 | Withheld rows dropped silently; `truncated: false` on a partial answer | 4 | `mcp/tools` | **CLOSED** |
| F-32 | Trim cut the closing containment delimiter | 5 | `injection-boundary`, `untrusted-content` | **CLOSED** |
| F-64 | Containment reached top-level strings of one field only | 5 | `injection-boundary`, `containment` | **CLOSED** |
| F-66 | Content notice last, under a key no other tool used | 5 | `injection-boundary`, `mcp/tools` | **CLOSED** |
| F-94 | Repository-controlled Git config reshapes `git log` | 6 | `git-output-integrity` | **CLOSED** |
| F-25 | Member call → same-file homonym at STRONG | 7 | `code-reference-truth`, `code-references` | **CLOSED** |
| F-25b | Duplicate open intervals; content edges never retired | 7 | `reference-intervals` | **CLOSED** |
| F-27 | Unresolved references counted and discarded | 7 | `reference-intervals`, `mcp/tools` | **PARTIAL here — CLOSED at `c696dac`, §11** |
| F-11 | Non-address author strings merge distinct humans | 7 | `identity-collapse` | **CLOSED** |

**At `cd3ca85` — P0: 1 of 1 closed. P1-A: 22 fully closed, 1 partially closed (F-27), 1 open
(F-23).** 22 + 1 + 1 = 24, the triage's roster. The two P2 rows above are additional to it.
**At `c696dac6` — P0: 1 of 1. P1-A: 24 of 24 closed.** See §11.

Cross-batch interactions specifically checked and green in the same run: Batch 3's record
marker with Batch 6's encoding pins (`git-output-integrity` + `malformed-history`); Batch 5's
containment with Batch 6's redaction (`injection-boundary` + `credential-surface`); Batch 1's
watermark with Batch 7's retire sweep (`history-completeness` + `reference-intervals`);
Batch 2's export redaction with Batch 6's value-based redaction (`export` + `credential-surface`).

## 4. Contracts, re-audited as a whole

- **Ingestion completeness** — resume by reachability, page cursors followed to the end,
  malformed regions isolated per commit, and a Git output region Ferret cannot read now makes
  the page `incomplete` rather than short. **Sound.**
- **Storage / install integrity** — provisioning before migration, a repair for installations
  past it, export/import round trip verified against a real database. **Sound.**
- **Untrusted-input safety** — ZIP bound enforced on real bytes, `.docx` through a bounded
  reader, git records found by a marker, hostile `.git/config` cannot reshape output or run a
  program. **Sound at the archive and Git boundaries; not sound inside the worksheet reader** —
  F-23 is open, so a corrupt `.xlsx` worksheet part is still indistinguishable from an empty
  one and the result is still cached permanently.
- **Answer truthfulness** — Ferret now distinguishes *none* / *unknown* / *withheld* /
  *truncated* / *incomplete* / *stale*. **One gap:** *unresolved* is persisted but not
  surfaced on reference reads (§6, F-27). Everything else is sound.
- **Prompt-injection boundary** — the fence survives truncation, containment recurses with a
  depth bound and counts every leaf, the notice arrives first. Verified at the response layer
  through a real MCP client/server. **Sound.**
- **Credential safety** — four derived rules, verified at the `execFile`/`spawn` boundary for
  all three spawners, with arguments refused and registered values removed from every string
  that leaves the process. **Sound.**
- **Identity integrity** — an address that is not an address mints no actor, after the
  mailmap, with the observation preserved on the commit. **Sound.**
- **Code-intelligence truth** — homonyms need corroboration, one call site is one interval, a
  deleted call is closed. **Sound, with F-27's read half outstanding.**

## 5. Reachable seams

Reported as the evidence supports, and nothing was implemented to close a gap.

- **`PLANNED_COMMANDS` is an empty array** (`src/cli/commands/planned.ts:49`), so
  `program.ts:96` adds nothing and no command advertises a capability as forthcoming. What
  the evidence establishes:
  - **Shipped and reachable:** fourteen commands registered at `program.ts:82-95` —
    `version`, `config`, `doctor`, `env`, `index`, `init`, `mcp`, `status`, `verify`,
    `prune`, `export`, `import`, `reconcile`, `upgrade`. All exercised by the suite.
  - **Library-only by design:** the GitHub and Jira providers, project modelling, event and
    webhook verification, and the session/memory modules. Each is real and tested as a module;
    none has transport, persistence or a client surface, and each Epic excluded those by name.
    These are not half-built features — they are the scope their Epics declared.
  - **The gap is a missing statement, not missing code.** Nothing tells an operator which
    capabilities are library-only, because the mechanism for saying so is empty and the
    registry notes were never written. That is **Batch 8, documentation only** and unstarted.
    Writing those entries is in scope for it; building `ferret sync`, a session store,
    transport or client wiring is not, and was ruled out by the triage.
- **F-21 (GitHub/Jira ingestion unreachable) and F-20 (Session & Agent Memory unreachable)**
  remain true and remain **documentation findings**. Every Epic in those clusters excludes
  transport and persistence by name; the modules deliver their stated scope. Building a
  `ferret sync` or a session store was and remains out of scope.
- **EPIC-077 (webhook signature verification)** — verified clean in the original forensic pass
  and unchanged by any batch.
- **EPIC-072 (project modelling)** — pure and reachable as a library; F-09 (an unmerged pull
  request recorded as proposing a merge commit) is P1-B and open.
- **EPIC-041** — its own validation record already states "Nothing persists a checkpoint". The
  aggregate statement across the five session Epics is still made nowhere, which is F-20.

## 6. Remaining findings

Nothing below was fixed, and nothing below should be read as fixed.

### Carried openly out of the closed set

| ID | Severity | Reachable today | Production-blocking | Needs code | Belongs in | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| **F-23** | P1-A | **Yes — ordinary content triggers it** | **Yes** — silent permanent omission | Yes | An untrusted-input Epic | **Blocker** |
| **F-27 (read half)** | P1-A | Yes | No — the counts exist and reach any caller that reads the `file` entity; only the tool surface lacks the caveat | Yes | A code-intelligence Epic | Highest of the non-blocking remainder |

> **Both are now closed — §11.** The "production-blocking: No" judgement on F-27's read half
> above is left as written and is worth disagreeing with in hindsight: the finding's declared
> harm lives entirely on the read side, and the surface did not merely omit a caveat — it
> populated `truncated: false` and `withheld: 0`, affirmatively claiming a completeness it had
> not established. That is the F-31 pattern, which the triage rates P1-A.

### F-23 — open at `cd3ca85`, and the earlier record of it was wrong *(superseded: CLOSED at `896bcaa` — §11)*

The first version of this audit called F-23 closed-with-a-broken-evidence-chain. That was too
generous by one step, and the step matters. The evidence, taken from the source rather than
from any report:

- `git log 0407618..HEAD -- src/parsers/sheet/xlsx.ts` returns **nothing**. No batch modified
  the module the finding is about. Batch 3 changed `src/parsers/sheet/zip.ts` — the archive
  bound, which is F-60 — and `sheet-parser.test.ts` for that, which is why a keyword search
  made Batch 3 look like the closer.
- `readSheet` (`xlsx.ts:237-271`) is still the regex scanner the finding cites at `:243`,
  `:247` and `:270`, with no validity check anywhere in it. A truncated, garbage or non-XML
  worksheet part still produces zero rows and the same return shape as a genuinely empty
  sheet, and the content gate still caches that result permanently.
- **The test cited before proves something else.** `sheet-parser.test.ts:182` asserts that a
  missing `xl/workbook.xml` is refused by name — AC-9. Real, passing, and not this finding:
  the finding's own text says *"Only a missing `xl/workbook.xml` throws (`:80-88`)"* and
  names that as the pre-existing behaviour the rest of the module fails to match. Citing it
  conflated the one case that already worked with the five measured cases that did not.
- Neither half of the triage's remedy is present: no refusal for a part with no recognisable
  root, and no warning when a present part yields zero rows.

**Status at `cd3ca85`: OPEN.** Severity unchanged at P1-A, data-loss class. Not fixed here, and
this task forbade fixing it.

**Status now: CLOSED** at `896bcaa05c889c2de6af9c67db364121bcd61217`. Every claim above was
accurate when written and every one of them has since been addressed — including the last: both
halves of the triage's remedy were considered, one shipped, and the departure is recorded
rather than glossed. §11 has the evidence.

### F-27 — partially closed at `cd3ca85`, and recorded that way *(superseded: CLOSED at `c696dac` — §11)*

- **Persistence half — closed and verified.** The counts are written onto the `file` entity,
  replayed through the re-parse gate, and asserted end to end against a real database by
  `reference-intervals.test.ts` (three cases, including the gate-skip regression).
- **Read half — open.** Verified at `cd3ca85`: `referenceResolution` appears nowhere under
  `src/mcp/`, `src/retrieval/` or `src/context/`, and the depth-1 `ferret_neighbours`
  response carries `count`, `truncated` and `withheld` with no resolution field. An empty
  inbound list still arrives without a completeness caveat.

### P1-B (14 open)

**F-07, F-08, F-09, F-10, F-12, F-13, F-14, F-15, F-18, F-19, F-22, F-26, F-65, F-67.**
F-71 closed in Batch 6. Severity P1-B; most are **not reachable today** because the code
around them is not wired (the F-20/F-21 clusters); none is production-blocking in the shipped
surface; all need code; each is cheapest at the moment its code becomes reachable. Two are
reachable now and deserve naming: **F-22** (every ATX heading in a CRLF Markdown file
silently reclassified as prose — measured `LF headingCount=3` vs `CRLF headingCount=1`) and
**F-12** (`IdentityStore.merge` moves aliases but no relationships, and records the merge even
when it failed). Recommended priority: F-22 first — it is a one-line parser defect with a
measured user-visible loss.

### F-44 and F-45 (P2, storage)

- **F-44** — export's line-level redaction rewrites indexed values while exporting
  `content_hash` unchanged; `sameContent` compares only the hash, so re-import reports
  `unchanged`. **Not closed by F-17**, recorded as a dependency in the triage and still true.
  Reachable, not blocking, needs code.
- **F-45** — `EXPORT_TABLES` omits `ferret.embedding` and `ferret.instance`, so a restore
  silently drops every vector and mints a new instance identity. Reachable, needs code.
  Priority: above F-44, because silent data loss on restore outranks a misleading counter.

### P2 / P3 (≈60)

Groups unchanged from the triage §4: documentation drift (highest value), identity hardening,
retention lifecycle, provider platform, audit/observability, session values, benchmark
honesty, test integrity, small correctness. None reachable-and-blocking. **Batch 8 — record
correction, no code — is unstarted**, and it is the group most likely to prevent the next
round of this.

### Infrastructure findings — separately classified, none reproduced

| ID | Status in this run | Classification |
| --- | --- | --- |
| **F-73** packaging `beforeAll` exceeds its 300 s hook timeout under contention | **Did not reproduce** — all 34 tests ran (172 s) | **OPEN.** The defining condition is contention; a passing run does not disprove it |
| **F-92** `discovery.test.ts > walks a wide tree within budget` exceeds 30 s under contention | **Did not reproduce** — 38 tests passed (229 s) | **OPEN**, same reasoning |
| **F-101** `scale.test.ts` planner choice | **Did not reproduce** — 19 tests passed | **OPEN**, same reasoning. It fired in Batch 5's run and in one Batch 6 run, with identical code for that test in the run where it passed — which is what makes it intermittent rather than a regression |

None is a regression caused by forensic work, and none was touched.

### New findings from Batch 7 and this audit

1. **F-27's read half is undelivered** (§6 above) — the only one that changes a status.
2. **F-23's evidence chain is broken** (§6 above).
3. **`PLANNED_COMMANDS` is empty** while the triage's F-21 remedy assumes entries in it —
   Batch 8 work, documentation only.

No new *code* defect was discovered by this audit that a batch had not already found.

## 7. Interaction regressions specifically hunted

Each combination the brief names was checked against this run rather than assumed from the
batch that owns one side of it:

| Combination | Where it is exercised | Result |
| --- | --- | --- |
| Bounded readers + parsers | `sheet-parser`, `docx-parser`, `pdf-parser`, `parser-framework` | clean |
| Malformed Git objects + pagination/watermarks | `malformed-history` + `history-completeness` | clean |
| Incomplete reads + persistence | `history-completeness`, `credential-surface` (corrupt-object page) | clean |
| Redaction + binary/JSON data | `export`, `redaction-parity`, `credential-surface` | clean |
| Credential isolation + child-process environment | `credential-surface`, `credential-containment`, `credential-isolation` | clean |
| Containment + truncation | `injection-boundary` | clean |
| Containment + nested metadata | `containment`, `injection-boundary` | clean |
| Identity normalisation + re-indexing | `identity-collapse`, `content-indexing` (second run) | clean |
| Symbol resolution + unresolved references | `code-reference-truth`, `reference-intervals` | clean |
| Duplicate/overlapping edges + later indexing | `reference-intervals` (move, delete, unchanged control) | clean |
| Migrations + fresh install + upgrade | `migrations`, `embedding-provisioning`, `upgrade` | clean |
| Backup + restore + current schema | `backup-fidelity`, `export`, `import` | clean |
| Answer truthfulness + retrieval truncation | `traversal`, `mcp/tools`, `answer-pack` | clean |

## 8. Data and index integrity

Batch 7 changed persisted semantics, so this is checked rather than assumed —
`reference-intervals.test.ts` inspects the resulting rows in a real database:

- **No duplicate relationships.** A call moved four lines down produces the *same* count of
  open intervals as before the move. Before Batch 7 it produced two for one fact.
- **No duplicate entities.** A second run over unchanged content writes no rows — asserted by
  `content-indexing` AC-6 and by the new gate-replay case, which exists because the first
  version of the F-27 fix would have rewritten every gate-skipped file.
- **No identity collapse.** Two authors with no address produce no shared developer and no
  developer at all; ordinary authors still collapse correctly across addresses, and
  subaddressing is still stripped.
- **Unresolved references remain distinguishable.** Counts are held by reason, so
  `receiver-unknown` (a refusal Ferret can explain) and `not-found` (an absence) are separate
  numbers.
- **Existing relationships intact.** The unchanged-file control asserts the edge rows are
  byte-identical across two runs — the assertion that would catch a retire sweep closing what
  it should not.
- **Re-index results.** Move, delete and no-change are each exercised end to end.

No production data was touched. All verification ran against throwaway containers.

## 9. Verdict *(as at `cd3ca85`; superseded by §11)*

### NOT FORENSICALLY READY — blocked by F-23

Most of what the audit set out to establish is established: `main` untouched, one clean
full-suite pass at `cd3ca85` with 3 513 tests passing and nothing failing, the P0 closed,
22 of 24 P1-A findings fully closed and each still closed with every other batch present, and
seven of the eight contract boundaries sound.

**What blocks readiness is F-23, and only F-23.** A corrupt `.xlsx` worksheet part is still
parsed as a successful empty spreadsheet, and the content gate still caches that result
permanently — so the file is never re-read and its contents are silently and permanently
absent from the index. It is P1-A, data-loss class, reachable with ordinary content, and it
was carried as CLOSED through five batches and the first version of this audit on the strength
of a test that proves a different behaviour. No batch ever touched the module.

That last part is the more useful finding. The defect is one module; the *process* failure is
that a finding could be marked closed, propagate through five documents, and survive an audit,
without a single line of code having changed. The remedy for the class is the same one this
audit applies to itself: a closure claim names the commit that made it and the test that holds
it, or it is not a closure claim.

**F-27 does not block.** Its persistence half is delivered and tested; its read half is
follow-on work at the tool surface, with the data it needs already stored. It is recorded as
**partially closed**, not as a win and not as a blocker.

**Recommendation.** The branch is worth reviewing and the seven batches are worth keeping —
nothing in them is undone by this. But F-23 should be closed for real, with its own red
fixture, before this reaches `main`; and every remaining CLOSED status should be spot-checked
the way F-23 finally was, against `git log -- <the module the finding names>`.

## 10. Recommended future Epics — recommendations only

> **Items 1 and 2 have since been done** — §11.3 and §11.4. They are left as written because a
> recommendation that was acted on is evidence about the recommendation. Items 3 to 7 stand.

1. ~~**F-23 — the blocker.**~~ **DONE — `896bcaa`, §11.3.** Refuse a worksheet part with no recognisable root, and warn when a
   present part yields zero rows. Needs a red fixture across the five corruptions the finding
   measured, and a check that the content gate does not cache a refusal as an empty result.
2. ~~**Reference completeness at the answer surface**~~ **DONE — `c696dac`, §11.4.** F-27's read half. Attach the persisted
   counts to reference reads so an empty inbound list carries its own caveat. The data is
   already stored, so this is presentation rather than measurement.
3. **Record correction (Batch 8, no code)** — F-74, F-75, F-87, the EPIC-028/035/090 record
   corrections, the F-20/F-21 registry notes and `PLANNED_COMMANDS`. Cheap, and — on the
   evidence of F-23 — the group most likely to prevent the next round of this.
4. **Backup fidelity** — F-45 then F-44. Silent vector loss on restore outranks a misleading
   `unchanged` counter.
5. **Markdown line endings** — F-22. A one-line defect with a measured loss on every CRLF
   repository.
6. **Identity merge completeness** — F-12, with F-33/F-34. `IdentityStore.merge` should move
   relationships and should not record a merge that failed.
7. **Test-infrastructure stability** — F-73, F-92, F-101 as one piece of work. All three are
   contention artefacts, and F-101 additionally asserts a *planner choice*, which is the part
   worth revisiting: an index-only scan of a whole table is not a wrong plan.

---

Produced read-only at `cd3ca85`. No PR opened, nothing merged, nothing deployed.
`forensic/post-roadmap-audit` is left intact for the owner's review.

---

## 11. Addendum — the combined tree at `c696dac6`

Everything above was produced at `cd3ca85` and is left as it was written. This section records
what changed after it, and it is the current statement. Documentation only: no source or test
was modified to produce it.

### 11.1 The remediation set now exists on one ref, and it is not `main`

§9 recommended F-23 be closed for real before the branch reached `main`. That happened, and it
exposed something §1 could not have seen: the F-23 fix was cut from `main`, not from the
forensic branch, so the two remediation sets were **siblings off the same base** — never
integrated, never built together, and neither branch's suite total described the combination.

```
main                            0407618  ← contains NONE of these fixes
├── forensic/post-roadmap-audit  6439449  ← Batches 1-7, and this document
├── fix/f-23-…                   896bcaa  ← F-23 only
└── integration/p1a-remediation  c696dac  ← both, merged; then F-27's read half
```

`git merge-base` of the two source branches is `0407618`. Both merges (`23b92c7`, `3dc8181`)
were `--no-ff` so each batch keeps its own commit and its own evidence, and **both conflicted
in nothing** — the changed-file sets are 88 and 3 with zero overlap, established before merging
rather than discovered during it. The one semantic pairing worth naming was tested rather than
assumed: F-23's new structural guard in `xlsx.ts` reads parts through `zip.ts`, which Batch 3
rewrote for F-60.

**`integration/p1a-remediation` at `c696dacff7e9b0ea57329b5b106367764d544ff2` is the first
combined tree ever validated after integrating the forensic remediation and F-23.** `main`
remains `0407618` and contains none of it.

### 11.2 Validation — the first valid numbers for the remediation set

| Point | Files | Tests | Result |
| --- | --- | --- | --- |
| forensic alone, `cd3ca85` (§2) | 175 | 3 513 passed, 7 skipped | stale — no F-23 |
| F-23 alone, `896bcaa` | 164 | 3 395 passed, 7 skipped | stale — no batches |
| integrated, `3dc8181` | 176 | 3 528 passed, 7 skipped | exit 0 |
| **with F-27's read half, `c696dac6`** | **176** | **3 542 passed, 7 skipped (3 549)** | **0 failed, exit 0** |

Lint (`eslint .`) clean · typecheck (`tsc --noEmit`) clean · build/package clean — 13
migrations, 4 grammars, golden datasets copied, and `packaging.test.ts` ran all 34 tests.
**No migration was added** by the integration or by F-27; the schema is Batch 2's `0013`.

The integration totals are **exactly additive** — 175 + 1 files, 3 513 + 15 tests — which is
the load-bearing result rather than the reassuring one: the two remediation sets do not
interact, and nothing was lost or double-counted in the merge.

The 7 skips are the same structural ones §2 records: `docker.test.ts` (4, registry-dependent)
and `signals.test.ts` (3, POSIX signals on Windows). No database suite skipped. **F-73, F-92
and F-101 did not fire** in any of these runs, which — as those findings say of themselves —
does not disprove an intermittent condition.

### 11.3 F-23 — CLOSED

`896bcaa05c889c2de6af9c67db364121bcd61217`. `rootStructure` checks a part is the document it
claims to be before the regex scanner reads it, and checks the *closing* tag too, so "this is
not a worksheet" (`unreadable-sheet`) and "this worksheet did not finish arriving"
(`truncated-sheet`) stay different facts. `xl/workbook.xml` takes the refusal path §8.5 already
used for an absent part. `SHEET_PARSER_VERSION` moves 1.0.0 → 1.1.0, which is what stops the
cached silent-empty artefacts being replayed — a two-link chain, both links asserted
(`sheet-corruption.test.ts` pins the version off 1.0.0; `content-gate.test.ts:264` drives
exactly 1.0.0 → 1.1.0 for AC-7).

Coverage: **15 new cases** in `tests/unit/sheet-corruption.test.ts`; **45 focused sheet tests
green**, independently re-run rather than taken from the commit message. A genuinely empty
sheet stays warning-free, and the control asserting so is what keeps the caveat meaningful.

One departure from the triage's remedy is recorded rather than glossed: it asked to refuse a
rootless part **and** to warn when a present part yields zero rows; only the first shipped,
because a warning on every empty sheet is the always-on caveat F-66 already taught us not to
add. The residual the second half would also have caught is **F-102**, §11.5.

### 11.4 F-27 — CLOSED, both halves

- **Persistence half** — Batch 7, `cd3ca85`, as §6 records. Unchanged.
- **Read half** — `c696dac`. `ReferenceCompleteness` on `NeighbourResult` and
  `TraversalResult`, aggregated by the store from those persisted counts, bounded by the
  subject's repository and by the caller's scope grants, rendered by `ferret_neighbours` on
  both the depth-1 and depth>1 branches.

**The false-completeness regression, reproduced then green.** The defect was that `count: 0`,
`truncated: false` and `withheld: 0` — three fields that between them assert an answer is
whole — were returned over a graph Ferret had declined to finish resolving.

| Layer | Red first | Green after |
| --- | --- | --- |
| `tests/integration/mcp/tools.test.ts` | **6 of 7** — first message `an empty reference answer carried no completeness at all: expected undefined to be defined` | yes |
| `tests/integration/indexing/reference-intervals.test.ts` (real PostgreSQL, `git`, grammars) | **2 of 4** — the two defect cases | yes |

Both red sets were produced by stashing only `src/` and re-running the same assertions, so red
and green differ by the implementation and nothing else. The assertions that passed on both
sides are controls and are not claimed as red-first: the noise control (a verdict must **not**
appear on a question that is not about references) and read idempotency across a second index
run.

**The five states are kept apart** — the property the finding is actually about:

| State | How the surface says it |
| --- | --- |
| genuinely no relationships | `count: 0` with `references.completeness: "complete"` |
| unresolved references | `completeness: "incomplete"` + `unresolved.{total, refused, byReason}` |
| withheld relationships | `withheld: n` — unchanged, EPIC-058 |
| truncated results | `truncated: true` + `more` — unchanged, F-28 |
| unmeasured completeness | `completeness: "unknown"`, `filesMeasured: 0` — never `complete` |

`unknown` is a third verdict, not a shading of `complete`: an index built before F-27, or one
whose content stage never ran, has earned no verdict, and issuing a clean bill of health it
never sat for would be this finding one layer along. Existing cardinality, truncation and
withholding semantics are preserved, and one test asserts all four hold simultaneously.

The verdict derives from the **reasons**, not the total. `ambiguous`, `receiver-unknown` and
`imported` are refusals over candidates Ferret holds, so any could be the missing edge —
`imported` most of all, since an import names a symbol the repository very probably declares
and §8.4 does not follow it. Only `not-found` is a true absence. Every reason is still
reported; the derivation is Ferret's and the numbers let a caller disagree.

Two second-order defects found by re-auditing the fix, both corrected: a comment claiming a
drift-guard test that did not exist (now written), and a verdict computed on every unfiltered
traversal — the default path — now gated on the subject being an end of a reference edge.

### 11.5 F-102 — a candidate, unclassified, outside the remediation set

**Not P1-A. Not implemented. Not part of the closed set.** Recorded so it is not mistaken for
either a closure or a blocker.

`rootStructure` accepts a namespace-prefixed root so legitimate prefixed workbooks are not
refused — the right call — but the extractors one level down are not prefix-aware
(`xlsx.ts:197` `/<sheet\b/`, `:295` `/<row\b/`, `:300` `/<c\b/`). The guard says "this is a
valid worksheet" and the extractor then reads nothing from it. Executed against the built
parser: a fully prefixed workbook returns `{"sheets":[],"warnings":[]}`, and a prefixed
worksheet holding one real cell returns one sheet with zero rows and no warnings — F-23's exact
signature on files that are **not corrupt**. The control case (the corruption F-23 fixes) warns
correctly.

**Not a regression from F-23**: the gap pre-dates it, and `sheet-corruption.test.ts` documents
it in a doc comment rather than concealing it.

**Why severity is withheld.** Code reachability is proved; *input* reachability is not. Excel,
SheetJS and Apache POI all emit unprefixed SpreadsheetML. Classification needs a survey of the
`.xlsx` producers in the target corpus, a scan for a prefixed root in `datasets/` and any real
corpus, and a decision on whether "silently empty on a file we chose not to refuse" is
acceptable at all — if it is not, the unshipped half of F-23's remedy is the cheaper and more
general fix than prefix-aware regexes.

### 11.6 Verdict — QUALIFIED

Two questions, and collapsing them is how a green suite starts reading as permission to ship.

**Technical remediation status: COMPLETE.** The P0 and all **24 of 24** P1-A findings are
closed on one tree and validated together — 176 files, 3 542 passed, 7 skipped, 0 failed, exit
0, lint/typecheck/build clean. Each closure names the commit that made it and the test that
holds it, which is the discipline §9 asked for and F-23 paid for. Every CLOSED status was
re-checked the way F-23 finally was — `git log 0407618..HEAD -- <the module the finding
names>` — and each finding's named module is in the changed set.

**Release / readiness status: QUALIFIED. Not READY, and P1-A being closed is not by itself an
argument that it should be.** What is closed is closed; what remains is that this tree has
never been anywhere but one machine.

- **One platform, one pass.** Windows. CI has never seen this tree, and Linux is where
  `git-output-integrity`'s `gpg.program` execution vector actually demonstrates — on Windows it
  self-reports as not exercised. F-73, F-92 and F-101 are open contention artefacts that did
  not fire, which proves nothing about them.
- **Unreviewed.** No push, no PR, no second pair of eyes over 46 changed source files. Two of
  Batch 6's eight second-order defects were found by Ferret's own controls rather than by
  re-reading a diff — an argument for review, not against it.
- **Untested against a moving base.** `main` has not advanced since `0407618`, but local green
  goes stale the moment it does; the gate is re-run after a rebase, not before.
- **F-102 is reachable and unclassified** — the same silent-omission signature as F-23, on
  files that are not corrupt.
- **Deployment surfaces unexercised** — `upgrade`/`import` against an installation predating
  `0013`, and a repository at a scale none of these fixtures reach.

None of these is a defect. They are the distance between *proven correct here* and *ready to
release*, and this record should not blur them. What would move QUALIFIED to READY, cheapest
first: a CI run on the combined tree, review of the diff, a classification decision on F-102,
and a re-run of the gate after any rebase.

---

§11 produced as documentation only at `c696dac6`. Nothing pushed, no PR opened, nothing merged,
nothing deployed; `main` untouched at `0407618`.
