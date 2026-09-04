# Ferret — Post-Forensic Triage

**Status: COMPLETE** · Triage of `FERRET-POST-ROADMAP-FORENSIC.md` · Base `0407618` · 2026-09-03

> Triage only. No `src/`, test or migration file was modified. No Epic status was changed,
> no Epic was created, nothing was merged, pushed to `main`, or deployed.

## 1. Executive summary

100 verified findings triaged. **Report severity is not triage priority** — severity says how
wrong something is, priority says what it means for shipping. Seven findings the report rated
P2 are promoted here because they are reachable today from untrusted input (F-60, F-61, F-64,
F-66 → P1-A; F-65, F-67, F-71 → P1-B), and two the report rated P1 are demoted to
documentation (F-20, F-21) on the evidence of the Epics' own Non-scope sections.

| Bucket | Count | Meaning |
| --- | --- | --- |
| **P0** | 1 | Immediate correctness/data-integrity blocker |
| **P1-A** | 24 | Production blocker |
| **P1-B** | 15 | Significant, safely deferrable |
| **P2/P3** | 60 | Hardening, documentation, verification integrity |

**Production blockers: 25** (P0 + P1-A). They fall into six coherent batches, not
twenty-five separate pieces of work.

Three structural observations drive the triage:

1. **Silent data loss is the dominant blocker class**, and it is concentrated in one
   subsystem. F-01, F-02, F-03, F-04 are four expressions of a single decision — resume by
   *date* rather than by *reachability*, and advance the cursor from a bounded page. One
   design change closes three of them.
2. **The second blocker class is "Ferret asserting what it does not know"** — F-05, F-06,
   F-23, F-24, F-25, F-27, F-28, F-31, F-95. These matter more than their individual
   severities suggest, because the product's differentiator is that its answers are
   evidence-backed. A wrong citation is worse than a missing one.
3. **Most of the remaining P1s live in code no client reaches** (F-08 through F-15, F-18,
   F-19). They are real defects in `VALIDATED` Epics and they are not production blockers
   today. They become blockers the moment an integration Epic wires that code up, which is
   the right time to fix them — and the cheapest, since the integration work will trip over
   them immediately.

**Nothing found is exploitable by a remote unauthenticated attacker.** The two security
findings with real reach (F-29, F-94) both require the operator to feed Ferret an artefact
they did not author — an import document, or a repository directory whose `.git/config` an
attacker controls. That is the threat model `SAFETY_CONFIG` already adopts, so it is in
scope, but it is not an internet-facing exposure.

## 2. P0 / P1-A blockers

Full records for the P0 and for every finding on the priority list; the remaining P1-As are
tabulated after them.

---

### F-01 — history truncation / watermark data loss

| Field | Assessment |
| --- | --- |
| Severity | **P0** |
| Category | IMPLEMENTATION DEFECT — silent data loss |
| Production impact | Every repository over 1 000 commits is permanently indexed with only its newest 1 000. Ferret's core dataset is incomplete on essentially every real repository. |
| Exploitability | None needed. Default path, no flags, no attacker. |
| User-visible impact | None — that is the defect. Exit 0, no warning, no `truncated` in the report. |
| Data-loss risk | **High and unrecoverable in place.** `--full` cannot reach the lost commits either. |
| Violates explicit EPIC claim | Yes — EPIC-031 AC-4 ("`--full` re-reads everything"). |
| Depended on by | F-03 and F-04 share the resume design; F-04's placeholder stubs are the visible residue. EPIC-032 tombstones depend on the deleting commit being read. |
| Recommended action | Declare `cursor` on `IndexableSource.readHistory` and page until absent; **or** advance the watermark to `min(committedAt)` of a truncated page and surface `historyTruncated`. Prefer the reachability rewrite (see F-04) which subsumes F-03. |
| Priority | **P0 — fix first, before anything else.** |

---

### F-16 — `ferret init` migrates before it provisions pgvector

| Field | Assessment |
| --- | --- |
| Severity | **P1-A** |
| Category | IMPLEMENTATION DEFECT — schema state records something that did not happen |
| Production impact | On every fresh install, migration `0008` takes its early-return branch and is recorded as applied. `ferret.embedding` does not exist and `readSchemaStatus` reports `12/12, pending 0`. |
| Exploitability | None needed. |
| User-visible impact | **None today** — Ferret ships no embedding provider (F-67), so nothing reads the table; the planner already skips semantic search. The visible symptom only appears the day an embedding provider is added, and then as `42P01` mis-explained as "the provider could not be reached". |
| Data-loss risk | No loss; but **permanence** is the point: migrations are forward-only and gap-free, so no later `init` or `upgrade` repairs the install. Every database created before the fix stays broken. |
| Violates explicit EPIC claim | Yes — EPIC-010 AC-6 (recorded schema version matches reality). |
| Depended on by | F-45 (export omits `ferret.embedding`) is moot while the table does not exist. |
| Recommended action | Provision extensions **before** `migrate()` in `StorageProvider.onInitialize`, **and** add a repair migration creating the table when `to_regtype('vector')` is now non-NULL and the table is absent. Separately: a conditional migration must record which branch it took. |
| Priority | **P1-A.** Not urgent by symptom, urgent by permanence — the population of unrepairable installs grows with every day it ships. |

---

### F-29 — import interpolates document-supplied column names into SQL

