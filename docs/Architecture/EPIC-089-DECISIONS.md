# EPIC-089 / EPIC-090 — Architecture Decisions

Decisions required on the backup and export contract, and the engineering
evidence that makes them concrete. Recorded per Governance §22 so a later reader
can tell a considered choice from an accident.

**D1 and D2 were decided by the product owner on 2026-09-04 and are
implemented.** The decisions, the contract each now carries, and what remains
outside it are in **§Decided** below. The brief and the evidence beneath it are
left as they were written — they are the record of what the decision was taken
on, and rewriting them would destroy that.

Everything under "Measured" is settled fact from a round trip through the real
CLI against PostgreSQL 17 + pgvector on 2026-09-04, taken **before** the
implementation. It is the description of the defect, not of current behaviour.

---

# Decided — the contract as implemented

> Recorded 2026-09-04, after the owner's decision. Supersedes the "OPEN" status
> in the brief and the D1/D2 sections below, which are kept as written.

## D1 (F-44) — export fidelity

**Decision.** A normal export preserves faithful data and never silently emits a
value that export-time redaction has modified. A strict path refuses loudly when
the fidelity contract cannot be satisfied. Insert-time redaction is untouched.

**Current contract.**

| | |
| --- | --- |
| `ferret export` | Carries every value **as stored**. `content_hash` therefore continues to describe the row it labels. The credential scanner still runs over every string value — EPIC-089 §11 requires it — and when it fires the row is exported unchanged and the finding is recorded in the trailer's `credentialShaped` and printed by the CLI. The document is never silently modified, and never silently *un*modified either. |
| `ferret export --strict` | Refuses with `E_EXPORT_REFUSED`, naming the table, the column and the row. Writes no trailer, and the CLI removes the partial file, so there is nothing on disk rather than a document `ferret import` would refuse. |
| Insert-time redaction | Unchanged. EPIC-087 §8.2 remains the primary control: redacted before it lands, never on the way out. |

**Rationale.** Four records already required this direction and one appeared to
require the opposite; the apparent conflict dissolves once "the redactor
applies" is separated from "the redactor rewrites". Governance §6 forbids
silently rewriting source evidence. EPIC-087 §8.2 puts redaction before the
insert. EPIC-089 §8.5 exports content as content. EPIC-090 §8.7 needs an
unfiltered document so that an external filter is auditable. EPIC-089 §8.4/§11
require a redactor at export — and it is still there, as a **detector and a
gate**. Nothing was weakened: the scanner runs on exactly the values it ran on
before, and now reports instead of corrupting.

This is option **A** from the brief, with **C** available as `--strict`. Option
**D** — universal insert-time redaction — remains the standing improvement and
is not blocked by this.

**Implementation.**

| Change | Where |
| --- | --- |
| `findCredentials` / `scanValue` replace `redactRow` / `redactValues`: detect, never rewrite | `src/storage/export.ts` |
| `CredentialFinding`, `ExportTrailer.credentialShaped`, `ExportResult.credentialShaped` | `src/storage/export.ts` |
| `ExportOptions.strict` and `strictRefusal` | `src/storage/export.ts` |
| `E_EXPORT_REFUSED`, mapped to the generic error exit | `src/errors/codes.ts`, `src/cli/exit-codes.ts` |
| `--strict`, the disclosure block, partial-file removal on failure | `src/cli/commands/export.ts` |
| Regression coverage — 9 tests | `tests/integration/storage/export-fidelity.test.ts` |

**Limitations, stated.**

- **A faithful export of an index holding a credential contains that
  credential.** That is the trade the decision makes, and it is why the trailer
  records it, the CLI prints it and `--strict` exists. The document was already
  "everything Ferret knows, in cleartext, in one file" (§4).
- **A finding does not prove a credential.** The scanner matches shapes; an
  `AKIA`-shaped filename is a false positive, which is precisely why refusal is
  not the default — it would block the recovery path on a filename.
- **The strict refusal is mid-stream.** It cannot know about row 40 000 before
  row 1 is written, because §8.6 forbids a second pass. The partial file is
  removed and no trailer is written, so nothing downstream can mistake it for a
  document.
