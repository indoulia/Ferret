# Ferret — Post-Roadmap Forensic Verification

**Status: COMPLETE** · Auditor: independent forensic pass · Date: 2026-09-03

> This document verifies whether the completed system satisfies what its completed
> Epics claim. It does not propose new Epics, does not close or reopen Epic status,
> and does not modify historical Epic evidence. Nothing here was merged or deployed.

## 1. Scope

Every Epic in the registry is `VALIDATED` or `DONE` (108 registry entries). This
pass asks a different question from the one validation asked: not "does the
acceptance criterion have evidence" but **"is the claim true against the code, and
would the tests notice if it were not"**.

Areas audited: core runtime · configuration · provider framework · provider
discovery · provider contracts · credentials · GitHub provider · Jira provider ·
source/project modeling · PR/review modeling · release/deployment modeling ·
event/webhook ingestion · entity resolution · parsers · document intelligence ·
spreadsheet intelligence · migrations/storage · incremental synchronization ·
retry/backoff · rate limiting · identity/canonicalization · graph integrity ·
evidence/provenance · security boundaries · CLI · upgrade/migration UX ·
packaging · dependency boundaries · error/exit-code semantics · session & agent
memory · evaluation harnesses.

## 2. Commit / base

- Base commit: `0407618e2001435f2ec861f324ed75cd5e5e08be` — *feat(EPIC-074): External Provider Extension Framework (#152)*
- Branch under audit: `main`, clean working tree at start.
- Work performed in an isolated worktree at `C:\AIAgent\ferret-forensic`
  (branch `forensic/post-roadmap-audit`). No merge, no push to `main`, no deploy,
  no production data touched.
- Environment: Windows 11, Node v22.23.2, npm 10.9.8, Docker 29.5.3
  (`pgvector/pgvector:pg17` provisioned by the suite's global setup).

## 3. Epic coverage

- 108 registry entries; 107 `VALIDATED`, 1 `DONE` (EPIC-005).
- All 96 validation-evidence links in `docs/EPICs/README.md` resolve to files that exist.
- All 99 test paths cited across the validation records exist in the tree.
- Source paths cited in validation records resolve, except fixture paths inside
  synthetic corpora (`src/auth/login.ts`, `src/billing/*`, etc.), which are
  dataset content and not repository files.

## 4. Tests executed

Two full runs of `vitest run` in the isolated worktree against a real PostgreSQL
container, plus targeted isolation runs and hand-built adversarial fixtures.

| Run | Result |
| --- | --- |
| Full suite, worktree without a prior `npm run build` | 163 files: 161 passed, 2 failed; 3387 tests: 3345 passed, 1 failed, 41 skipped; 541 s |
| Full suite after `npm run build` | 163 files: 161 passed, 2 failed; 3387 tests: 3345 passed, 1 failed, 41 skipped; 551 s |
| `tests/integration/packaging.test.ts` + `tests/integration/git/discovery.test.ts` in isolation | 72 tests: 71 passed, 1 failed (packaging, grammar assertion — see F-72) |

Both full runs failed the same two files, and in both runs **all 34 packaging
tests were skipped** because the suite's `beforeAll` exceeded its 300 s hook
timeout under full-suite contention. The `41 skipped` line in the summary is
34 packaging + 4 docker + 3 signals.

## 5. Independent verification

Fourteen independent reviewers were run in parallel, all fourteen reported, each given a specific
hostile question rather than a general request to assess quality (for example
"find one way EPIC-021 can claim provider correctness while the implementation is
wrong", "find a case where incremental synchronization silently loses records"),
each required to cite `file:line` with quoted code and to reproduce by execution.

Every finding recorded below was **re-verified by the author of this document
against the source at the base commit** before being written down. Findings that
could not be re-verified were dropped.

---

## 6. Findings

**P0** correctness / security / data-integrity failure · **P1** significant functional or
reliability defect · **P2** meaningful edge case or maintainability issue · **P3** minor.
Every entry was re-verified against the source at `0407618` by the author of this
document. Findings that could not be re-verified were dropped.

**Totals: 100 findings — P0 1 · P1 34 · P2 44 · P3 21.** Identifiers are stable, not
sequential by severity.

### P0

**F-01 · EPIC-031 / 075 / 076 — history is capped at 1 000 commits per run and the watermark is advanced past the commits that were never read.**

`readHistory` reads at most `MAX_COMMITS_PER_READ = 1_000` and reports `truncated`
(`src/git/history.ts:34`, `:164-166`). The Git provider turns that into a resume cursor
(`src/git/provider.ts:507-509`). The indexer's port type does not declare the field —
`readHistory(…): Promise<{ commits: readonly { committedAt: string }[] }>`
(`src/indexing/indexer.ts:220-224`) — so it is discarded; there is one call and no loop
(`:750-760`), and the watermark is then set to the **newest** commit of the page
(`:798`, `newest()` at `:1152-1168`). `git log` returns newest-first
(`src/git/history.ts:140-146`), so truncation drops the *oldest* commits while the cursor
jumps to the *newest*.

Contrast `listBranches` (`:218`) and `listFiles` (`:238`), which both declare `cursor` —
one of them with the comment that its absence is "precisely why ref retirement could not
be built". The signal exists at both lower layers and is dropped at the port.

Reproduced on a 1 005-commit fixture, real `GitSourceProvider`, no flags:
```
run 1: commitsRead=1000 incremental=false watermark=2020-01-01T00:16:45Z
run 2: commitsRead=1    incremental=true  watermark=2020-01-01T00:16:45Z
commit entities ever written: 1001        (c1–c4 never seen by any run)
a --full run (since undefined, no limit): commits=1000 truncated=true
```

**Impact.** Any repository with more than 1 000 commits silently loses all history older
than its newest 1 000 — permanently, with no error and exit 0. Falsifies EPIC-031 AC-4
("`--full` re-reads everything") and undermines EPIC-032's tombstones, which depend on the
deleting commit being read. Ferret's own repository is under the cap, which is why
dogfooding never showed it.

**Fix.** Declare `cursor` on the port and page until it is absent; or, when truncated,
advance only to `min(committedAt)` and report `historyTruncated`. Never advance to `max()`
on a bounded read.

### P1

**Synchronization**

**F-02 · EPIC-075/076 — every branch shares one watermark in every shipped command path.**
`watermarkScopeId` maps both `undefined` and `'HEAD'` to the bare repository id
(`src/indexing/indexer.ts:1106-1109`). `ferret index` defaults `--revision HEAD`
(`src/cli/commands/index-command.ts:61`); `ferret reconcile` passes no options at all
(`src/cli/commands/reconcile.ts:177`). The per-revision scoping therefore never applies.
Indexing `main`, then a feature branch whose commits predate `main`'s tip, loses that
branch's history: `index on master (HEAD): commitsRead=2` → `index on feature (HEAD):
commitsRead=0`, one cursor row, `f1`/`f2` absent for ever. The failure is described and
declared closed at `src/indexing/indexer.ts:489`, and
`tests/integration/indexing/index-lifecycle.test.ts:641` pins the collision in place.

**F-03 · EPIC-075/076 — one future-dated commit stops ingestion indefinitely, and health reports OK.**
`newest()` never moves the watermark backwards and never clamps it to the present
(`src/indexing/indexer.ts:1152-1168`); its docstring names "a wrong clock" and then chooses
the direction that turns it into unbounded loss. One commit dated 2035 →
`run 2 (3 new commits pushed): commitsRead=0 incremental=true`, exit 0, and the
`synchronization` health component reports `last advanced 0s ago` because the cursor is
rewritten on every run regardless (`src/diagnostics/probe.ts:274`, status hard-coded `OK`).

**F-04 · EPIC-076/006 — a merged older branch becomes parentless placeholder commits the graph presents as real.**
`since` is passed to `git log --since` (`:755`), a commit-date filter, not a reachability
filter. After `git merge --no-ff` of a branch dated before the watermark, one branch commit
is absent entirely and the other is written as a stub carrying only
`{"sha":…,"parents":[]}` through the `ifAbsent` path (`:512-518`) — a commit asserted to
exist with no author, no message and no parents, which the advancing watermark then buries.

**Answer truthfulness**

**F-05 · EPIC-048/046/057 — a deleted file is answered in the present tense, with "nothing was found to be missing".**
`grep -rn "lifecycle" src/context/*.ts` returns nothing. `src/context/answer.ts:411-414`
fetches evidence and nothing else; `:500-514` lists seven `partial` conditions, none of
which is lifecycle; `:781-784` renders `kind`, `id`, `source` and not `lifecycle`;
`:823-825` prints the "nothing was found to be missing" line.

Verified live against Ferret's own index by the author of this report.
`docs/EPICs/EPIC-001-Foundation-and-Bootstrap.md` was removed in `22f6f33`.
`ferret_get_entity` → `"lifecycle": "deleted"`. `ferret_answer` on the same path:
```
verdict: answered — … 1 claim(s) about it are supported by recorded observations.
1. attributes.path = "docs/EPICs/EPIC-001-Foundation-and-Bootstrap.md" [current]
## what Ferret does not know
- nothing was found to be missing
```
`ferret_why` on the same id: `"held": true`, `"integrity": "verified"`, a locator naming
the missing path, `"conflicts": []`. The surface whose contract is truthful absence asserts
a deleted file exists and states that nothing is missing. EPIC-057 demoted deleted entities
in *ranking* only. Not rated P0 because the record is faithfully reported and no data is
lost; what is missing is the qualifier.

**F-06 · EPIC-008/047 — supersession keyed on `(subject, field, sourceSystem)` discards every member of a multi-valued field but the last.**
`src/storage/evidence.ts:276-292` — the predicate carries no producer, statement or
locator. Three shipping producers use `field` as a collection, one row per member:
`references` (`src/indexing/content.ts:1021-1041`), `resolves` and `body.reference`
(`src/project/model.ts:335-344`). Every observation after the first is marked `superseded`.
`detectConflicts` cannot see it because all the rows share one source system
(`src/domain/evidence.ts:475`). The discarded rows are then rendered by
`src/context/evidence-selection.ts:288-291` as "state superseded, replaced by a newer
observation; a current record covers `references`" — a positive claim that is false.

**F-07 · EPIC-047/048 — recording a conflict is what hides it.**
`reconcileConflicts` rewrites both disagreeing rows to `conflicting`
(`src/storage/evidence.ts:551`, `:557`), and runs on every index
(`src/indexing/indexer.ts:793`). `conflictsFor` (`:485-492`) and `ferret_why`
(`src/mcp/server.ts:718`) both read `state = current`, and `EvidenceQuery.state` is an
equality rather than a set (`:359`). Measured: `conflictsFor` before reconcile 1 group,
after 0; a subject whose only evidence is a marked conflict answers `held: false`. The same
file argues the opposite for its own write path at `:284-290`, using
`inArray(state, [CURRENT, CONFLICTING])`.

**F-31 · EPIC-052-053/058 — `ferret_find` and `ferret_neighbours` drop permission-withheld rows silently, and `ferret_find` then asserts `truncated: false` on a partial answer.**
`findEntities` and `neighbours` filter *after* `LIMIT` into a `WithheldTally` constructed
inline and never read (`src/storage/retrieval.ts:278`, `:384`); neither port method has a
channel to return it (`src/retrieval/query.ts:342-344`), so `truncated` is derived from the
post-filter length (`src/mcp/server.ts:606-619`). `ferret_neighbours` reports `withheld` on
the `depth > 1` branch (`:508`) and has no such field on the depth-1 branch every client
takes (`:514-534`). Measured against the live index (638 `file` entities): with
`datasets/**` excluded, `ferret_find` returns `count=6, truncated=false` and no `withheld`
field exists on the tool. The `search` path threads a real tally and does surface it — the
same reasoning was never applied to the exact path.

**F-32 · EPIC-059/084 — pack trimming cuts off the content-containment closing delimiter.**
`ContextPackBuilder` contains attributes first (`src/context/pack.ts:382-385`,
`src/security/containment.ts:65`) and then slices the already-wrapped string
(`src/context/pack.ts:565`). The opening delimiter survives and the closing one is cut, so
every field after the trimmed one — including Ferret's own `reason` and `omitted` — falls
inside a region the notice tells the model to treat as quoted repository data.
Reproduced deterministically (`has OPEN delimiter: true / has CLOSE delimiter: false`) and
corroborated live through `ferret_context_pack`. `contentSafety.marked` still fires, so the
smell is reported while the mechanism is broken.

**External project knowledge** — all of the following live in code no shipped command
reaches (see F-21), which caps their present blast radius but not their status as defects
in `VALIDATED` Epics.

**F-08 · EPIC-071/072 — every Jira issue is rejected by the canonical model.**
Jira Cloud returns `2026-01-09T10:11:12.000+0000`. The provider passes it through verbatim,
correctly per contract (`src/jira/provider.ts:421-422`;
`src/providers/contracts/source-project.ts:98` — "ISO-8601, as the source reported it").
The domain uses `z.iso.datetime({ offset: true })` (`src/domain/entity.ts:103`,
`src/domain/attributes.ts:47`), which rejects the `±HHMM` form. Verified directly on zod
4.5.4: `+0000 REJECTED`, `+00:00 ACCEPTED`, `Z ACCEPTED`. End to end:
`skipped: [{ reason: 'Entity is not valid — sourceObservedAt: Invalid ISO datetime' }],
entities: []`. The Jira suite's own fixture uses the real format
(`tests/unit/jira-provider.test.ts:97-98`), and no test file both constructs a
`JiraProvider` and calls `modelProject` — EPIC-071 §17's claim that `modelProject` "needed
no change at all" was never executed.

**F-09 · EPIC-072 — an unmerged pull request is recorded as proposing a merge commit.**
The edge is gated on `mergeCommit !== undefined` (`src/project/model.ts:257-260`), directly
under a comment stating that only a merged pull request may propose one; `pull.lifecycle`
is never consulted, and the provider maps `merge_commit_sha` independently of `merged_at`
(`src/github/provider.ts:492-494`). GitHub populates that field for open and
closed-unmerged pull requests. The AC-5 test builds its "open" PR by setting
`mergeCommit: undefined` (`tests/unit/project-modeling.test.ts:124-136`) — asserting the
field the code branches on rather than the state the requirement names. Each such edge also
mints a permanent orphan `commit` placeholder.

**F-10 · EPIC-051/072 — one issue is modelled twice in one repository, and the resolver is structurally unable to reconcile it.**
`modelProject` derives an issue under the provider's stable id (`src/project/model.ts:181`)
and, for a closing reference in a PR body, under `owner/repo#N` (`:313-320`).
`pull_request_resolves_issue` points at the second. The comment at `:315-317` names EPIC-051
as the remedy; `src/resolution/propose.ts:235` skips same-system pairs, so it can never
fire. Reproduced: two `issue` entities for issue 9 in one scope, the edge on the bare one,
`proposeResolutions` returning `[]`.

**F-13 · EPIC-021 — a rate-limited GitHub is reported as a bad credential that must never be retried.**
`#error` classifies every `403` as `SOURCE_UNAUTHORIZED`, `retryable: false`
(`src/github/client.ts:300-303`, `:316`); the identical condition as `429` is
`SOURCE_UNAVAILABLE`, retryable. `#retryDelay` already distinguishes them by
`x-ratelimit-remaining` (`:266-272`); `#error` does not consult it. `checkDependencies`
then advises "Set a valid GitHub token" while the token is valid and the budget is spent.
AC-11's test asserts an error *message* against a 403 fixture and never the classification.

**F-14 · EPIC-021 — the rate-limit budget latch never expires.**
`#assertBudget` never consults `resetsAt` (`src/github/client.ts:205-207`); once one
response reports `remaining <= reserve`, every later request is refused for the life of the
process, and the only thing that could refresh the state is a response that is never sent.
Measured: reset ten seconds in the past, three requests refused, `requests actually sent: 1`,
remediation "Wait until <an instant already past>".

**F-15 · EPIC-021 (latent) — a cursor or `Link` URL is followed verbatim and receives the token.**
`#url` uses `request.path` unchanged when it starts with `http` (`:176-177`), `#headers`
attaches `Authorization: Bearer` unconditionally (`:194`), `paginate` follows `rel="next"`
to whatever host it names (`:160-174`), and `provider.ts:313` passes `query.cursor` through.
The second implementation of the same contract refuses a cursor it did not issue
(`src/jira/provider.ts:276-283`) and always builds `#baseUrl + path`. No `src/` path feeds a
stored cursor today; a `Link` header from a proxy or a misconfigured GHES reaches it with no
cursor at all.

**F-21 · EPIC-021/071/072/073/077 — the external-knowledge cluster has no product entry point, and the command surface does not say so.**
Established by the author of this report:
`grep -rn "createGithubProvider|createJiraProvider|modelProject|modelReleases" --include=*.ts src`
outside those directories returns only `src/index.ts` — the package barrel. No CLI command
and no MCP tool ingests GitHub or Jira. `PLANNED_COMMANDS`, built precisely so that
"nothing is silently ignored and nothing is falsely advertised as working", is empty
(`src/cli/commands/planned.ts:48`). Five Epics marked `VALIDATED` deliver library surface no
shipped command reaches, and the project's own honest-disclosure mechanism is not used for
them.

**Identity and provenance**

**F-11 · EPIC-036/009 — a non-address author string becomes a canonical developer id, merging distinct humans by construction.**
`normalizeGitIdentity` refuses only the *empty* address; any non-empty string without `@`
is kept as an opaque identity whose `comparable` is the raw string
(`src/identity/git-identity.ts:112-124`), and the provider derives the entity id straight
from it (`src/git/provider.ts:637-639`). Two authors sharing `unknown` or `(no author)` —
what `git filter-branch` and `cvs2git` emit — become one developer. The comment two lines
above the derivation claims the opposite guarantee: "No address means no identity.
Inventing one from a display name would merge every 'unknown' author in the repository into
one person." Irreversible: `canonicalId` is a pure function of `comparable`, so the merge
happens at derivation time and `IdentityStore.merge` — "the only thing that merges" —
records nothing.

**F-12 · EPIC-009/036 — `IdentityStore.merge` moves aliases but no relationships, and records the merge even when the merge failed.**
Verified across `src/storage/identities.ts:278-366`: the method contains no
`update(relationship)` and no `RelationshipStore` call other than one `assert`, so after an
adjudicated merge every `developer_authored_commit` still references the retired actor and
the survivor gains none of the history. That `assert` sits in a `finally` block outside the
transaction (`:341-364`), so the `entity_supersedes_entity` row is written even when the
transaction threw and rolled back, and it ends in `.catch(() => undefined)`, so a failure to
record leaves the merge reported successful. `ENTITY_SUPERSEDES_ENTITY` has exactly one
non-declaration occurrence in `src/` — the write itself; nothing reads it. `SUPERSEDED` only
lowers a rank (`src/retrieval/freshness.ts:38`).

**Platform and packaging**

**F-16 · EPIC-002/054 — `ferret init` migrates before it installs pgvector, so `ferret.embedding` is never created and the schema version says it was.**
`migrate()` runs inside `onInitialize` (`src/storage/provider.ts:195`);
`provisionExtensions` runs afterwards from the command body
(`src/cli/commands/init.ts:80-83`). Migration `0008` is guarded on `to_regtype('vector')`
(`src/storage/migrations/0008_embeddings.sql:46-51`), NULL on a fresh database, and is
recorded as applied; migrations are forward-only, so no later `init` can create the table.
Reproduced against a real `pgvector/pgvector:pg17`: `schemaVersion 12, pending 0`,
`embedding table: null`, `EmbeddingStore.count -> Failed query`. The extension check
reports OK, so health is green while the semantic path is permanently broken, and
`src/retrieval/planner.ts:251` swallows the `42P01` into the wrong explanation. The test
that would catch it creates the extension *before* migrating
(`tests/integration/retrieval/embeddings.test.ts:100-103`) — it encodes the ordering the
implementation needs rather than the one it has.

**F-17 · EPIC-089/090 — `ferret export` can write a backup it reports as successful and `ferret import` refuses as damaged.**
Export passes each assembled JSON line through `redactSecrets`
(`src/storage/export.ts:272-276`), which fails closed on size: over 1 000 000 characters the
*entire* input is replaced by an English sentence (`src/security/secrets.ts:64-71`). The
digest is taken over the replacement, so the trailer verifies; the importer then rejects the
line (`src/storage/import.ts:168-173`). One 189 000-byte `content_blob` row is enough,
because `JSON.stringify` expands control characters six-fold — well under the 512 KiB
storage bound. Measured: `export reported success … IMPORT REFUSED: Row 2 is not JSON`.

**F-29 · EPIC-090 — the import path interpolates column names taken from the document into SQL.**
`JSON.parse(line) as ExportRow` is a cast, not a parse (`src/storage/import.ts:168`), and
the column names are then interpolated as quoted identifiers with no escaping and no
allowlist (`:287`, `:316` — `sql.raw(columns.map(c => `"${c}"`).join(', '))`). EPIC-090 §11
states the opposite: "every row goes through the same `createEntity`/`createRelationship`
validation an observation does" — neither symbol appears in the file. Demonstrated: a
crafted row key breaks out of the identifier quoting and lands in the statement text, not in
a parameter. Recorded P1 rather than P0 because exploitation requires an operator to
`--apply` an untrusted archive — a trust boundary the command already crosses — and
node-postgres' extended protocol confines it to a single statement; it nonetheless
escalates "arbitrary rows in known tables" to "arbitrary SQL as Ferret's role".

**F-30 · EPIC-089/106/003/091 — `ferret export --backup-command` prints the database password to stdout with exit 0.**
`backupCommandFor` interpolates `FERRET_DATABASE_URL` verbatim
(`src/storage/export.ts:455-458`); both callers pass raw `process.env`
(`src/cli/commands/export.ts:58`, `src/cli/commands/upgrade.ts:303`). The repo's own
redactor handles this exact shape (`src/errors/redact.ts:96-97`) and is not called.
EPIC-106 §11 claims "No credential appears in the plan". Reproduced by the author of this
report:
```
$ FERRET_DATABASE_URL='postgresql://ferret:NOTAREALPASSWORD123@db.internal:5432/ferret' \
  node dist/cli/main.js export --backup-command --json
{ "ok": true, "data": { "backupCommand": "pg_dump … \"postgresql://ferret:NOTAREALPASSWORD123@db.internal:5432/ferret\"", … } }
exit=0
```
The unit test picks a URL with no userinfo (`tests/unit/export.test.ts:240-246`), so the
credential case is never exercised.

**Provider platform**

**F-18 · EPIC-016/099 — the conformance gate certifies a provider it never started.**
`runConformance` reports `ok ferret.source.jira` with **11 of 19 checks skipped** —
every lifecycle check and both secret canaries — because the harness passes no `options` and
the provider's `configSchema` then rejects the planted configuration
(`src/providers/sdk/conformance.ts:295-303`), while `conformant` is `failed === 0`
(`:171-172`). Observed in this audit's own suite log:
`ok ferret.source.jira 8 passed, 0 failed, 11 skipped`. Proven by construction: a provider
that throws from a second `initialize`, throws from a bare `shutdown` and logs its declared
secret fails 3 checks with no schema — and **passes** with a strict one
(`conformant? true pass=8 fail=0 skip=11`, `assertConformant` does not throw).

**F-19 · EPIC-011 — a provider may declare a capability it does not implement, and registration accepts it.**
`validateCapabilityDeclaration` checks the capability name, the version range and that
`operations` is non-empty; it never inspects the provider object
(`src/providers/capabilities.ts:214-262`), and its own docstring states that such a
provider "is a **defect, not a degradation**" that registration exists to refuse.
`src/providers/registry.ts:135` is the only call site and passes only the declaration.
A provider with no methods at all registers, is returned by `forCapability`, answers
`supported` per operation, and passes conformance.

**F-20 · EPIC-039/040/041/042/043 — the whole Session & Agent Memory domain is unreachable.**
Verified: outside `src/domain/`, the only reference to any of those modules in `src/` is a
comment, and no migration mentions a session table. Five P0 Epics are registry-`VALIDATED`
for a capability with no store, no table, no CLI command and no MCP tool — a checkpoint
exists only in the creating process's heap. Each Epic's validation record discloses its own
slice honestly (EPIC-041's says plainly "Nothing persists a checkpoint"); the aggregate is
stated nowhere.

**File and code intelligence**

**F-22 · EPIC-029 — every ATX heading in a CRLF Markdown file is silently reclassified as prose.**
`linesOf` splits on `'\n'` (`src/parsers/text/markdown.ts:61`), so a line arrives as
`'# Title\r'`; `ATX = /^(#{1,6})\s+(.*)$/` (`:27`) cannot match it. Verified:
`node -e "…ATX.exec('# Title\r')"` → `null`. End to end: `LF headingCount=3` vs
`CRLF headingCount=1`, `parsed: true` and `warnings: []` in both. The sibling patterns
escape only because they end in `\s*$`.

**F-23 · EPIC-028 — a corrupt spreadsheet is reported as a successful parse of an empty one, and the result is cached permanently.**
`readSheet` is a regex scanner with no validity check (`src/parsers/sheet/xlsx.ts:243`,
`:247`, `:270`): a truncated, garbage or non-XML worksheet part yields zero rows and the
same return shape as an empty sheet. Only a missing `xl/workbook.xml` throws (`:80-88`) —
under a comment stating the rule the rest of the module does not keep: "'empty' and
'unreadable' must not be the same answer." Measured across five corruptions:
`PARSED segments=0 warnings=[] cellCount=0` for all. EPIC-108 then records the empty result
and the gate skips the file on every later run.

**F-24 · EPIC-024/029 — byte spans do not name the bytes they claim, for BOM'd, UTF-16 and multi-paragraph plain-text files.**
Detection strips the BOM (`src/parsing/detect.ts:263`) while parsers recompute offsets over
the stripped, decoded text (`src/parsers/text/markdown.ts:57,62`), and `#plain` hard-codes
the paragraph separator at 2 bytes while splitting on `/\n\s*\n/`
(`src/parsers/text/provider.ts:117,139`). `validate()` only checks `endByte <= sizeBytes`
(`src/parsing/framework.ts:346`), so all of it passes. Slicing the original buffer by the
reported span: UTF-8 BOM off by exactly 3, UTF-16 pointing at unrelated bytes, plain text
drifting per blank line. LF, CRLF and multi-byte Markdown spans are correct.

**F-25 · EPIC-035 — a member call resolves to a same-named declaration in the same file, at the highest confidence band.**
`resolveReferences` applies the `same-file` rule before it checks `reference.qualified`
(`src/code/references.ts:144-182`); the guard sits only in front of the repository rule at
`:179`. Verified live by the author of this report:
`ferret_neighbours(ProviderRegistry.has, direction: in, types: [symbol_references_symbol])`
returns **8 inbound edges**, every one `rule: "same-file"`, and every cited line (99, 233,
256, 257, 344, 408, 412, 438 of `src/providers/registry.ts`) is a `Map`/`Set` `.has()` call
on a private field. EPIC-035 §17 and its validation record state this class was eliminated;
it was reduced from repository-wide to file-scoped and left at STRONG (0.95).

**F-25b · EPIC-035/049 — the same live query shows duplicate open edges for one call site.**
Two of those eight rows are the same edge recorded twice with different `line` metadata and
both `validTo: null` (`checkAll` at lines 408 and 412; `describe` at 256 and 257, from two
index runs). `#findOpenEquivalent` requires byte-identical metadata
(`src/storage/relationships.ts:336`) and the line number is in it
(`src/indexing/content.ts:994-999`), so an edit that shifts a call inserts a second open
interval. Nothing ever ends a content edge: the indexer only calls `assert`
(`src/indexing/indexer.ts:712-714`), and the only `retire` caller in `src/` is the entity
lifecycle sweep (`:925`).

**F-26 · EPIC-035 — imported names are refused, so cross-file references in TS/JS never resolve.**
The parser collects every identifier in every import statement
(`src/parsers/code/provider.ts:233-236`) and the resolver refuses the repository rule for
any of them (`src/code/references.ts:170-173`). Since calling a name from another module
requires importing it, the two rules cancel. On Ferret's own `src/indexing/content.ts`:
`extracted=88 resolved=16`, with `resolveReferences:imported`; on
`src/code/references.ts`: `extracted=22 resolved=0`.

**F-27 · EPIC-035/050 — "nothing references this" and "we refused to resolve most of the references" are the same answer.**
`UnresolvedReference[]` is aggregated into counters and a `logger.debug` line and then
discarded (`src/indexing/content.ts:943`, `:1046-1053`); nothing is written against the
symbol, the file or the run, and `ferret_neighbours` returns a bare count
(`src/mcp/server.ts:514-534`). Measured on Ferret's own source: `registry.ts` 141
extracted / 51 resolved; `content.ts` 88 / 16; `references.ts` 22 / 0. EPIC-035 §12 asserts
"the unresolved count is the number that matters"; it is computed and thrown away. This is
what makes a dead-code or impact answer dangerous.

**F-28 · EPIC-050 — a traversal truncated by the per-hop SQL `LIMIT` is returned as complete.**
The global result limit is passed down as each hop's `LIMIT`
(`src/storage/retrieval.ts:438`, `:499-502`), so neighbours are cut in the database where
`traverseFrom` cannot observe it (`src/retrieval/traverse.ts:80-83`, `:110`). Over a root
with 80 leaf neighbours: `depth=2 paths=50 truncated=undefined`. At `depth: 1` — the default
and every existing caller — no bound is reported at all.

**Git ingestion**

**F-94 · EPIC-019/017 — repository-controlled `i18n.logOutputEncoding` shreds `git log`, collapses history, and mints commit entities under attacker-chosen SHAs.**
`SAFETY_CONFIG` overrides eleven repository-controlled keys and its own docstring states
the scope: "Each entry disables a key whose value names a program"
(`src/git/runner.ts:45-71`). No key that changes `git log`'s *output shape* is overridden.
`i18n.logOutputEncoding=UTF-16` re-encodes the `--format` output while leaving the
`--name-status` region as raw bytes; `runGit` decodes as UTF-8 unconditionally (`:210`), and
`parseLog`'s outer loop resynchronises on the first raw 40-hex token it finds
(`src/git/history.ts:199-206`) — which is a **file path the repository chose**. Commit
identity is deliberately global and unscoped (`src/git/provider.ts:709`).
Reproduced: nine real commits in, **one** fabricated commit out, carrying
`"sha": "0407618e2001435f2ec861f324ed75cd5e5e08be"` — this repository's own HEAD, taken
from a filename — with 60+ single-character paths as its changes.
**Precondition, stated precisely:** the attacker must control `.git/config` in the indexed
working directory. Verified by the author of this report that `git clone` does **not**
propagate this key, so it is not a clone-borne attack; it is the same precondition
`SAFETY_CONFIG` already exists to defend against (hooks, pager, credential helper), and
under that established threat model the output-integrity half is undefended.
EPIC-019 §11's claim that "the same overrides apply" is true for execution and false for
output. Fix: add `i18n.logOutputEncoding=UTF-8`, `i18n.commitEncoding=UTF-8`,
`core.quotePath=false`, `log.showSignature=false`; and require the same
`looksLikeCommitStart` shape check in the outer loop that the inner loop already uses.

**F-95 · EPIC-019 — one commit with an unrepresentable date desynchronises `parseLog`, discards the rest of the page, and fabricates file entities.**
Git emits the literal `%aI`/`%cI` when it cannot parse a date, and `+999:99` for an
out-of-range timezone. Neither matches `isInstant` (`src/git/history.ts:251-253`), so
`looksLikeCommitStart` (`:237-249`) never recognises the boundary, and the inner change loop
consumes the real commit header as `--name-status` entries — stepping over subsequent
genuine boundaries two or three tokens at a time and never resynchronising
(`:214-221`). Three commits in, one out, with eleven invented changes, and
`emitHistory` writes every one into the graph as a `file` entity —
`{"path":"%aI"}`, `{"path":"a@x.com","extension":"com"}`,
`{"path":"2023-11-14T22:13:20Z"}` — with `truncated: false` and no signal of any kind.
This is worse than loss: it asserts data that does not exist. The parser fixture hardcodes
a valid date for both fields (`tests/unit/git-history-parser.test.ts:35-49`), so the
assumption is never tested against what git actually emits, and the malformed-region test
uses the safe `withChanges: false` path.

### P2

| ID | EPIC | Fact | Evidence |
| --- | --- | --- | --- |
| F-33 | 036 | No Unicode normalization: NFC and NFD spellings of one mailbox are two developers, and neither proposer can surface the pair | `src/identity/git-identity.ts:108-134`; no `normalize('NF…')` anywhere in `src/identity/` |
| F-34 | 036 | `noreply@github.com` — a shared address many humans used — is on the service list, so N people collapse into 1 `agent` of the wrong entity type, uncorrectable because `merge` refuses to cross the class boundary | `src/identity/git-identity.ts:71-82`, `:172-174`; `src/git/provider.ts:626-628`; `src/storage/identities.ts:293` |
| F-35 | 051 | `login` is guarded with `!== undefined` while `displayName` one line below is guarded for emptiness, so two actors with `login: ''` propose `same-username`; a placeholder `email` reaches `same-address` at 0.95 | `src/resolution/propose.ts:174-185`, `:189-194` |
| F-36 | 051 | `foreignRepositoryScope` documents an id agreement it does not produce; equal-confidence proposals reorder with input order; login comparison is case-sensitive | `src/project/model.ts:504-514`; `src/resolution/propose.ts:110-114`, `:121`, `:174` |
| F-37 | 021 | The returned `ProjectPage` carries an undeclared `raw` field holding the unfiltered GitHub JSON, re-introducing the pull-requests-as-issues double count AC-3 removes from `items` | `src/github/provider.ts:206-215`, `:299`, `:321-327` vs `src/providers/contracts/source-project.ts:224-229` |
| F-38 | 021 | The `pageSize` provider option is validated and never read; the Jira twin does read it | `src/github/provider.ts:59`, `:315` vs `src/jira/provider.ts:157` |
| F-39 | 021 | `paginate` has no visited-URL check and no page cap: a `Link` whose `rel="next"` repeats loops for ever, unbounded when rate-limit headers are absent | `src/github/client.ts:160-174` |
| F-40 | 021 | A 2xx whose body is not JSON, or is JSON but not an array, escapes as a raw `SyntaxError`/`TypeError`, bypassing the error taxonomy and exit-code map | `src/github/client.ts:143-146`; `src/github/provider.ts:212` |
| F-41 | 088 | `prune --blobs` re-checks a predicate rather than taking a lock; at READ COMMITTED a concurrent indexer's uncommitted `file_version` is invisible and its content is deleted (AC-14 violated, reproduced live) | `src/storage/retention.ts:157-172` |
| F-42 | 088/087 | The anti-join has no lifecycle filter and `file_version` is content-addressed and append-only, so the reclamation target is empty by construction: content leaks for ever and is never reclaimed | `src/git/provider.ts:1050-1057`; `src/storage/retention.ts:137-145` |
| F-43 | 088/009 | Pruning superseded evidence NULLs `identity_alias.evidence_id` (`ON DELETE set null`) with no cascade guard and no report line; `evidence.superseded_by` has no FK at all | `src/storage/migrations/0005_identity_aliases.sql:78`; `src/storage/retention.ts:209-221` |
| F-44 | 089/090 | Export's line-level redaction rewrites indexed values (e.g. a key-shaped string in a commit message) while exporting `content_hash` unchanged; `sameContent` compares only the hash, so re-import reports `unchanged` | `src/storage/export.ts:272-276`; `src/storage/import.ts:384-387` |
| F-45 | 089 | `EXPORT_TABLES` omits `ferret.embedding` and `ferret.instance`, so a restore silently drops every vector and mints a new instance identity; neither Epic mentions embeddings in scope or non-scope | `src/storage/export.ts:45-55` |
| F-46 | 042 | A memory's id is keyed on `(sessionId, kind, statement)` while its `contentHash` also covers `rationale` and `origin`, so an `EXTRACTED` memory silently overwrites a human's `EXPLICIT` one (0.95 → 0.6) | `src/domain/engineering-memory.ts:122-127`, `:181-187` |
| F-47 | 042 | Statement truncation is applied before both the id and the hash, so a constraint and its exact negation become one record | `src/domain/engineering-memory.ts:158-160` |
| F-48 | 041 | Two callers advancing the same `previous` both produce sequence 2, share one id, carry different hashes and both self-verify | `src/domain/session-checkpoint.ts:70`, `:93` |
| F-49 | 100 | The control-reachability sweep — the suite built to catch "a control with a passing test and no caller" — enumerates only `security` and `authorization`, so `verifySessionCheckpointIntegrity` is invisible to it | `tests/security/control-reachability.test.ts:57` |
| F-50 | 101 | The scale benchmarks import only a null logger and the migrator; every measured read path is hand-written SQL, so a regression inside `RetrievalStore` is invisible to every budget | `tests/integration/storage/scale.test.ts:8-10`, `:497` |
| F-51 | 101 | The published 1.08× permission-filter cost is measurement noise — no warm-up discard, sequential sampling — and re-measured 0.95× on this machine, i.e. the filter "faster" than no filter | `tests/integration/storage/scale.test.ts:111-113`, `:494-519` |
| F-52 | 093/108 | `ferret index --content` with no parser available degrades to metadata-only, exits 0, and produces a report byte-identical to a run that never asked for content; both diagnostics are `logger.info` under a default level of `warn` | `src/cli/commands/index-command.ts:236-270`, `:334-340`; `src/config/schema.ts:127` |
| F-53 | 074 | The pre-import manifest gate runs only when the caller supplies a `readManifest`, and no implementation exists in `src/`; both production call sites pass a bare loader | `src/providers/discovery.ts:227`, `:248-255`; `src/cli/commands/index-command.ts:108`; `src/cli/commands/verify.ts:100` |
| F-54 | 011/071 | `listReviews` requires a numeric pull-request id while every identifier the contract returns is a string; `listComments` was widened for Jira and `listReviews` was not | `src/providers/contracts/source-project.ts:79`, `:122`, `:285`, `:289` |
| F-55 | 071 | The JQL filter uses `resolution` and the lifecycle mapping uses `statusCategory`, so `listIssues({state: OPEN})` returns items labelled `closed` and an issue closed without a resolution is unreachable by `state: CLOSED` | `src/jira/provider.ts:236-237`, `:364-366` |
| F-56 | 071 | `jqlInstant` slices the offset off the `since` value, and JQL evaluates a bare instant in the Jira user's timezone — an incremental read that skips issues | `src/jira/provider.ts:249` |
| F-57 | 071/072 | `addIssue` reads only `issue.number`, so the Jira `key` the contract gained for exactly this purpose never reaches the graph, and the AC-15 state locator is gated on the same field | `src/project/model.ts:186`, `:204-207` vs `src/domain/attributes.ts:229-230` |
| F-58 | 073 | The release exclusion walk is capped like the forward walk and returns no truncation signal, so on a large history a release is reported as containing commits the previous release already contained, `truncated: false` | `src/project/ancestry.ts:88-108` |
| F-59 | 073 | `deployedAt` prefers the latest status's `createdAt`, so a superseded deployment records when it *stopped* being production | `src/project/releases.ts:244-248` |
| F-60 | 028 | The ZIP inflate bound is checked against the archive's own declared uncompressed size and `inflateRawSync` is called with no `maxOutputLength`: a 204 KB archive inflated to 200 MiB, 3.1× past the 64 MiB bound | `src/parsers/sheet/zip.ts:85-92`, `:121` |
| F-61 | 027 | `.docx` bypasses Ferret's bounded ZIP reader entirely — `mammoth`/`jszip` inflates with no cap and the block/character limits apply after materialisation: 353 KiB → 480 MiB RSS over 5.7 s, uninterruptible | `src/parsers/office/document.ts:88-91`, `:111-135` |
| F-62 | 108 | A parse failure's `reason`, `detail` and `parserId` are never logged or persisted, and the failed file is recorded as a valid artefact, so the gate reports it unchanged for ever and it leaves the unparsed breakdown | `src/indexing/content.ts:400-407`, `:696-736` (contrast the unreadable path at `:344-350`) |
| F-63 | 085 | No audit event is produced by any MCP path: the composition root never constructs an `AuditWriter`, `ConfigToolDependencies` has no field to accept one, and both `createDestructiveToolGuard` call sites omit it | `src/cli/commands/mcp.ts:79-137`; `src/mcp/server.ts:233-238`; `src/mcp/config-tools.ts:110-115`, `:216`; `src/mcp/provider-tools.ts:210` |
| F-64 | 084 | Containment and classification are applied to top-level strings only; array elements and nested objects pass through unexamined and uncounted, so `contentSafety` reports "0 read as instructions" for content never inspected — reachable via `labels`, `emails`, `usernames` | `src/security/containment.ts:280-293`; `src/domain/entity.ts:92` |
| F-65 | 054-055 | Relaxation rewrites `' & '` to `' | '` in a rendered tsquery, so `a & !b` becomes `a | !b` — results selected *because* they lack the excluded term. Measured: strict 0 rows, relaxed 3 775 of 3 777, all `score: 0` | `src/storage/retrieval.ts:571-574`; `src/retrieval/planner.ts:168`, `:186-189` |
| F-66 | 059/060 | `ferret_context_pack` and `ferret_answer` put the content notice **last** in their default JSON response, under a key no other tool uses, contradicting the file's own header ("it comes first … an instruction that arrives after the content it governs has already lost") | `src/mcp/server.ts:63-66`, `:563`, `:675`; `src/context/pack.ts:352`; `src/context/answer.ts:565` |
| F-67 | 054-055 | `plan.partial` is constant `true` in the shipped default configuration (no embedding provider by design), so a healthy answer and a total retrieval outage are indistinguishable on the one field documented to distinguish them | `src/retrieval/planner.ts:239-249`, `:280`; confirmed in this audit's own live `ferret_search` output |
| F-68 | 060 | An answer pack can exceed its budget by 70% while dropping every claim: the loop stops when `stated` is empty and nothing states the overrun (live: `claims: []`, `estimatedTokens: 1194`, `budget: 700`) | `src/context/answer.ts:473-482` |
| F-69 | 003 | An unknown or misspelled key in the user configuration file is silently discarded — no error, no warning, absent from `config list --explain` — while `authorizationConfigSchema` alone is `.strict()`. `"excludes"` for `"exclude"` means a path the user believes is excluded is indexed | `src/config/schema.ts:112-126`; `src/config/resolve.ts:196-211` |
| F-70 | 102 | `scripts/copy-datasets.mjs` writes to **stdout** and is the last step of `build`, which is `prepack`, so `npm pack --json` / `npm publish --json` emits unparseable output; its two sibling scripts document this exact rule and obey it | `scripts/copy-datasets.mjs:28` vs `scripts/clean.mjs:9-12`, `scripts/copy-migrations.mjs:113-115` |
| F-71 | 081/091 | `FERRET_DATABASE_URL` is not in `CREDENTIAL_ENV`, so it survives `withoutCredentials()` and is inherited by every `git` subprocess — while Ferret itself treats that variable as credential-bearing in two other files | `src/security/credentials.ts:33-37`; `src/git/runner.ts:544`; `src/environment/detect.ts:63` |
| F-72 | testing | `tests/global-setup.ts` builds `dist/` with `tsc` + `copy-migrations` only, omitting `copy-grammars` and `copy-datasets`. On a clean tree `npm test` fails `packaging.test.ts` (tarball contains no grammars — reproduced in this audit's worktree); in CI it passes only because `npm run build` ran first, so what is packed is "current" for TS output and migrations and *stale* for grammars and datasets | `tests/global-setup.ts:44-48` vs `package.json` `build` |
| F-96 | 019 | One unrepresentable date aborts `emitHistory` for the whole page: no per-commit boundary, and `sourceObservedAt` is the raw string, so a 1 000-commit page containing one undatable commit yields **zero** entities (`FerretError … sourceObservedAt: Invalid ISO datetime`) | `src/git/provider.ts:706-720`; `src/domain/attributes.ts:190-191` |
| F-97 | 019/017 | On any non-zero `git log` exit, `readHistory` discards `result.stdout` entirely and returns an empty, non-truncated page — so a corrupt object mid-history throws away the commits git had already streamed and is byte-identical to a fresh repository, with no skip, reason or log above `trace`. `since` is never validated and takes the same path | `src/git/history.ts:157-162`, `:149` |
| F-98 | 019/036 | `committerName`/`committerEmail` are parsed on every commit and consumed nowhere; `commitAttributes` is `.strict()` with no committer field, so "who landed this change" is unanswerable for rebased, cherry-picked, `git am` and squash-merged history, while the committer's *timestamp* is stored. A bot-committed change with a human author records as entirely human | `src/git/history.ts:70-71`, `:339-340`; `src/git/provider.ts:761`; `src/domain/attributes.ts:184-197` |
| F-73 | testing | On this machine, both full-suite runs skipped **all 34 packaging tests** — the `beforeAll` exceeded its 300 s hook timeout under contention — and the summary reported them inside a single `41 skipped` figure. The secret-scan of shipped bytes and the reproducible-tarball gate therefore did not execute, and nothing in the output says so | this audit's runs; relates to open issue #130 |

### P3

| ID | EPIC | Fact | Evidence |
| --- | --- | --- | --- |
| F-74 | governance | 53 Epic specifications still carry `Status: APPROVED` or `IMPLEMENTED` while the registry records them `VALIDATED`; others (e.g. EPIC-007) were updated, so the two records disagree file by file | `docs/EPICs/*.md` headers vs `docs/EPICs/README.md`; `EPIC-SPECIFICATION-STANDARD.md:27-29` |
| F-75 | 079 | `23505 unique_violation` is in `TRANSIENT_CONFLICTS` while the validation record states it is "deliberately excluded"; the reversal (#67) is recorded in neither Epic document | `src/storage/connection.ts:190-193` vs `docs/EPICs/validation/EPIC-079-VALIDATION.md:68` |
| F-76 | 021 | `Retry-After` in HTTP-date form is read through `Number()` and treated as absent, so AC-11 does not hold for that grammar (negative, `NaN`, `0` and huge values are all handled correctly) | `src/github/client.ts:329-334` |
| F-77 | 007 | `IdentityStore.unlink` returns the unchanged alias when the event predates `validFrom`, so "ended" and "ignored as out of order" are the same return | `src/storage/identities.ts:256` |
| F-78 | 077 | `verifySignature`'s scheme ternary has two identical branches, so a future non-sha256 scheme would be silently treated as sha256; there is also no replay window, and a Jira delivery id is caller-minted | `src/events/signature.ts:69`; `src/events/deliveries.ts:19-53`; `src/events/normalize.ts:151` |
| F-79 | 049/088 | `RelationshipStore.assert` hard-`DELETE`s a row during ordinary ingestion, contradicting "the only place Ferret does it" | `src/storage/relationships.ts:229` vs `src/storage/retention.ts:15-17` |
| F-80 | 011 | `ferret doctor` builds its capability list from a private registry holding two providers, so `parser`, `source.project`, `embedding` and `mcp` never appear — not even as unavailable; the MCP surface answers the same question correctly | `src/cli/health.ts:313-318` vs `src/mcp/provider-tools.ts:251` |
| F-81 | 015 | `credentialsFor` silently drops a declared credential path that is not in a two-entry hard-coded list, so an external provider's declaration is answered with `{}` and no warning | `src/config/credentials.ts:21`, `:64` |
| F-82 | 004 | An optional component whose status is `unknown` is folded to `degraded` in the aggregate, and `isUsable(DEGRADED)` is true — "could not be determined" becomes "working with reduced capability", against the module's own header | `src/diagnostics/health.ts:120-134`, `:13` |
| F-83 | 001/095 | `ferret import <missing-file>` returns `E_UNKNOWN` at exit 1 with a raw `ENOENT` string and no remediation, under a comment promising it "reports precisely"; the correct pattern exists one module away | `src/cli/commands/import.ts:44-46` vs `src/config/file-source.ts:95-113` |
| F-84 | 105 | `isInside()` — documented as keeping file reads in bounds and exported on the public barrel — is wrong on Windows for case differences and for a drive root, and has no caller in `src/` | `src/config/paths.ts:98-105` |
| F-85 | 059 | `trimItem` slices UTF-16 code units, so an astral character landing on the cut leaves a lone surrogate in an emitted value | `src/context/pack.ts:565` |
| F-86 | 056 | Rank tiebreaks use `String.localeCompare` with the host's default locale, so two instances on differently configured hosts order the same tied pool differently — against §8.6's "identically … across processes" | `src/retrieval/rank.ts:215-218` |
| F-87 | 070 | The README tool catalogue lists 15 tools; `src/mcp/` registers 18 (`ferret_answer`, `ferret_why`, `ferret_explain` are missing) — the hand-maintained second copy EPIC-070 §8.5 declined to build | `README.md:198-214` |
| F-88 | 085/069 | The `CONFIRMATION` audit event is written with `outcome: PERMITTED, reason: 'consumed'` *before* `consume()` validates the token, so a refused confirmation would be journalled as a consumed one. Latent only because of F-63 | `src/mcp/guards.ts:188-202`; `src/authorization/confirmation.ts:268-279` |
| F-89 | 083 | `ferret config set`/`unset` writes configuration with no permission assertion and no confirmation, while the MCP twin requires `CONFIG_WRITE` plus a plan-bound token; the AC-11 architecture test enumerates only commands mentioning `RepositoryIndexer` | `src/cli/commands/config.ts:165-190`; `tests/unit/authorization-enforcement.test.ts:132-134` |
| F-90 | 058/083 | The compile-time guarantee against unscoped evidence reads lives on the port; the `EvidenceStore` class exported through `@indoulia/ferret/storage` keeps the omission-means-unrestricted default, and `dependentsOf` has no scope parameter at all | `src/storage/evidence.ts:114-115`, `:327`, `:430`, `:578` |
| F-91 | 101 | Re-running the scale suite on the same platform tag produced p95 figures 4–9× above the committed baseline while every budget sits 19–39× above measurement; 27 of 39 declared indexes have no plan assertion | `docs/Performance/EPIC-101-scale-baseline-win32.json`; `tests/integration/storage/scale.test.ts:44-74` |
| F-92 | 017 | `tests/integration/git/discovery.test.ts` "walks a wide tree within budget" failed both full-suite runs on this machine (30.0 s, then 38.0 s against a 30 s ceiling) and passed in isolation — a contention-sensitive gate, not a regression | this audit's runs |
| F-99 | 018 | An empty repository's worktree records `headCommit: "0000…0"` — the null OID passes the hex test — while the sibling reader for the same repository correctly maps `(initial)` to `undefined`. Two readers, two answers, and a dangling join key | `src/git/refs.ts:122`, `:222` vs `src/git/worktree-state.ts:133-137` |
| F-93 | 072 | The closing-reference scan reads fenced code blocks and inline code as live references, and a body naming both `#7` and `owner/repo#7` in the same repository emits two identical resolve edges | `src/project/references.ts:79` |

## 7. False assumptions discovered

1. **"The tests prove the acceptance criteria."** In at least eleven places the test
   asserts the implementation's own shape rather than the requirement: the AC-5 fixture that
   sets `mergeCommit: undefined` (F-09); the AC-11 fixture that asserts an error message
   rather than a classification (F-13); the AC-3 assertion that inspects `items` while the
   page carries `raw` (F-37); the AC-6a fixture that splits declaration and call across two
   files, the one arrangement where the defect cannot fire (F-25); the AC-4 fixture that
   calls an unimported name, which does not compile (F-26); the embeddings test that creates
   the extension before migrating (F-16); the AC-4 watermark test that only ever passes
   explicit revisions, plus a unit test that pins the collision (F-02); the AC-2 export test
   that compares one transformation against itself (F-44); the AC-14 ZIP test whose fixture
   generator cannot express a lying header (F-60); the planner test that asserts
   `partial === true` for both the healthy default and a real outage (F-67); and the backup
   test that picks a URL with no password in it (F-30).
2. **"A green suite means the guarantee holds."** On this machine the entire packaging
   suite — including the secret scan of the shipped bytes — was skipped in both full runs
   and counted inside a single `41 skipped` figure (F-73).
3. **"Conformance passing means the provider conforms."** An all-skipped report is
   `conformant: true`, and a deliberately broken provider passes by having a strict config
   schema (F-18).
4. **"The comment states the invariant, so the invariant holds."** Six defects sit directly
   under a comment asserting the opposite behaviour: F-09, F-11, F-19, F-23, F-30, F-79.
5. **"Validated means reachable."** Five P0 Epics have no path from any client (F-20), and
   five more deliver library surface no command reaches (F-21).
6. **"Ferret's own repository is a representative test corpus."** It is under the 1 000
   commit cap (F-01), has no CRLF Markdown (F-22), no BOM'd files (F-24), no Jira data
   (F-08) and no cross-source conflicts (F-07) — every one of which hides a defect.

## 8. Areas verified clean

Verified by execution and reported clean by the reviewers who attacked them:

- **Webhook signature verification (EPIC-077).** HMAC over the raw bytes, and the function
  cannot be handed an object; a re-serialised body refuses; absent or empty secret refuses
  as `unconfigured` rather than passing; missing header, wrong prefix, short, long and
  non-hex signatures all refuse without throwing; length fixed by the regex before
  `timingSafeEqual`; one sender-facing sentence for every refusal.
- **Credential isolation (EPIC-081), except F-71 and F-30.** `FerretError` redacts at
  construction, `serializeError` redacts every branch including `cause` and emits no stack,
  the logger redacts by key and by value through nested structures and neutralises pino's
  `err` serializer; the GitHub error path never carries the token.
- **Secret detection (EPIC-082).** All twelve patterns measured linear on adversarial input
  to 160 KB; worst case 3.6 ms; input capped and fail-closed.
- **Authorization at the MCP surface (EPIC-083/068/069).** All fifteen registered tools pass
  through a guard with a named permission checked before the handler; the permission
  predicate is a `WHERE` clause so protected rows are never read; scope grants are
  segment-wise; `%`, `_` and `\` are escaped. Destructive confirmation verified live through
  the real protocol: 256-bit CSPRNG token, digest-bound to the true plan, single-use, spent
  before the operation, and `authorization` unwritable through the AI surface.
- **External input execution.** The single dynamic `import()` is reachable only through a
  loader that refuses any specifier but one literal; `git` is invoked via `execFile` with
  `shell: false`, an argument vector and `--`; no `eval`, no `Function`, no regex built from
  external input; every value in `src/storage/retrieval.ts` is a bind parameter, attribute
  names included.
- **The golden dataset is independent of the implementation (EPIC-096/098).** No generator
  exists; `git log --follow` shows one commit ever for `labels.json`, predating every
  quality number; first measurement scored 0.32 mean precision and 0.00 on one query and the
  labels were not adjusted; the dataset module imports neither metric module and that is
  asserted; the checksum covers the labels and refuses to load on drift. The retrieval gate
  is real and enforced in CI, pinned to four decimal places, and reproduced exactly on this
  machine.
- **The security regression suite asserts properties, not strings.** Subjects are enumerated
  from source rather than a hand list, the enumeration is proved total and floored so it
  cannot go vacuously empty, and planted negatives prove each detector still fires.
- **Migrations and schema skew (EPIC-002/010).** No `DROP`, `TRUNCATE` or `DELETE` in any of
  the twelve migrations; DDL and bookkeeping commit in one transaction; gaps and duplicates
  refused at load; checksum drift refused; an older binary against a newer database refuses
  with `E_SCHEMA_UNSUPPORTED` before any write; startup serialized on a named advisory lock.
- **Transaction boundaries.** Evidence record-and-supersede, relationship assertion and
  per-table import with a per-row savepoint are each one transaction; export takes a
  `repeatable read, read only` snapshot; no multi-statement write outside a transaction was
  found.
- **Exit codes and CLI error semantics.** No failing command was made to exit 0 on any path
  exercised; usage 2, config 3 uniformly; `main()` sets `process.exitCode` rather than
  calling `process.exit`, and a forced-truncation attempt through a slow pipe could not
  reproduce a loss.
- **Packaging content.** `npm pack --dry-run --json` on a built copy yields 505 files: all
  four grammars, all twelve migrations, the golden dataset, and nothing outside `dist`,
  `README.md`, `LICENSE`, `package.json`; every `exports` target exists; two packs were
  byte-identical.
- **Parser robustness.** Twenty-four hostile fixtures — truncated ZIP, no EOCD, PDF-as-docx,
  text-as-PDF, NUL bytes, invalid UTF-8, 1M-column CSV, 200k-deep JSON, combining-character
  bomb, RTL override, `CON`, trailing dot, >260-char path — all returned a structured
  outcome rather than a throw. Zip-slip is inert (`readZip` returns a `Map` and never
  writes). Byte-signature detection overrides a lying extension in both directions. A
  missing grammar raises `DEPENDENCY_UNAVAILABLE` with remediation rather than parsing to
  nothing.
- **Traversal cycle safety, symbol identity, and extraction.** `A→B→C→A` at depth 6
  terminates; a call inside a comment or a string literal produces no reference; ambiguity
  refusal works; a file in a language with no grammar is never queried as if it had symbols.
- **Provider dependency boundaries.** No module outside `src/github/` or `src/jira/` imports
  either; the registry's failure isolation, disabled/failed exclusion, five-state derivation
  and independent shutdown are sound; provider config slices never echo a rejected value and
  credentials are stripped structurally.
- **Evidence and confidence semantics on the producing side.** Per-rule confidence rather
  than a constant; `derivedConfidence` returns `undefined` if any input is unassessed;
  `0` stays distinct from omitted; freshness derives from source time, not ingestion time;
  `unknown` ranks as unassessed rather than as weakest; `evidenceKey` binds producer,
  version, source and locator so two sources cannot be conflated.
- **Cursor advance ordering, idempotency and truncation gates for files and refs.** The
  watermark moves only after every stage commits; repeat runs produced no duplicate rows and
  no aborting constraint violation; `treeComplete`/`branchesComplete` fail closed with a
  stated reason, so absence is never misread as deletion for files.

## 9. Remaining risks

1. **Not covered by execution:** the SQL-injection finding (F-29) was demonstrated at the
   statement-construction layer, not executed against PostgreSQL. The content-skip
   degradation (F-52) was established statically.
2. **Concurrency beyond the cases reproduced.** F-41 was reproduced; other prune/index and
   two-writer races were reasoned about rather than executed.
4. **Performance claims.** Baselines are not reproducible on the same platform tag (F-91)
   and the benchmarks do not exercise Ferret's stores (F-50), so no performance statement in
   the documentation should be treated as measured product behaviour.
5. **This audit read the code and drove it; it did not run Ferret against a large real
   repository, a real GitHub organisation or a real Jira site** — the environment in which
   F-01, F-08 and F-16 would surface first.

## 10. Overall verdict

**AMBER, with one P0.**

The engineering discipline in this codebase is unusually high: the invariants are stated,
the reasoning is written down beside the code, the security controls hold under attack, and
the golden dataset is genuinely independent of the implementation — which is the single
hardest thing to get right in a project that measures itself. Most of what this pass found
is not sloppiness; it is the systematic residue of a specific habit — **acceptance criteria
verified against fixtures shaped by the implementation**, and Epics validated in isolation
without an executed seam between them. Every one of the four largest findings (F-01, F-08,
F-16, F-20) lives exactly at a boundary between two Epics that were each validated alone.

The product's own claim — that it never states what it cannot support — does not currently
hold on its primary surface (F-05, F-06, F-07, F-27, F-31), and its ingestion is not
complete on any repository larger than its own (F-01).

Nothing here was merged, deployed, or pushed to `main`. No Epic status was changed and no
historical evidence was modified.