| Field | Assessment |
| --- | --- |
| Severity | **P1-A** |
| Category | IMPLEMENTATION DEFECT — security (identifier injection) |
| Production impact | `ferret import --apply` on a crafted document executes attacker-chosen SQL as Ferret's database role. Confined by the extended protocol to one statement, which still admits data-modifying CTEs and sub-selects. |
| Exploitability | Requires an operator to import a document they did not author — which is precisely the documented disaster-recovery workflow. No privilege escalation beyond Ferret's own role. |
| User-visible impact | None until damage is done. |
| Data-loss risk | Yes — arbitrary writes. |
| Violates explicit EPIC claim | **Yes, directly.** EPIC-090 §11: "every row goes through the same `createEntity`/`createRelationship` validation an observation does". Neither symbol appears in `src/storage/import.ts`. |
| Depended on by | None. |
| Recommended action | Intersect `Object.keys(row)` with the catalogue already read by `columnFacts`, refuse anything unknown, **and** escape identifiers by doubling `"`. Both, not either. Then implement the row validation §11 promises, or correct §11. |
| Priority | **P1-A.** Small, self-contained, high value. Best first commit after F-01. |

---

### F-30 — `export --backup-command` prints the database password

| Field | Assessment |
| --- | --- |
| Severity | **P1-A** |
| Category | IMPLEMENTATION DEFECT — credential disclosure |
| Production impact | The password lands in terminal scrollback, CI job logs, and any machine caller that logs the `--json` envelope. `ok: true`, exit 0, so nothing marks the output sensitive. |
| Exploitability | No attacker required; the leak is the normal behaviour. Exposure is wherever the logs go. |
| User-visible impact | Visible — but as a plausible-looking command, so it reads as intended output. |
| Data-loss risk | None directly; credential compromise is the risk. |
| Violates explicit EPIC claim | Yes — EPIC-106 §11 ("No credential appears in the plan"), EPIC-003 and EPIC-091 redaction ACs. |
| Depended on by | Same subsystem as F-71 (the same variable, unscrubbed for child processes). |
| Recommended action | Wrap the return of `backupCommandFor` in the existing `redact()` — one line, covering both call sites — and add a userinfo-bearing URL to the test that currently picks one without a password. |
| Priority | **P1-A.** Cheapest blocker in the set; fix in the first batch. |

---

### F-17 — export writes a backup that import refuses

| Field | Assessment |
| --- | --- |
| Severity | **P1-A** |
| Category | IMPLEMENTATION DEFECT — backup integrity |
| Production impact | A backup reported successful, with a verifying trailer, cannot be restored at all — not partially, not with the bad row skipped. One 189 KB text blob is enough. |
| Exploitability | None needed; ordinary content triggers it. |
| User-visible impact | **Deferred and maximal** — discovered during a restore, which is when the original is already gone. |
| Data-loss risk | **Highest in the report.** The failure destroys the recovery path, not the data. |
| Violates explicit EPIC claim | Yes — EPIC-089 AC-1/AC-2/AC-10 pass on the document; EPIC-090 AC-1 fails on it. |
| Depended on by | **F-44 dissolves with this fix** (both stem from line-level redaction at export). F-45 is adjacent but independent. |
| Recommended action | Do not redact the framing at export — content is already redacted before insert (EPIC-087 §8.2). If a second line of defence is wanted, apply it per string value after parsing, never with a whole-input fallback, and compute the digest over what is actually written. |
| Priority | **P1-A.** Batch with F-29 (same file pair, same reviewer context). |

---

### F-18 — conformance certifies a provider it never started

| Field | Assessment |
| --- | --- |
| Severity | **P1-B** (demoted from report P1) |
| Category | IMPLEMENTATION DEFECT in shipped SDK code (`src/providers/sdk/conformance.ts`), surfaced by a TEST GAP |
| Production impact | The gate that answers "is this provider safe to install" returns `ok` for a provider whose lifecycle and secret-handling checks never ran — proven by construction with a deliberately broken provider. |
| Exploitability | Not an attack surface today: no external-provider path exists (F-53, F-21), and both first-party providers are unreachable. |
| User-visible impact | The `npm run verify` summary reads `ok ferret.source.jira 8 passed, 0 failed, 11 skipped` — the truth is present in the line and not in the verdict. |
| Data-loss risk | None. |
| Violates explicit EPIC claim | Yes — EPIC-016 AC-11 and EPIC-099's aggregate claim. |
| Depended on by | **Gates F-19 and F-53**: all three are the external-provider trust story. |
| Recommended action | Distinguish "not applicable" from "not attempted" (`unproven` status or an `exercised` flag); make `assertConformant` and the aggregate refuse a report where a lifecycle or security check was not attempted; give the Jira subject valid `options`. |
| Priority | **P1-B, gated.** Not a blocker for the current product; **a hard blocker before any provider is wired or any external provider is supported.** |

---

### F-20 — Session & Agent Memory domain unreachable