- **`redactSecrets` remains the oracle**, so the export reports exactly what
  every other surface would redact — and only values a producer failed to
  redact at insert reach a finding at all, because it is idempotent.

## D2 (F-45) — vectors and instance identity

**Decision.** Vectors are **not** backup payload, and the export, manifest and
restore path say so explicitly and name the regeneration path. A restored
installation receives a **new** identity; the source identity is preserved as
explicit provenance. Two independently existing installations never share an
identity.

**Current contract.**

| | |
| --- | --- |
| Vectors | Not carried. `ExportManifest.excluded` declares `embedding` with a reason and a recovery in the document's **first line**, `ferret export` prints it, and `ferret import` repeats it on the restore. Never fabricated, never zero-filled. |
| Regeneration | Re-index with an embedding provider configured. Stated plainly in the manifest: **Ferret ships no embedding provider**, so until one is wired there is nothing to regenerate and semantic retrieval reports itself unavailable. No command is implied that does not exist. |
| Instance identity | The target keeps the identity its own `ferret init` minted. `ferret.instance` is in `EXPORT_EXCLUSIONS`, so no document can carry an identity into a target. |
| Provenance | `ExportManifest.sourceInstanceId` carries the source identity; an applied import records it in `ferret.instance_restore` (migration 0014) with the document digest, the source version, the export instant and the row count. `ferret import` prints both identities, always. Surfaced on the schema report as `restoredFrom`. |
| Completeness | Every table in the live schema must be in `EXPORT_TABLES` or `EXPORT_EXCLUSIONS`, asserted against `information_schema` — the control that stops the next `embedding` being dropped by nobody noticing. |

**Rationale.** This is option **B** for both halves — the only option that
invents no new backup semantic. EPIC-089 §3's scope is a closed list omitting
both tables and §8.1 assigns full fidelity to `pg_dump`, so excluding them is
already within contract; the defect was the silence, and declaring the behaviour
is what the existing requirements support. Identity is **B** rather than **A**
because a restore creates a second installation, and two installations
answering to one identity is a correctness problem that outranks a restored
index naming itself — which provenance solves without the collision.
Append-only rather than columns on `ferret.instance`, because Governance §6
makes provenance append-only and a second restore must not erase the first.

**Implementation.**

| Change | Where |
| --- | --- |
| `ExcludedTable`, `EXPORT_EXCLUSIONS` (all five non-exported tables, each with a reason and a recovery) | `src/storage/export.ts` |
| `ExportManifest.excluded`, `ExportManifest.sourceInstanceId`, `#instanceId` | `src/storage/export.ts` |
| `ferret.instance_restore` — append-only provenance | `src/storage/migrations/0014_instance_restore.sql` |
| `ImportProvenance`, `ImportReport.excluded`, `#recordProvenance` | `src/storage/import.ts` |
| `readLatestRestore`, `SchemaReport.restoredFrom` | `src/storage/bookkeeping.ts`, `src/storage/migrator.ts` |
| Exclusion and identity reporting on the restore | `src/cli/commands/import.ts` |
| Regression coverage — 10 tests | `tests/integration/storage/backup-contract.test.ts` |

**Limitations, stated.**

- **A restored index has no vectors and cannot regain them today**, because no
  embedding provider exists. The manifest says this rather than implying a
  command. When a provider lands, option **C** — exporting the vectors' inputs
  so a restore knows what to re-embed and with which model — becomes worth
  taking, and this is the note that says so.
- **Provenance needs schema 14.** Importing into a database at 13 or earlier
  succeeds and reports that provenance could not be recorded, naming
  `ferret upgrade`. The restore is not failed for it: the rows are already
  committed, and rolling back a successful restore over a bookkeeping row would
  be the worse outcome.
- **A pre-D2 document cannot declare anything.** `ferret import` reports it as
  *not saying* what it omits, never as omitting nothing — vectors were absent
  from that format too, and the two are different claims.
- **Identity is not de-duplicated across installations by anything but minting.**
  If an operator clones a database with `pg_dump` and then imports, both copies
  carry the same id, because `pg_dump` copied it. That is `pg_dump`'s semantic,
  not the export's, and §8.1 is where it belongs.

---

