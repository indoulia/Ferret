# EPIC-087 — Deduplicated Content Storage

**Status: APPROVED | Priority: P0 | Domain: Storage & Data Lifecycle**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Storage & Data Lifecycle,
> where it has been named and prioritised since the registry was written; only
> the specification is new.

## 1. Objective

Persist file content once per distinct content hash, and make that content
searchable, so a term appearing only *inside* a file reaches that file.

## 2. Value — the problem, measured

EPIC-108 reads every file's bytes, derives structure, parses, indexes symbols,
and **discards the bytes**. `src/indexing/content.ts` records the discard in a
comment: *"no bytes are stored, which §4 reserves for EPIC-087."*

The cost is measured, not asserted. EPIC-098's harness over the golden dataset:

| metric | value |
| --- | --- |
| mean precision@10 | 0.32 |
| mean recall | 0.75 |
| mean nDCG@10 | 0.61 |

and the per-query breakdown names the cause:

```
text-invoice        "invoice"      reached: commit, commit, file, file_version
text-authentication "authenticate" reached: commit
```

`text-authentication` scores **0.00 on every metric**. The label expects
`src/auth/login.ts`; that file's body declares `authenticateUser`, and its path
does not contain the term. Ferret's `search_vector` (migration `0007`) covers
entity `name`, `description`, `path`, `message`, `shortName`, `ref`, `title` and
evidence statements — everything *about* a file and nothing *in* it. Retrieval
has no route from the term to the file. `text-invoice` loses half its recall the
same way: `invoice.ts` matches on path, `tax.ts` does not.

This is the one P0 whose absence the harness can already quantify, and whose
presence the same harness can prove.

## 3. Scope

1. **`ferret.content_blob`** — one row per distinct content hash, regardless of
   how many paths, revisions, worktrees or repositories carry those bytes.
2. **Text extraction, bounded and redacted.** Decodable text under the byte
   bound is stored after `redactSecrets` (EPIC-082). Binary, over-bound and
   undecodable content yields a metadata row with no text and a recorded reason.
3. **A full-text branch over content**, joined to the `file_version` entities
   that carry the hash, permission-filtered exactly as the existing branches are.
4. **Identifier splitting** in the content vector, so `authenticateUser` is
   reachable by `authenticate` — the body analogue of migration `0007`'s
   `translate` on paths.
5. **A write port on the content stage.** EPIC-108's discard point becomes a
   store call; its `ContentCounts` gains blob counts.
6. **Read-back by hash**, so a consumer that needs the bytes again does not have
   to reach the provider.

## 4. Non-scope

- **Binary bytes.** A binary blob gets a metadata row; its bytes are not stored.
  Nothing today reads them back, and storing them buys index size and no answer.
- **Retention, eviction and unreferenced-blob collection** — EPIC-088. A blob
  outlives the last file version that referenced it, deliberately: that is what
  makes it deduplicated storage rather than a cache.
- **Semantic or vector retrieval over content** — EPIC-054. This Epic adds
  lexical reach only.
- **Chunking or passage-level retrieval.** A hit is a file version, not a span.
- **Compression, external object storage, or large-object storage.**
- **Any adjustment to golden labels or thresholds** — EPIC-096 owns the dataset,
  and a label rewritten to suit a result is a label shaped by the answer.
- **Changing EPIC-108's stages, ordering, gate or existing counts.** VALIDATED;
  this Epic adds a write and two counters.
- **Non-UTF-8 transcoding.** Undecodable is a recorded reason, not a conversion.

## 5. Inputs

- `FileContent.bytes` from EPIC-108's content stage.
- `FileStructure` (EPIC-030): `mediaType`, `binary`, `encoding`, `sizeBytes`.
- The content hash EPIC-022/023 already derives, and which `file_version`
  entities already carry as `attributes->>'contentHash'`.
- `AccessContext` (EPIC-058) at query time.

## 6. Outputs

- Migration `0011_content_blobs.sql`.
- `ContentBlobStore` in `src/storage/content.ts`: `store`, `read`, `stats`.
- `ContentBlobWriter` port in `src/indexing/ports.ts`.
- `ContentCounts.blobs { stored, deduplicated, textOmitted }`.
- A `content` hit source on `RetrievalService.search`, with `ts_headline` over
  the body.

## 7. Dependencies

EPIC-108 (VALIDATED — supplies the bytes), EPIC-022/023 (content hash),
EPIC-030 (structure), EPIC-082 (redaction), EPIC-058 (permission-aware
retrieval), EPIC-052/053 (retrieval and FTS), EPIC-002 (migrations),
EPIC-010 (schema version).

## 8. Contracts

### 8.1 The hash is the identity, and the whole identity