| Field | Assessment |
| --- | --- |
| Severity | **D — acceptable, but under-disclosed** (demoted from report P1) |
| Category | DOCUMENTATION DRIFT at registry level; **not** an implementation defect |
| Evidence for the demotion | Every Epic in the cluster scopes itself to the domain model and excludes persistence *by name*. EPIC-041 Non-scope: "Database tables, retention policy, or encryption implementation; those belong to storage/security Epics", and its Scope says "Serialization suitable for durable storage by **later** storage/integration work". EPIC-039 Non-scope defers capture, checkpoints, extraction and recovery to their own Epics; EPIC-040 excludes "Claude hooks, credentials, transport". Each Epic delivers exactly what it scoped, and each validation record discloses its own slice honestly. |
| Production impact | None. Nothing claims the capability is reachable. |
| Violates explicit EPIC claim | **No.** The claim was never made. |
| What is actually wrong | The *aggregate* is stated nowhere: five P0 Epics read as shipped in the registry, and the storage/integration Epic they all defer to does not exist and is not tracked. |
| Recommended action | **Do not implement a session store.** Record the reachability gap once — in the registry, as a note on the cluster — and, if the capability is wanted, let normal governance decide whether an integration Epic is warranted. That decision is not this triage's to make. |
| Priority | **P2 — documentation.** |

---

### F-21 — external-provider functionality unreachable

| Field | Assessment |
| --- | --- |
| Severity | **D — acceptable scope, with one real defect attached** (demoted from report P1) |
| Category | DOCUMENTATION DRIFT, plus a genuine CLI-surface omission |
| Evidence for the demotion | Each Epic scopes to a module and excludes the next layer explicitly. EPIC-021 Non-scope: "**Modelling.** This returns records." EPIC-072 Non-scope: "**Transport** … Nothing here makes a request, and nothing here imports a provider" and "**Persistence.** This produces records". EPIC-071 Non-scope excludes PRs, reviews, releases and writing. EPIC-077 Non-scope: "**Hosting an HTTP endpoint**". No Epic in the cluster claims a client-reachable ingestion path; each claims a module and delivers it. |
| Production impact | None — the code is inert. |
| Violates explicit EPIC claim | **No** for reachability. **Yes** for the seam claims inside those Epics — see F-08, F-09, F-10, which are triaged separately as P1-B. |
| What is actually wrong | `PLANNED_COMMANDS` is empty (`src/cli/commands/planned.ts:48`) — the mechanism the project built so that "nothing is falsely advertised as working" is not used for the one capability that needs it — and the README/registry read as shipped. |
| Recommended action | **Do not invent a `ferret sync` command.** Two documentation actions only: state the integration gap in the registry, and either add the capability to `PLANNED_COMMANDS` or say plainly in the README that GitHub/Jira ingestion is library-only in this release. |
| Priority | **P2 — documentation.** |

---

### F-02 / F-03 / F-04 — synchronization correctness

| | F-02 | F-03 | F-04 |
| --- | --- | --- | --- |
| Severity | **P1-A** | **P1-A** | **P1-A** |
| Category | IMPLEMENTATION DEFECT — silent data loss | same | same, plus fabricated entities |
| Production impact | Every branch shares one watermark in **every** shipped path (`index` defaults `--revision HEAD`; `reconcile` passes nothing). Indexing `main` then a feature branch loses the branch's history. | One commit dated in the future stops ingestion for that repository indefinitely; runs report `incremental: true`, exit 0, and health reports "last advanced 0s ago". | Merging a branch older than the watermark leaves its commits unread and writes the merge's second parent as a parentless, messageless stub. |
| Exploitability | None needed — ordinary branch switching. | A wrong clock or one `git commit --date`. | `git merge --no-ff` of a week-old branch. |
| User-visible impact | None. | None. | A commit entity that exists with no data. |
| Data-loss risk | High. | Total, until manual `--full` (itself capped — F-01). | High, plus assertion of a commit Ferret knows nothing about (Governance §6). |
| Violates explicit EPIC claim | Yes — EPIC-076 AC-4, and `indexer.ts:489` declares this exact failure closed. | Implicitly; `newest()`'s own docstring names "a wrong clock" and picks the losing direction. | Yes — EPIC-076, Governance §6. |
| Dependencies | Independent; cheap. | **Subsumed by the F-04 fix.** | **Subsumes F-03**; complements F-01. |
| Recommended action | Resolve `HEAD` to a concrete ref/OID before deriving the watermark scope. Delete the unit assertion that pins the collision. | Clamp the stored position to `min(newestCommitAt, observedAt)` and warn beyond a tolerance — or adopt the F-04 fix, which removes the class. | Resume by reachability: store indexed tip OIDs and read `<new-tips> --not <stored-tips>`. This is exact, and immune to both date-based failures. |
| Priority | P1-A | P1-A | P1-A |

**Batch note.** F-01 + F-02 + F-03 + F-04 are one piece of work with one acceptance test:
*index a repository with 1 005 commits, on two branches, containing one future-dated commit
and one back-dated merge, and assert that every commit is present.* That single fixture
fails today for four independent reasons and would gate all four fixes.

---

### F-05 / F-06 / F-07 — answer and evidence truthfulness