# Decision-ready brief

> Written before the decision, kept as the record of what it was taken on. The
> "OPEN" markers below are historical; §Decided above is current.

One page. The evidence for every claim here is below; the tables in the body are
the long form of the same two decisions. **Nothing is implemented pending these
answers.**

## D1 (F-44) — must an export preserve unrewritten content?

| | |
| --- | --- |
| **Current behaviour** | `export.ts:492` runs `redactSecrets` over every string value on the way out. `content_hash` is exported as it stood. `entity.content_hash` is derived from `attributes` (`entity.ts:260`), so where redaction fires, the hash stops describing the row. `redactSecrets` is idempotent, so it fires **only** on values whose producer omitted insert-time redaction — a file path is one such field. |
| **Exact integrity / recovery problem** | Three, measured on a two-file fixture. **(1)** A restored index reports itself damaged: `ferret verify` returns **5 findings, exit 1** (1 identity-mismatch, 2 content-hash-mismatch, 2 evidence-tampered), each naming a false cause and remediating with "re-read from source" — unavailable in the only case a restore exists for. **(2)** Re-import into a live index reports `9 unchanged, 0 written` and scrubs nothing, so **EPIC-090 §8.7's named scrubbing mechanism does not work as written**. **(3)** `entity` and `evidence` disagree about the same edit (`unchanged` vs `conflicting`), because only evidence compares a second hash. |
| **Applicable existing language** | **Four say export must not rewrite:** Governance §6 — "Source evidence… must not be silently rewritten" (the governing rule). EPIC-087 §8.2 — titled "redacted before it lands, **never on the way out**". EPIC-089 §8.5 — "Content is exported as content". EPIC-090 §8.7 — the scrub is an *external filter* between export and import, so "the document before" must be faithful; Ferret ships no filter deliberately. **One is against:** EPIC-089 §8.4 keeps a redactor at export as "the second line of defence" — while stating the *first* line is that a secret is stored as a reference, i.e. a backstop, not a transformation. EPIC-089 §4 records the document is "everything Ferret knows, in cleartext, in one file". |
| **Determined vs open** | **Direction: determined** — an export must not silently rewrite. **Remedy: open** — three of four options move the security posture of the artefact §4 already flagged as a data-exposure decision. |

