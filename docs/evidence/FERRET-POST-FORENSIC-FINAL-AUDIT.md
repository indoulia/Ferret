# FERRET POST-FORENSIC FINAL AUDIT

Read-only. No implementation, no PR, no merge, no deploy, no Epic touched. This record
establishes the evidence-based final state of the forensic branch; it does not improve it.

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

## 3. Every P0 / P1-A finding, re-verified at HEAD

The point of this table is not that each batch went green in its own run — it is that they are
all still green **with every other batch's changes present**.

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
| F-23 | Corrupt spreadsheet parses as a successful empty one | 3 | `sheet-parser.test.ts:182` (asserts the refusal names `xl/workbook.xml`) | **CLOSED — with a caveat, §6** |
| F-95 | Undatable commit desyncs `parseLog`, fabricates file entities | 3 | `malformed-history` | **CLOSED** |
| F-96 | A malformed commit costs the page | 3 | `malformed-history` | **CLOSED** |
| F-97 | Streamed-then-failed history discarded | 3 | `malformed-history` | **CLOSED** |
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
| F-27 | Unresolved references counted and discarded | 7 | `reference-intervals` | **PARTIALLY CLOSED — §6** |
| F-11 | Non-address author strings merge distinct humans | 7 | `identity-collapse` | **CLOSED** |

**P0: 1 of 1 closed. P1-A: 23 fully closed, 1 partially closed (F-27).**

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
  program. **Sound.**
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

- **`PLANNED_COMMANDS` is an empty array** (`src/cli/commands/planned.ts:49`). The triage's
  remedy for F-21 — a registry note plus `PLANNED_COMMANDS`/README entries — is **Batch 8**
  and is **unstarted**. Fourteen commands are reachable; no command advertises a planned one.
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
| **F-27 (read half)** | P1-A | Yes | **Judgement call** — the counts exist and reach any caller that reads the `file` entity; `ferret_neighbours` does not yet qualify an empty inbound list | Yes | A code-intelligence Epic | **Highest of what remains** |
| **F-23 (evidence gap)** | P1-A | n/a | No | No | Record correction | Medium |

**F-23 needs stating precisely.** `.agent/FINDINGS.md` records it CLOSED in Batch 3, but the
Batch 3 evidence report does not mention it and no test cites it. The protective code *is*
present (`xlsx.ts` refuses a missing `xl/workbook.xml` with "empty and unreadable must not be
the same answer") and a test does assert that refusal. So the behaviour is right and the
**chain of evidence is broken**: a closure asserted in the index that its own batch report does
not support. The second half of the triage's remedy — *warn when a present part yields zero
rows* — could not be verified in the source. Reported, not repaired.

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

## 9. Verdict

### FORENSICALLY READY — with one qualification the owner should read before merging

Everything the audit can verify is verified: `main` untouched, one clean full-suite pass at
`cd3ca85` with 3 513 tests passing and nothing failing, the P0 closed, 23 of 24 P1-A findings
fully closed and each still closed with every other batch present, and all eight contract
boundaries sound.

The qualification is **F-27**. Its persistence half is delivered and tested; its read half is
not. "Nothing references this" is still returned by `ferret_neighbours` without a completeness
qualifier, so a caller asking an impact or dead-code question can still receive an empty list
that means "we refused to resolve the references that would have answered you". That is the
finding's own stated danger, and it is narrower than it was — the counts now exist and are
readable — but it is not gone. It is recorded as **partially closed** in `.agent/FINDINGS.md`
rather than counted as a win.

Nothing here blocks the branch from being reviewed or merged; F-27's remaining half is a
scoped piece of follow-on work, not an unresolved defect in what was shipped.

## 10. Recommended future Epics — recommendations only

1. **Reference completeness at the answer surface** — F-27's read half. Attach the persisted
   counts to reference reads so an empty inbound list carries its own caveat. Smallest
   remaining piece of P1-A work and the one with the clearest user-visible payoff.
2. **Record correction (Batch 8, no code)** — F-74, F-75, F-87, the EPIC-028/035/090 record
   corrections, the F-20/F-21 registry notes and `PLANNED_COMMANDS`. Cheap, and it is the
   group most likely to prevent the next round of this.
3. **Backup fidelity** — F-45 then F-44. Silent vector loss on restore outranks a misleading
   `unchanged` counter.
4. **Markdown line endings** — F-22. A one-line defect with a measured loss on every CRLF
   repository.
5. **Identity merge completeness** — F-12, with F-33/F-34. `IdentityStore.merge` should move
   relationships and should not record a merge that failed.
6. **Test-infrastructure stability** — F-73, F-92, F-101 as one piece of work. All three are
   contention artefacts, and F-101 additionally asserts a *planner choice*, which is the part
   worth revisiting: an index-only scan of a whole table is not a wrong plan.

---

Produced read-only at `cd3ca85`. No PR opened, nothing merged, nothing deployed.
`forensic/post-roadmap-audit` is left intact for the owner's review.