| | F-05 | F-06 | F-07 |
| --- | --- | --- | --- |
| Severity | **P1-A** | **P1-A** | **P1-B** |
| Category | IMPLEMENTATION DEFECT | IMPLEMENTATION DEFECT — evidence loss | IMPLEMENTATION DEFECT |
| Production impact | A tombstoned entity is answered `verdict: answered`, claim `[current]`, `unknowns: []`, citation `integrity: verified`. Reproduced live on this repository's own index. | Every member but the last of a multi-valued field is marked `superseded`, and the discarded rows are rendered as "a current record covers `references`" — a positive claim that is false. Live today: `ferret_why(symbol, field="references")` returns `count: 1` for two recorded call sites. | Reconciling a conflict rewrites both rows to `conflicting`; both reader surfaces filter `state = current`, so recording the conflict is what hides it. |
| Exploitability | None needed. | None needed. | None needed — but requires two sources that disagree. |
| User-visible impact | **An AI client is told a deleted file exists and that nothing is missing.** | Answers are silently incomplete and accompanied by a false explanation. | A subject whose only evidence is a marked conflict answers `held: false`. |
| Data-loss risk | None — the record is intact, the qualifier is missing. | No row is deleted; currency is lost. | None. |
| Violates explicit EPIC claim | Yes — EPIC-048, EPIC-046. | Yes — EPIC-008's own docstring, EPIC-047. | Yes — EPIC-047 AC-15 and Governance §15. |
| Dependencies | Independent; the helper it needs (`describeStanding`) already exists. | Independent. Largest fix of the three (field cardinality at the emission seam). | **Trigger depends on multi-source ingestion (F-21)** — not observable today. |
| Recommended action | Force `PARTIAL` when `lifecycle !== ACTIVE`, push `describeStanding(subject)` into `unknowns`, render `lifecycle` in both surfaces. | Declare field cardinality at the emission seam, or join the supersession key on statement/locator identity for collection fields. Add an assertion that *N* resolutions leave *N* current rows. | Give `EvidenceQuery` a `states` array; read `[CURRENT, CONFLICTING]` in `conflictsFor` and `ferret_why`. Cheap — take it opportunistically with F-06. |
| Priority | P1-A | P1-A | P1-B |

---

### F-08 — Jira end-to-end incompatibility

| Field | Assessment |
| --- | --- |
| Severity | **P1-B** |
| Category | IMPLEMENTATION DEFECT at a seam + TEST GAP (no test crosses provider→model) |
| Production impact | None today — `modelProject` has no production caller (F-21). The moment it has one, a Jira sync produces zero entities and zero evidence, silently unless the caller reads `result.skipped`. |
| Exploitability | None needed; it is every real Jira response. |
| User-visible impact | Empty result, no error. |
| Data-loss risk | Total for the Jira source, but nothing is corrupted. |
| Violates explicit EPIC claim | **Yes, explicitly.** EPIC-071 §17 states `modelProject` "needed no change at all"; that path was never executed. |
| Depended on by | Gates the whole external-knowledge integration; F-09, F-10, F-55, F-56, F-57 sit behind the same seam. |
| Recommended action | Normalize at the provider boundary (`new Date(x).toISOString()` parses `+0000` correctly) — **not** by widening the domain instant, which would let a looser value into every entity. Add one test piping a `JiraProvider` page into `modelProject`; that single test is worth more than the fix. |
| Priority | **P1-B, and the first thing to fix when the integration Epic starts.** |

---

### F-09 / F-10 — GitHub and project identity modelling

| | F-09 | F-10 |
| --- | --- | --- |
| Severity | **P1-B** | **P1-B** |
| Category | IMPLEMENTATION DEFECT | DESIGN DEFECT — identity keying |
| Production impact | Unreachable today. When wired: "which PR introduced this commit" answers with rejected work, and each such edge mints a permanent orphan `commit` placeholder for a test-merge SHA. | Unreachable today. When wired: two `issue` entities for one issue in one repository, the resolve edge pointing at the one with no title, state or evidence, and the named reconciler structurally unable to join them. |
| Data-loss risk | No loss; false edges. | Graph fragmentation; no loss. |
| Violates explicit EPIC claim | Yes — EPIC-072 AC-5, and the comment directly above the defective condition. | Yes — the comment names EPIC-051 as the remedy and EPIC-051 refuses same-system pairs. |
| Dependencies | Behind F-21. Test fixture must be repaired too (it sets `mergeCommit: undefined`). | Behind F-21. Interacts with EPIC-051's proposer rules. |
| Recommended action | `pull.lifecycle === MERGED && pull.mergeCommit !== undefined`; change the AC-5 fixture to vary `lifecycle`, not the field the code branches on. | Key an issue on `scope + key` and record the provider node id as an external id — **or** admit a within-system, same-scope, same-key resolution rule. Decide before the integration Epic; retrofitting identity after data exists is expensive. |
| Priority | P1-B | P1-B (decide the keying early even though the fix is deferred) |

---

### F-60 / F-61 — archive and decompression bounds

| | F-60 (xlsx/zip) | F-61 (docx) |
| --- | --- | --- |
| Severity | **P1-A** (promoted from report P2) | **P1-A** (promoted from report P2) |
| Category | IMPLEMENTATION DEFECT — resource exhaustion from untrusted input |
| Production impact | The inflate bound is checked against the archive's own declared size and `inflateRawSync` gets no `maxOutputLength`: 204 KB → 200 MiB measured, 3.1× past the 64 MiB bound. | `.docx` bypasses Ferret's bounded reader entirely; caps apply after materialisation: 353 KiB → 480 MiB RSS over 5.7 s, uninterruptible. |
| Exploitability | **Anyone who can commit a file to an indexed repository.** Requires `--content` (opt-in), which is the mode the parser Epics exist for. | Same. |
| User-visible impact | Memory spike, then a process kill that aborts the whole index run — the failure isolation EPIC-024 AC-6 promises. | Same, plus 5.7 s of uninterruptible work per document. |
| Data-loss risk | None directly; a killed run leaves the watermark unmoved (correct), so the effect is denial of indexing. |
| Violates explicit EPIC claim | Yes — EPIC-028 §11 and the module docstring ("a bound is only trustworthy if it is applied before the allocation"). Note EPIC-028 AC-14 is *written* to describe the defective check ("refuses an archive that **declares** more…"), so the AC text needs correcting too. | Yes — EPIC-024 §11 ("the framework enforces the size bound before a parser sees the content, so a decompression or allocation attack cannot start"). |
| Dependencies | Same fix location and same test helper — the fixture generator cannot currently express a lying header, so the test change is part of the fix. | Independent of F-60 but same batch. |
| Recommended action | Pass `{ maxOutputLength: maxInflated - inflated }`, accumulate the **actual** byte length, keep the declared-size check as a cheap pre-filter, and reject a declaration that disagrees with reality. Correct AC-14's wording. | Pre-flight the package through the bounded `readZip` before handing bytes to `mammoth`, or extract `word/document.xml` through it and feed a bounded buffer. Add a wall-clock deadline honoured against `context.signal`. |
| Priority | P1-A — the only findings in the set an outsider can trigger by committing a file. |