`content_hash` is the primary key. Two files with identical bytes are one row;
the same file at two revisions with unchanged bytes is one row. Storing is
idempotent — a second `store` of the same hash writes nothing and reports
`deduplicated`. Nothing outside the store derives the hash; it arrives from the
`file_version` entity that already carries it.

**Path is not stored on the blob.** A blob is reached *through* the file
versions that reference it, never the reverse. Recording a path here would
create a second, unsynchronised answer to "where does this content live", and
would leak a path across the permission boundary §8.3 exists to hold.

### 8.2 Text is redacted before it lands, never on the way out

`redactSecrets` runs before the insert. A credential that reaches the table is
in the index, in every backup, and in every `ts_headline` — redacting at read
time would be a control that one new caller can forget. EPIC-082 fails closed
above 1 MB of scanned text, and this Epic inherits that: unscannable text is not
stored.

### 8.3 A blob is never returned without an entity the caller may see

Deduplication means one blob may be referenced by file versions in repositories
with different scopes. The search branch therefore joins
`content_blob → entity (kind = 'file_version', attributes->>'contentHash')` and
applies `scopePredicate(access)` to that entity. The hit is the entity; the blob
supplies only rank and highlight.

This is EPIC-058 AC-2 restated for a new branch, and it is the exact shape of
defect #87 — a branch that selected a scope column and never consulted it. A
content branch that ranked on a blob without the join would be strictly worse:
it would return content from repositories the caller cannot list.

### 8.4 Identifier splitting, and why in the generated column

`to_tsvector('english', 'authenticateUser')` yields one lexeme,
`authenticateus`. The query `authenticate` stems to `authent` and matches
nothing — so storing bodies *without* splitting would leave `text-authentication`
at 0.00 and the Epic would have delivered a table and no answer.

The vector therefore indexes the text twice: verbatim, and with camel and
Pascal boundaries broken:

```sql
regexp_replace(text_content, '([a-z0-9])([A-Z])', '\1 \2', 'g')
```

In the generated column rather than at write time, for migration `0007`'s
reason: a stored `tsvector` is what `ts_rank` needs, and the expression is
`IMMUTABLE` (`regexp_replace/4` and a literal-config `to_tsvector` both are).
Splitting at write time instead would store a mangled body and hand
`ts_headline` text that does not appear in the file.

Snake case needs no rule — PostgreSQL's parser already splits on `_`.

### 8.5 The byte bound is a ceiling on what is stored, not on what is read

EPIC-108 bounds what it materialises via `FileContentRequest.maxBytes`. This
Epic adds a second, smaller bound on what is *persisted as text*. They are
different questions: parsing a 4 MB file is useful, and putting 4 MB of it in a
GIN index is a cost with no matching answer. Over the bound, the row is written
with `text_content = NULL` and `omitted_reason = 'over-size-bound'` — present,
countable, and honestly empty rather than absent and indistinguishable from
never-seen.

### 8.6 `omitted_reason` distinguishes the empties

`NULL` text is never bare. `binary`, `over-size-bound`, `undecodable`,
`secret-scan-failed` are separate facts; an operator asking why a file is not
searchable deserves the real one, and Governance §6 requires "no result" and
"nothing there" to look different.

## 9. Acceptance criteria

- **AC-1** Indexing a repository with content enabled writes one `content_blob`
  row per distinct content hash.
- **AC-2** Two files with byte-identical content produce exactly one row, and
  the run reports one `stored` and one `deduplicated`.
- **AC-3** Re-indexing unchanged content writes no new row and reports
  `stored = 0`.
- **AC-4** A text file's body is retrievable by `read(contentHash)` and equals
  the source bytes decoded, after redaction.
- **AC-5** A file containing a credential is stored with the credential replaced;
  the cleartext appears in no column.
- **AC-6** Text above the persistence bound is stored as a row with
  `text_content IS NULL` and `omitted_reason = 'over-size-bound'`.
- **AC-7** A binary file is stored as a row with `omitted_reason = 'binary'` and
  no text.
- **AC-8** `search` returns a `content` hit for a term appearing only in a file
  body, resolving to the `file_version` entity that carries the hash.
- **AC-9** A content hit for a file version outside the caller's scope is not
  returned, and its body appears in no highlight.
- **AC-10** Searching `authenticate` reaches a body declaring `authenticateUser`.
- **AC-11** The golden-dataset harness run after this Epic reports
  `text-authentication` recall > 0 and mean precision@10 strictly greater than
  the recorded 0.32 baseline, with labels unchanged.
- **AC-12** `falsePositives` on absence labels remains 0 — content indexing adds
  reach, and must not make `kubernetes` match a corpus that does not mention it.
- **AC-13** A store failure for one file fails that file only; the run continues
  and reports it, matching EPIC-108's failure isolation.