| Option | Consequence |
| --- | --- |
| **A** — remove export-time content redaction (keep `backupCommandFor`'s URL redaction, which is about printed output) | Restores §8.5 and §8.7 exactly; closes F-44 with no new semantics. **Removes a credential backstop** from a cleartext document, resting on "every producer redacts at insert" — a claim Batch 2 declined to make and the file-path result disproves for at least one field. |
| **B** — keep redaction, recompute `content_hash` over what is written, mark the row `redacted` | Keeps backstop *and* fidelity; `ferret verify` stops lying. But document hashes then differ from source, so a round trip is no longer idempotent — contradicting **EPIC-090 §3**. That contradiction must be resolved, not absorbed. |
| **C** — keep redaction, refuse the export when it fires, naming the row | Loudest, fails closed. Blocks the recovery path on a false positive (a path that merely looks like a key). Unacceptable alone; viable as `--strict`. |
| **D** — make insert-time redaction universal (EPIC-087 §8.2's actual contract), then take A | Correct end state. Spans every producer writing `attributes`/`metadata`/`statement`, needs a control to keep new ones honest. Weeks; F-44 stays open throughout. |

**Recommendation (evidence supports it directionally):** **A now, D as standing
work, C behind a flag.** Four of five records require A's direction, and the
backstop it removes is measurably not doing its attributed job — it rewrote a
file path and left a credential-shaped filename described by a hash of the
original. **The trade — a security control for a fidelity guarantee — is the
owner's, and A must not be taken without explicitly accepting that the export
document has no redaction pass of its own.**

## D2 (F-45) — are vectors backup data, and must instance identity survive?

| | |
| --- | --- |
| **Current behaviour** | 9 of the schema's 13 tables are exported. `embedding` and `instance` are omitted from `EXPORT_TABLES`, from the manifest, and therefore from the import — total on both sides, with **nothing in any output saying so**. |
| **What is exported** | `entity`, `entity_external_id`, `relationship`, `evidence`, `evidence_derivation`, `content_blob`, `derived_artifact`, `identity_alias`, `index_run`. (`schema_migrations` and `schema_migration_failures` are correctly omitted — the target keeps its own ledger. Not part of F-45.) |
| **What restore preserves** | Everything in those nine, subject to D1. **Vectors: none — 100% loss, unconditional.** Denominator today is **0 rows**, because no `EmbeddingProvider` implementation exists anywhere in `src/`; the loss becomes total the day one is wired. **Instance identity: not preserved** — the restore keeps the id `ferret init` minted for the target (measured: source `8a54b6bc…`, target `5ff9dce3…` before and after). |
| **Are vectors *required* to be backup data?** | **No existing requirement makes them so, and none excludes them either.** EPIC-089 §3's scope is a closed list — "entities, relationships, evidence, derivation edges and content blobs" — omitting them; §8.1 assigns full fidelity to `pg_dump`. But §4's non-scope names six exclusions and not these, and §1 promises "everything Ferret knows". The tension is inside one specification. |
| **Must instance identity survive restore?** | **No contract text exists on either side.** EPIC-090 §3 contemplates import into "a different database, or a fresh one"; minting for a fresh installation is defensible, and so is preserving. |

| Vectors | Consequence |
| --- | --- |
| **A** — add `embedding` to `EXPORT_TABLES` | Restores vectors. Requires pgvector on the target and a `vector` wire literal; a target without it must refuse or skip *loudly*. ~4 bytes per dimension per row — ~6 KB/row at 1 536 dims, so a million-row index adds ~6 GB to a file §4 already worries about. |
| **B** — leave out and **declare**: name it in §4 non-scope, list it in the manifest as a known omission, and have `export`/`import` say "vectors not included; re-embed after restore" | Cheapest; matches §8.1's division. Turns a silent loss into a stated property. **Invents no semantics** — it documents what already happens. |
| **C** — export the vectors' *inputs* (`subject_id`, `model_id`, `model_version`, `dimensions`, `metric`, `source_content_hash`) without the `vector` column | A restore knows exactly what to re-embed and with which model, at near-zero cost, and can report semantic retrieval *stale* rather than absent. Needs a re-embed path, which does not exist because no provider does. |

| Identity | Consequence |
| --- | --- |
| **A** — carry and restore `instance` | A restored index *is* the original installation. Two databases restored from one document share an identity — a correctness problem if anything ever keys on it. |
| **B** — keep minting, record the source's `instance_id` as provenance on the run record | Distinguishes "a restore of X" from "X" without collision. Needs somewhere to put it. |
| **C** — mint silently (today), document it | Zero code. `ferret status` still cannot say the index is a restore of anything. |

**Recommendation (supported by existing requirements):** **vectors B now, C when
an embedding provider lands; identity B.** This is the one recommendation that
requires *no* new product semantics — it declares the behaviour the written
contract already permits, and §8.1's division of labour (`pg_dump` is the
full-fidelity path) is the existing requirement that supports it. **Vectors A
is the only option that changes what a backup *means*, and only the owner can
decide that** — the question is whether the export document is a **recovery**
artefact (then A) or a **portability** artefact (then B or C).

---

## Measured — what is exported, what is dropped, what is rewritten

One fixture: a two-file repository, one commit, indexed by `ferret index`, then
`ferret export`, then `ferret import` into a fresh database and again into the
original. The file is named `AKIAAAAAAAAAAAAAAAAA.txt`, because a path matching
the AWS access-key shape is the cheapest reachable way to make the exporter
rewrite a value — **file paths are not redacted at insert**, and the export-time
redactor does not know a path from a credential.

### The tables

`ferret` holds **thirteen** tables. The document carries **nine**.

| Table | Exported | Note |
| --- | --- | --- |
| `entity`, `entity_external_id`, `relationship`, `evidence`, `evidence_derivation`, `content_blob`, `derived_artifact`, `identity_alias`, `index_run` | yes | `EXPORT_TABLES`, `src/storage/export.ts:45-55` |
| `embedding` | **no** | F-45 |
| `instance` | **no** | F-45 |
| `schema_migrations`, `schema_migration_failures` | no | Correctly omitted: the target keeps its own migration ledger, and importing another installation's would be a lie about what has run here. Not part of F-45. |

`ferret import` writes only tables the manifest names, so the omission is total
on both sides — there is no path by which a restore recovers either table.

### The vector loss, quantified

**100% of `ferret.embedding`, unconditionally.** Not a partial or lossy
transfer: the table is absent from `EXPORT_TABLES`, absent from the manifest's
`tables` list, and therefore absent from the import.

**The denominator today is zero rows.** `SELECT count(*) FROM ferret.embedding`
returned `0` on the fixture, and that is not an artefact of the fixture: there is
**no `EmbeddingProvider` implementation anywhere in `src/`**. The contract at
`src/providers/contracts/embedding.ts` has no implementor, and `EmbeddingStore`
has no caller that supplies vectors. So the loss is unreachable-with-data in the
shipped product and becomes total the day a provider is wired — which is the
worst moment to discover it, because the first restore after that day is the one
that loses work nothing else can re-derive cheaply.

Cost to regenerate after a restore: a full re-embed, which needs both a provider
and the original content. The content in the document has been through export
redaction (below), so a post-restore re-embed would embed **redacted** text
under `source_content_hash` values that describe the unredacted original. The
two findings compound.

### The instance identity

Not preserved, and not reported.

```
A (source)          8a54b6bc-06f9-4e80-8a28-b6147522633a
B (target, init)    5ff9dce3-d250-4422-ba53-651f2ba438d3
B after restore     5ff9dce3-d250-4422-ba53-651f2ba438d3
```

The restored index keeps the identity `ferret init` minted for it. Nothing in
the document carries the source's, and nothing in `ferret import`'s report says
so. `ferret.instance` is read by `src/storage/bookkeeping.ts:175` and surfaced
by `ferret init` and `ferret status`.

### The redaction, and what it costs

```
stored in A     AKIAAAAAAAAAAAAAAAAA.txt          5437d69f…c20a
in the document [redacted: aws-access-key-id].txt 5437d69f…c20a   ← same hash
restored in B   [redacted: aws-access-key-id].txt 5437d69f…c20a
```

`export.ts:492` redacts every string value; `content_hash` is exported as it
stood. `entity.content_hash` is derived from `attributes`
(`src/domain/entity.ts:260`), so the hash no longer describes the row it labels.

**`redactSecrets` is idempotent** — measured on four credential shapes — so the
export-time pass changes a value *only* where the producer omitted insert-time
redaction. Where it changes nothing it costs nothing; where it changes anything,
it has quietly rewritten source evidence.

**`ferret verify` on the restored index: five findings, exit 1.**

| Kind | Count |
| --- | --- |
| `identity-mismatch` | 1 |
| `content-hash-mismatch` | 2 |
| `evidence-tampered` | 2 |

One rewritten string became four misreported rows — the path is carried into the
`file` entity's canonical key, into the `file_version` child's key, and into the
two evidence rows that observed them. And **every finding names a cause that is
false**: "either it was altered outside Ferret, or it was written before the
content hash treated timestamps canonically." Neither happened. Ferret's own
exporter did it. The remediation offered is "re-read that repository from
source", which is precisely what is unavailable in the only situation a restore
exists for — EPIC-089 §2, "a repository that was deleted upstream is what Ferret
was indexing history for".

**Re-import into the original index scrubs nothing.**

```
entity            written 0   unchanged 9   conflicting 0
relationship      written 0   unchanged 11  conflicting 0
evidence          written 0   unchanged 7   conflicting 2
derived_artifact  written 0   unchanged 1   conflicting 0
index_run         written 0   unchanged 1   conflicting 0
```

`sameContent` (`src/storage/import.ts:409-414`) compares `content_hash` alone
when the table has one, so all nine entities matched and the redaction was
discarded. A's row is still `AKIAAAAAAAAAAAAAAAAA.txt` after the import reported
`applied: true`, `ok: true`.

Two consequences worth separating:

1. **EPIC-090 §8.7 does not hold as written.** It names
   `ferret export | <filter> | ferret import` as *the* retroactive scrubbing
   mechanism. Into a non-empty index it reports success and changes nothing.
2. **The tables disagree.** `entity` says `unchanged`; `evidence` says
   `conflicting` for the same rewrite, because evidence carries a separate
   integrity hash that *is* compared. One document produces two different
   verdicts about the same edit.

---

## D1 — Are exported backups expected to preserve usable, unrewritten content? **OPEN**

**Context.** Four records in this repository already say export must not
silently rewrite content, and one says the redactor belongs there:

- **Governance §6** (`docs/Governance/README.md:45`) — "Source evidence must
  retain provenance and **must not be silently rewritten**." This is the
  governing rule, and the measured behaviour is squarely inside it.
- **EPIC-087 §8.2** — titled "Text is redacted before it lands, **never on the
  way out**", with the reason: "redacting at read time would be a control that
  one new caller can forget."
- **EPIC-089 §8.5** — "Content is exported as content… a document with the
  bodies silently missing would import into an index that looks complete and
  answers nothing."
- **EPIC-090 §8.7** — the scrub is an *external filter* between export and
  import, so that "the document before, the document after, and the filter that
  ran" are each auditable. Ferret deliberately ships no filter. A redacting
  exporter destroys that arrangement: there is no "document before".
- **Against:** **EPIC-089 §8.4** keeps a redactor at export as "the second line
  of defence", while stating that the *first* line is that a secret is stored as
  a reference — i.e. a backstop, not a transformation. And **EPIC-089 §4**
  records that the document is "everything Ferret knows, in cleartext, in one
  file", which is why scheduling an export was declined. That exposure is real.

The direction is therefore **determined**: an export must not silently rewrite.
The remedy is **not**, because three of the four options move the security
posture of the one artefact §4 already flagged as a data-exposure decision.

**Options.**

| | Option | Consequence |
| --- | --- | --- |
| **A** | Remove export-time content redaction. Redact `content_hash`-bearing values never; keep `backupCommandFor`'s URL redaction, which is about *printed* output. | Restores §8.5 and §8.7 exactly. Closes F-44 with no new semantics. **Removes a credential backstop** from the cleartext document, and rests on the claim that every producer redacts at insert — a claim Batch 2 explicitly declined to make, and which the file-path result disproves for at least one field. |
| **B** | Keep redaction, but make it honest: recompute `content_hash` over what is written, and carry a `redacted` marker on the row. | Keeps the backstop *and* fidelity semantics. `ferret verify` stops lying. But the document's hashes then differ from the source's, so re-import into a non-empty index correctly reports `conflicting` rather than `unchanged` — meaning a round trip is no longer idempotent, which contradicts **EPIC-090 §3** ("importing the same document twice changes nothing the second time"). That contradiction has to be resolved, not absorbed. |
| **C** | Keep redaction, and **refuse the export** when it fires, naming the row. | Fails closed and is loudest. But it makes an export unrunnable on any index containing one unredacted-at-insert value — including a file path that merely looks like a key — so the recovery path is blocked by a false positive. Unacceptable as the only behaviour; viable as a `--strict` mode. |
| **D** | Make insert-time redaction universal (EPIC-087 §8.2's actual contract), then take A. | The correct end state. Spans every producer that writes `attributes`, `metadata` or `statement`, and needs a way to keep new producers honest. Weeks, not hours, and F-44 stays open throughout. |

**Recommended for the decision, not decided here:** **A now, D as the standing
work**, with C available behind a flag. A is what four of the five records
require, and the backstop it removes is measurably not doing the job attributed
to it — it rewrote a file path and left a credential-shaped filename described by
a hash of the original. But A trades a security control for a fidelity
guarantee, and that trade is the owner's.

**What is needed from the owner:** which of A/B/C/D, and if A or D, an explicit
acceptance that the export document has no redaction pass of its own.

---

## D2 — Are vectors part of backup fidelity, and should restore preserve instance identity? **OPEN**

**Context.** EPIC-089 §3's scope is a closed list — "entities, relationships,
evidence, derivation edges and content blobs" — and it omits both tables. §8.1
says a real backup is `pg_dump` and Ferret does not wrap it. On that reading the
omission is *within* contract.

But the same document's §1 promises "get **everything Ferret knows** out of the
database", §4's non-scope list names six exclusions and neither of these, and
nothing at runtime tells the operator. The tension is inside one specification,
which is why this is a decision and not a defect report.

Instance identity has no contract text at all. EPIC-090 §3 contemplates import
into "a different database, or a fresh one", and minting a new identity for a
fresh installation is defensible — but so is preserving it, and nothing says
which.

**Options — vectors.**

| | Option | Consequence |
| --- | --- | --- |
| **A** | Add `embedding` to `EXPORT_TABLES`. | Restores vectors. Requires pgvector on the target and a `vector` literal in the wire format; a target without pgvector must refuse or skip the table *loudly*. Document size grows by roughly 4 bytes per dimension per row — ~6 KB per row at 1 536 dimensions, so a million-row index adds ~6 GB to a file §4 already worries about where it lives. |
| **B** | Leave it out, and **say so**: name `embedding` in §4 non-scope, list it in the manifest as a known omission, and have `ferret export` and `ferret import` report "vectors are not included; re-embed after restore". | Cheapest, and matches §8.1's division. The loss becomes a stated property instead of a silent one. Leaves a restored index semantically searchable and not vector-searchable until a re-embed — which needs the content, which is F-44's problem. |
| **C** | Export the vectors' *inputs* rather than the vectors: `subject_id`, `model_id`, `model_version`, `dimensions`, `metric`, `source_content_hash`, without the `vector` column. | A restore knows exactly what to re-embed and with which model, at near-zero document cost, and can report semantic retrieval as *stale* rather than absent. Needs a re-embed path, which does not exist because no provider does. |

**Options — instance identity.**

| | Option | Consequence |
| --- | --- | --- |
| **A** | Preserve: carry `instance` and restore it. | A restored index *is* the original installation, which is what "recovery" means. Two live databases restored from one document then share an identity, which is a correctness problem if anything ever keys on it. |
| **B** | Mint, and record the lineage: keep minting on `init`, and have the import write the source's `instance_id` as provenance on the run record. | Distinguishes "a restore of X" from "X" without collision. Needs a place to put it. |
| **C** | Mint silently (today's behaviour), and document it. | Zero code. Leaves `ferret status` unable to say the index is a restore of anything. |

**Recommended for the decision, not decided here:** vectors **B** now and **C**
when an embedding provider lands; identity **B**. Both are stated-omission
answers rather than fidelity answers, and both are consistent with §8.1's
division of labour — `pg_dump` is the full-fidelity path, and this document's job
is to be honest about being narrower.

**What is needed from the owner:** whether the export document is meant to be a
*recovery* artefact (then vectors A) or a *portability* artefact (then B or C),
and whether a restored index should claim the source's identity.

---

## The minimum viable supported backup contract

Stated so the decision above has something to be measured against. This is what
the product would have to guarantee for "backup and restore" to be a defensible
claim, and every clause is currently either met, or unmet in a way the two
decisions resolve:

1. **`pg_dump` is the full-fidelity backup, and Ferret says so.** Met —
   EPIC-089 §8.1, `backupCommandFor`.
2. **`ferret export` is a portability document, not a full-fidelity backup, and
   its own output says which tables it does not carry.** Unmet: the manifest
   lists what it carries and is silent on the rest. D2.
3. **What the document carries, it carries unchanged — or it says, per row, that
   it did not.** Unmet: F-44. D1.
4. **A restore's `content_hash` describes the row it labels**, so `ferret verify`
   on a restored index reports the index's real condition. Unmet: five false
   findings on a two-file fixture. D1.
5. **A round trip is idempotent**, and where it is not, `ferret import` says
   `conflicting` rather than `unchanged`. Partly unmet: `entity` reports
   `unchanged` for a changed row; `evidence` reports `conflicting`. D1 option B
   makes this consistent at the cost of §3's idempotence claim.
6. **Anything not carried is recoverable by a named procedure, or is declared
   lost.** Unmet for vectors: no re-embed path and no declaration. D2.
7. **A restored index can say it is a restore.** Unmet. D2.

Clauses 1 is met. Clauses 2-7 are the two decisions.