---

### F-64 / F-65 / F-66 / F-67 — context and retrieval truthfulness

| | F-64 | F-65 | F-66 | F-67 |
| --- | --- | --- | --- | --- |
| Severity | **P1-A** (promoted) | **P1-B** (promoted) | **P1-A** (promoted) | **P1-B** (promoted) |
| Category | Security boundary | Correctness | Security boundary | Signal degradation |
| Production impact | Containment applies to top-level strings only; array elements and nested objects pass through unwrapped **and uncounted**, so `contentSafety` affirms "0 read as instructions" for content never examined. | Relaxation rewrites `a & !b` to `a | !b`: results are selected *because* they lack the excluded term. Measured 0 → 3 775 of 3 777 rows, all `score: 0`. | The content notice is **last** in the default JSON response of the two tools whose entire purpose is to be pasted into a prompt, under a key no other tool uses. | `plan.partial` is constant `true` in the shipped configuration, so a healthy answer and a total retrieval outage are identical on the one field documented to distinguish them. |
| Exploitability | **Reachable today**: `emails` and `usernames` are arrays populated from commit author fields — anyone who can push a commit. `labels` too, once providers are wired. | No attacker; a user's own `-term` produces the inversion. | No attacker; it is the default response shape. | None. |
| User-visible impact | An AI client receives untrusted text outside the boundary it was told to rely on, with a safety report saying nothing was marked. | An explicit exclusion returns near-whole-index results presented as ranked. | Instruction arrives after the content it governs. | A client that branches on `partial` cannot detect real degradation; one that learns to ignore it ignores the case that matters. |
| Data-loss risk | None. | None. | None. | None. |
| Violates explicit EPIC claim | Yes — EPIC-084 AC-1. | Yes — EPIC-054/055 AC-13; the plan's own explanation does not describe what happened. | Yes — `src/mcp/server.ts:63-66` states the opposite rule. | Yes — EPIC-054/055 AC-6, and `StrategyOutcome.skipped`'s own contract. |
| Dependencies | **F-32 is the same defence** (trimming cuts the closing delimiter) — fix together. | Independent. | Independent, one-line. | Independent. |
| Recommended action | Recurse over arrays and plain objects with a depth bound, applying the same policy to each leaf, and count every leaf examined. | Strip negated conjuncts before OR-ing, or skip relaxation when the strict query contains `!` and say so in the strategy outcome. | Emit `{ notice, ...pack }` on both JSON branches; enumerate `listTools` in the notice test instead of a hand-written list. | Separate "not configured" from "configured and failed"; compute `partial` only from strategies expected to run. |
| Priority | P1-A | P1-B | P1-A | P1-B |

---

### F-71 — database credential in the child-process environment

| Field | Assessment |
| --- | --- |
| Severity | **P1-B** (promoted from report P2) |
| Category | IMPLEMENTATION DEFECT — defence in depth |
| Production impact | `FERRET_DATABASE_URL` is absent from `CREDENTIAL_ENV`, so every `git` subprocess inherits the database password. |
| Exploitability | Low in isolation: `SAFETY_CONFIG` disables the repository-controlled keys that name a program (hooks, pager, credential helper, filters, `diff.external`), so there is normally nothing in that process tree to read the variable. **The risk is compositional** — that list is an enumeration, not a deny-by-default, and F-94 proves the enumeration is incomplete for a different property. |
| User-visible impact | None. |
| Data-loss risk | None directly. |
| Violates explicit EPIC claim | Yes — EPIC-081 AC-5, which passes vacuously because the test enumerates spawners against `CREDENTIAL_ENV` rather than against the variables that actually carry credentials. |
| Depended on by | Pairs with F-94 (both are "the safety enumeration is incomplete"). |
| Recommended action | Add `FERRET_DATABASE_URL`, `DATABASE_URL`, `PGSERVICEFILE`; better, derive the list from the same place the readers read, so a new credential-bearing variable cannot be added to one side only. |
| Priority | **P1-B**, batched with F-94 and F-30 as "credential and safety enumeration". |

---

### F-72 / F-73 — packaging verification integrity