- **AC-14** The migration is reversible in the sense EPIC-002 requires, and
  `schemaVersion` advances per EPIC-010.

## 10. Test requirements

**Unit** — hash-keyed idempotence; redaction before insert; each
`omitted_reason` branch; the camel-split expression's effect on lexemes;
counts arithmetic.

**Integration (real PostgreSQL)** — AC-1 through AC-9 and AC-14 against a live
schema; the generated column proven `IMMUTABLE` by the migration applying at
all; dedup proven by row count across two paths with one content.

**Retrieval quality** — AC-11 and AC-12 through EPIC-098's harness, run before
and after, both figures recorded.

**Security** — AC-5, AC-9; a body containing prompt-injection text stays inside
EPIC-084's content fences when surfaced.

**Failure** — AC-13; a blob write rejected by the database; text that
`redactSecrets` refuses to scan.

## 11. Security requirements

Storing bodies moves Ferret's blast radius: until now a compromised index leaked
metadata and commit messages, and after this it leaks source. Three controls
carry that, and all three are existing, validated mechanisms rather than new
ones: EPIC-082 redaction before write (§8.2), EPIC-058 scope filtering on the
reached entity (§8.3), and EPIC-084 content fencing when a body reaches an AI
client. `isSecretPath` exclusions apply upstream in EPIC-022 and are not
re-implemented here.

## 12. Observability

`ContentCounts.blobs` on the run summary: `stored`, `deduplicated`,
`textOmitted` keyed by reason. `stats()` reports row count, distinct hashes and
total stored text bytes for `ferret status`. A redaction that fires is logged at
`warn` with kind and count, never the value.

## 13. Performance constraints

- Persisted-text bound: 1 MB per file, below EPIC-082's 1 MB scan ceiling so the
  fail-closed path is unreachable by an ordinary source file.
- A second index run over unchanged content performs zero blob inserts (AC-3),
  so dedup cost is a hash lookup per file.
- The content search branch must not regress `search` latency for queries that
  match no body; it is a `UNION` arm gated by the GIN index.

## 14. Definition of Done

Acceptance criteria classified with evidence in
`validation/EPIC-087-VALIDATION.md`; harness figures recorded before and after;
`npm run verify` green; registry updated.

## 15. Governance alignment

§4 (core reaches storage only through ports), §5 (a new table is a governed
decision — taken here explicitly, unlike EPIC-108 which declined one), §6
(absence is distinguishable from emptiness), §8 (files first-class), §18
(answers traceable), §19 (golden datasets measure retrieval).

## 16. Raised, not absorbed

- **Unreferenced blobs accumulate.** Deliberate (§4); EPIC-088 owns collection.
  **Closed 2026-09-02:** `ferret prune --blobs --yes` reclaims a blob no
  `file_version` carries the hash of. §4's reading holds unchanged — a blob
  still outlives the last reference, and this is reclamation after the fact
  rather than eviction while a reference exists. A blob a *tombstoned* version
  names is referenced and stays, because "what did it contain" is a question
  Ferret indexes history to answer (EPIC-006 §D-009). See
  [EPIC-088](EPIC-088-Retention-And-Exclusion-Policies.md).
  Recorded so the growth is a known cost rather than a later surprise.
- **`text-invoice` may not reach 1.00.** `tax.ts` mentions invoices in prose;
  whether it ranks inside k is a ranking question EPIC-056 owns. AC-11 asks for
  improvement over a measured baseline, not a chosen number.
- **One vector for prose and code.** A single `english` configuration over both
  is a known compromise inherited from migration `0007`; a code-specific text
  search configuration is a larger change than this Epic should make.

## 17. Recorded during implementation

- **AC-11 was not met and was not rewritten.** Measured p@10 is 0.2639 against a
  0.32 baseline; recall, RR and nDCG all rose. The loss occurs when content
  indexing is turned on *at all* — before a body is stored — and storing bodies
  moves every metric up from there. The criterion compares against a baseline
  taken under a different index configuration, which is a flaw in the criterion
  rather than a result. Left failing and raised; see
  [validation](validation/EPIC-087-VALIDATION.md).
- **The hit resolves to the `file`, not the `file_version`.** §8.3 as approved
  said the branch joins to the version that carries the hash. It does, and then
  joins again to the file: measured, resolving to the version left
  `text-authentication` at recall 0.00 with content indexed and searchable,
  because the labels expect the entity a developer names. The second join is
  also what makes the permission filter correct — a version's `source_scope` is
  its file, a file's is its repository, and only the latter is what
  `includedRepositories` compares against.
- **`ContentCounts.blobs` gained a `failed` counter** beyond the three §6 named,
  so AC-13's isolation is observable rather than merely true.