| Field | F-72 | F-73 |
| --- | --- | --- |
| Severity | **P2** | **P2** |
| Category | **TEST GAP / INFRASTRUCTURE** — explicitly *not* implementation defects | **INFRASTRUCTURE / CONTENTIOUS TEST** |
| Production impact | None on the product. `tests/global-setup.ts` builds `dist/` with `tsc` + `copy-migrations` only, so `npm test` on a clean tree fails `packaging.test.ts`, and the packaging guarantee is only ever proven against grammars and datasets a *previous* build left. | None on the product. Under full-suite contention the `beforeAll` exceeded its 300 s hook timeout and **all 34 packaging tests were skipped**, reported inside a single `41 skipped` figure. |
| Is the release gate real? | **Yes.** CI runs `npm run build` before `npm test`, so the tarball CI packs is complete, and an independent reviewer confirmed a built copy packs 505 correct files with byte-identical repeat packs. | Same — but the secret-scan of shipped bytes and the reproducible-tarball assertion did not execute on this machine, and nothing in the output said so. |
| Recommended action | Make `global-setup` run the same asset steps as `build`, so what the suite packs is what the suite built. **Do not** relax the assertion to make it pass. | Fail the run when the packaging hook times out rather than converting 34 assertions into silent skips; report skipped *suites* separately from skipped *tests*. Related to open issue #130 — do not close #130 on this evidence; the mechanism there is still unexplained. |
| Priority | P2 (verification integrity) | P2 (verification integrity) |

---

### Remaining P1-A blockers

| ID | One-line assessment | Data loss | Explicit EPIC claim violated | Action |
| --- | --- | --- | --- | --- |
| F-11 | Any non-address author string (`unknown`, `(no author)`) becomes a canonical developer id, merging distinct humans irreversibly at derivation time, with no evidence and order-dependent naming. Reachable today from ordinary git ingestion. | Yes — attribution, unrecoverable | Yes; the comment above the derivation claims the opposite guarantee | Return `undefined` for a value that is not `local@domain`, or scope the opaque form to the repository and keep it out of `source.id` |
| F-23 | A corrupt spreadsheet parses as a successful empty one and the empty result is cached permanently by the content gate. "Unreadable" and "contains nothing" are the same answer. | Yes — silent permanent omission | Yes — the module's own rule at `xlsx.ts:85-86` | Refuse a part with no recognisable root; warn when a present part yields zero rows |
| F-24 | Byte spans point at the wrong bytes for BOM'd, UTF-16 and multi-paragraph plain-text files; `validate()` cannot see it. Every citation for such a file is wrong. | No loss; wrong evidence | Yes — EPIC-024 §8 | Return `textByteOffset` from `detectContent` and apply at the framework boundary; capturing split in `#plain` |
| F-25 | Member calls resolve to same-file homonyms at STRONG. Verified live: all 8 inbound edges on `ProviderRegistry.has` are `Map`/`Set` calls. | No loss; wrong graph | Yes — EPIC-035 §17 claims the class was eliminated | Require corroboration for `qualified` references; at minimum drop the confidence band and record `qualified` on the edge |
| F-25b | Two of those 8 are the same call site recorded twice with both intervals open; nothing ever retires a content edge. | No loss; inflated counts | Yes — EPIC-035 §8.6 states edges are ended | Diff and `retire` on re-index; move `line` out of identity-relevant metadata |
| F-27 | Unresolved references are counted and discarded, so "nothing references this" and "we refused to resolve 64% of them" are the same answer. This is what makes an impact or dead-code answer dangerous. | No loss; false negatives | Yes — EPIC-035 §12 | Persist unresolved counts per symbol; emit a `partial:` notice on reference reads |
| F-28 | A traversal cut by the per-hop SQL `LIMIT` is returned as complete; the depth-1 default reports no bound at all. | No loss; silent truncation | Yes — EPIC-050 AC-13 | `LIMIT n+1` per hop, propagate `more`, add `truncated` to the depth-1 response |
| F-31 | `ferret_find` and `ferret_neighbours` drop permission-withheld rows silently, and `ferret_find` then asserts `truncated: false` on a partial answer. | No loss; affirmatively false flag | Yes — EPIC-058, and the tool's own comment | Give both methods a withheld report (mirroring `SearchResult`); compute `truncated` from `withheld.total > 0 \|\| length > requested` |
| F-32 | Trimming cuts the closing containment delimiter, leaving the prompt-injection envelope unterminated. | No loss; security boundary | Yes — EPIC-059 AC-9 | Trim the raw value and re-contain, or re-append the close; assert balanced delimiters after trimming |
| F-94 | `SAFETY_CONFIG` covers keys that name a program but not keys that change `git log`'s output shape; `i18n.logOutputEncoding` fabricates commit entities under attacker-chosen SHAs. Precondition: attacker-controlled `.git/config` — the threat model the list already adopts. (Verified: `git clone` does **not** propagate the key.) | Yes — history collapse plus cross-repository entity poisoning | Yes — EPIC-019 §11 | Add the encoding/quoting keys; require the `looksLikeCommitStart` shape check in the outer resync loop |
| F-95 | One commit git cannot date desynchronises `parseLog`, discards the rest of the page and writes fabricated `file` entities (`{"path":"%aI"}`). `truncated: false`. | Yes, plus assertion of data that does not exist | Yes — EPIC-019 AC-9 | Treat SHA-then-SHA as a boundary even when dates are unparseable; emit the commit with absent timestamps and a recorded skip reason; never advance `readChange` past a boundary token |

## 3. P1-B — significant but safely deferrable

Every one is a real defect. None blocks the current product, and each is cheapest to fix at
the moment the code around it becomes reachable.

| ID | Why deferrable | Fix when |
| --- | --- | --- |
| F-07 | Requires two disagreeing sources; none can exist until providers are wired | With F-06, opportunistically — the fix is a `states` array |
| F-08, F-09, F-10 | `modelProject` has no production caller | First work of any integration Epic; F-10's identity keying should be **decided** now |
| F-12 | `IdentityStore.merge` has no adjudicating caller; the `finally` writing a false record on failure is cheap to correct now | With any identity work |
| F-13, F-14, F-15 | GitHub client unreachable; F-15 is latent credential exfiltration and must precede any cursor persistence | Before wiring the GitHub provider |
| F-18, F-19 | The external-provider trust story; no external provider path exists | Before external providers are supported |
| F-22 | CRLF Markdown headings become prose — degraded structure, no false assertion beyond `headingCount` | Next parser batch; one-line fix |
| F-26 | Cross-file resolution is disclosed as a limitation in EPIC-035 §16; the defect is that AC-4 is recorded MET on a fixture that does not compile | Fix the **record** now, the resolver later |
| F-65, F-67 | Retrieval quality and signal fidelity; no incorrect data is stored | Next retrieval batch |
| F-71 | Defence in depth; compositional risk with F-94 | With F-94 |

## 4. P2 / P3 findings

Sixty findings. Grouped by what they are, because they should be handled as groups.

- **Documentation and record drift (fix the record, not the code):** F-74 (53 spec headers
  disagree with the registry), F-75 (`23505` reversal recorded nowhere), F-87 (README lists
  15 of 18 tools), F-20 and F-21's registry notes, EPIC-028 AC-14's wording (see F-60),
  EPIC-035 AC-4's status (see F-26), EPIC-090 §11 (see F-29). **This is the single
  highest-value P2 group** — every one of these is a place where the project's own record
  says something the code does not do, which is what made several P1s survive validation.
- **Identity and resolution hardening:** F-33 (no NFC), F-34 (`noreply@github.com` as a
  service address collapses humans into one agent), F-35, F-36. F-33 and F-34 are the same
  class as F-11 and should ride with it.
- **Retention and storage lifecycle:** F-41, F-42, F-43, F-44, F-45. Note the dependency —
  **F-42 makes F-41 nearly unreachable**: if the prune target is empty by construction, the
  race cannot fire on real data. Fix F-42 first and F-41 becomes reachable and must be fixed
  with it.
- **Provider platform:** F-37, F-38, F-39, F-40, F-53, F-54, F-55, F-56, F-57, F-58, F-59.
  All behind F-21; batch with the integration Epic.
- **Observability and audit:** F-63 (no audit event from any MCP path), F-88 (dependent on
  F-63 — a false `PERMITTED` event would be written before the token is validated), F-52
  (content-skip invisible in the report), F-80, F-82.
- **Session/memory domain values:** F-46, F-47, F-48, F-49. Only worth doing if the domain
  is ever wired (F-20); F-49 (the reachability sweep's scope) is worth doing regardless,
  because it is the control that would have caught F-20's class.
- **Benchmark honesty:** F-50, F-51, F-91. **Do not tune the benchmarks** — correct the
  claims that cite them, and state the limitation in the validation records.
- **Test integrity:** F-72, F-73 (above), plus the fixture repairs that must accompany
  F-09, F-60 and F-95.
- **Small correctness:** F-76 through F-86, F-89, F-90, F-92, F-93, F-96, F-97, F-98, F-99.
  Of these, **F-96 and F-97 should be promoted into the F-95 batch** — they are the same
  subsystem's failure-isolation story (one bad date aborts the whole page; a corrupt object
  reports "this repository has no history"), and fixing the parser without them leaves the
  isolation claim still false.

## 5. Dependencies between findings

| Relationship | Findings |
| --- | --- |
| **Subsumed — no separate work** | F-03 is closed by F-04's reachability rewrite. F-44 is closed by F-17's fix. |
| **Blocked/masked by another** | F-41 is masked by F-42 (empty prune target). F-45 is moot while F-16 leaves the table absent. F-88 is latent because F-63 means no audit writer exists. |
| **Same defence — fix together** | F-32 + F-64 + F-66 (prompt-injection boundary). F-30 + F-71 + F-94 (credential and safety enumeration). F-95 + F-96 + F-97 (git ingestion isolation). F-11 + F-33 + F-34 (identity keying). F-18 + F-19 + F-53 (external-provider trust). |
| **Gated behind a disposition** | F-07, F-08, F-09, F-10, F-13, F-14, F-15, F-37–F-40, F-54–F-59 all wait on F-21's integration decision. F-46–F-48 wait on F-20's. |
| **Shared root cause, independent fixes** | F-01 (paging) and F-02 (scope key) both live in the watermark, but neither fix implies the other. |
| **Verification prerequisites** | F-72 must be fixed before F-73 can be judged, and both before the packaging gate can be trusted on a developer machine. |

## 6. Recommended fix batches

Ordered. Each batch is independently shippable and independently verifiable.

**Batch 1 — Ingestion completeness (P0 + 3× P1-A).** F-01, F-02, F-03, F-04.
One acceptance fixture gates all four: 1 005 commits, two branches, one future-dated commit,
one back-dated merge; assert every commit present and every entity fully populated. Highest
value in the report — it is the only work that stops active data loss.

**Batch 2 — Small, self-contained blockers (4× P1-A).** F-30, F-29, F-17, F-16.
Four different subsystems, four small fixes, four explicit EPIC claims restored. F-16 needs a
repair migration as well as the ordering change. Do this batch second because it is cheap and
because F-16's cost grows with every install shipped.

**Batch 3 — Untrusted-input bounds (2× P1-A + 3 related).** F-60, F-61, plus F-95, F-96, F-97.
Everything an outsider can trigger by committing a file, plus the git-parser isolation that
turns one bad record into a lost page. Include the fixture-generator change — the current
helper cannot express a lying ZIP header, so the test is part of the fix.

**Batch 4 — Answer truthfulness (6× P1-A + 2 opportunistic).** F-05, F-31, F-28, F-27, F-06,
F-24, plus F-07 and F-25b if the diff stays readable. This is the batch that restores the
product's central claim. F-06 is the largest single fix in the report.

**Batch 5 — Prompt-injection boundary (3× P1-A).** F-32, F-64, F-66. Small, and they are one
defence rather than three.

**Batch 6 — Credential and safety enumeration (1× P1-A + 1× P1-B).** F-94, F-71. F-30 already
landed in Batch 2; this batch is the enumeration itself — make the safety lists
deny-by-default or derived, rather than hand-maintained.

**Batch 7 — Code-intelligence truth (2× P1-A).** F-25, F-11. Both change what Ferret asserts
about people and call graphs; both need a re-index to take effect, so schedule them where a
re-index is acceptable.

**Batch 8 — Record correction (P2, no code).** The documentation-drift group in §4. Cheap,
and it is the group most likely to prevent the next round of this.

**Deferred to their own Epic:** everything gated behind F-21 and F-20.

## 7. Findings that should NOT be fixed

- **F-20 and F-21 — do not build a product surface.** Both clusters scoped themselves to
  modules and excluded transport and persistence *by name*. Building a session store or a
  `ferret sync` command on the strength of this audit would be exactly the "invent a new
  product surface because a module exists" the brief forbids. Record the gap; let governance
  decide whether an integration Epic is warranted.
- **F-26 — do not implement import following now.** EPIC-035 §16 already names it as the
  first thing to add. The defect worth correcting today is the *record*: AC-4 is marked MET
  on a fixture that would not compile.
- **F-50, F-51, F-91 — do not tune the benchmarks.** Correct the claims that cite them. A
  benchmark rewritten to produce a nicer number is worse than one honestly labelled.
- **F-98 — do not half-fix.** Either model the committer (attributes + a
  `DEVELOPER_COMMITTED_COMMIT` edge) or delete the parsed fields and drop `%cn`/`%ce` from
  the format. Carrying an untrusted field nobody consumes is pure parse surface.
- **F-84 — delete `isInside` rather than repair it.** It is broken on Windows, exported on a
  public barrel, and has no caller.
- **Do not "fix" any test to make it green.** Where a fixture was shaped to the
  implementation (F-09, F-60, F-95, and the nine others in the forensic report's §7), the
  fixture change is part of the *implementation* fix and must fail first.
- **Do not close issue #130 on this audit's evidence.** F-73 explains why the packaging suite
  can vanish from a run; it does not explain #130's non-deterministic digest.

## 8. Verification gaps

1. **The packaging gate does not run reliably outside CI** (F-72, F-73) — including the
   secret scan of the shipped bytes. CI's gate is real; a developer's is not.
2. **No test crosses a provider→model seam** (F-08). This single missing test class is
   responsible for the largest defect in the external-knowledge cluster.
3. **The conformance harness cannot distinguish "not applicable" from "not attempted"**
   (F-18), so its verdict is not evidence.
4. **The reachability sweep covers two barrels** (F-49), so a control outside
   `security`/`authorization` can be dead without any test noticing — which is how F-20's
   class survives.
5. **Eleven acceptance tests assert the implementation rather than the requirement**
   (forensic report §7). Every one of them should fail against the pre-fix code once its
   finding is addressed; that is the acceptance criterion for the fix.
6. **Not executed:** F-29 was demonstrated at statement construction, not against
   PostgreSQL; F-52 was established statically. Both should be reproduced during their fix.
7. **Untested at scale:** no run against a large real repository, a real GitHub
   organisation, or a real Jira site — the environments where F-01, F-08 and F-16 surface
   first.

## 9. Final production-readiness blockers

**25 blockers: 1 P0 + 24 P1-A.** Grouped as they must be fixed:

| Group | Findings | Why it blocks |
| --- | --- | --- |
| Ingestion completeness | F-01, F-02, F-03, F-04 | Silent, unrecoverable history loss on ordinary use |
| Backup and recovery | F-17, F-29 | The recovery path is both unusable and injectable |
| Install integrity | F-16 | Unrepairable schema state, and the population grows daily |
| Credential exposure | F-30 | Password to stdout and CI logs, exit 0 |
| Untrusted-input bounds | F-60, F-61, F-94, F-95 | An outsider who can commit a file, or hand over a repository directory, can exhaust the process or fabricate entities |
| Answer truthfulness | F-05, F-06, F-23, F-24, F-25, F-25b, F-27, F-28, F-31 | Ferret states, with confidence markers, things that are not so |
| Prompt-injection boundary | F-32, F-64, F-66 | The structural defence is unterminated, incomplete, and late |
| Identity integrity | F-11 | Distinct humans merged irreversibly at derivation time |

**Not blockers, on evidence:** F-20 and F-21 (intentional module scope, under-disclosed);
every finding gated behind them; F-72/F-73 (CI's gate is sound).

**One-line recommendation.** Fix Batch 1 first. It is the only work in this report that stops
data being lost while you decide about the rest.
