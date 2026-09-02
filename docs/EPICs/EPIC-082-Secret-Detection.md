# EPIC-082 — Secret Detection & Exclusion

**Status: APPROVED | Priority: P0**

## 1. Objective

Stop Ferret indexing credentials and serving them to a model.

## 2. Problem, demonstrated

A repository built with a `.env`, a `secrets/` directory, and a commit message
mentioning rotated keys, indexed with the current build:

```
$ ferret index ./leaky
$ (MCP) ferret_search "a0ff698"
AKIAIOSFODNN7EXAMPLE
ghp_1234567890abcdefghijklmnopqrstuvwx
```

Both returned verbatim to the client. `.env` and `secrets/prod-db-password.txt`
were indexed as file entities.

None of the ten `DEFAULT_EXCLUSIONS` concerns secrets — all are build noise
(`node_modules`, `dist`, `coverage`). There is no secret handling on the
indexing path at all.

File **content** is not yet indexed, so the exposed surface today is: commit
messages, branch names, file paths, author emails, and evidence statements.
Content arrives with EPIC-024–030 and must go through the same gate.

## 3. Scope

1. High-precision detector for provider credential formats.
2. Redaction at **ingestion**, before anything is written.
3. Default path exclusions for secret-bearing files.
4. Report what was redacted — kind and count, never the value.

## 4. Non-scope

- Entropy heuristics. Precision on source code is poor, and a false positive
  destroys real content silently. High-confidence patterns only.
- Scanning file content — nothing indexes it yet (EPIC-024–030).
- Retroactive scrubbing of an existing index (EPIC-090, data lifecycle).
  **Answered 2026-09-02, with nothing new built.** EPIC-090 §8.7: the mechanism
  is `ferret export | <filter> | ferret import` into a fresh database, which is
  auditable at every step — the document before, the document after, and the
  filter that ran. An `UPDATE` that edited a body in place is what Governance §6
  forbids, and it would leave no record that anything was removed. No filter is
  shipped: *which* strings are secret in an index already written is this Epic's
  question, and its answer is a scanner rather than a rewriter.
- Secret *rotation* or notifying anyone. Ferret is not a scanner product.

## 5. Contracts

**Redact at ingestion, not at query.** A secret in the database is already
leaked to anyone with database access, and query-time redaction depends on every
future query path remembering to apply it.

**Never store the value, in any form.** Not hashed, not truncated. The
replacement names the kind only: `[redacted: aws-access-key-id]`.

**Exclusion is not deletion.** An excluded path is reported in
`IndexReport.skipped` with its reason, so an operator sees what was skipped
rather than inferring it from absence.

**Detection is additive to `DEFAULT_EXCLUSIONS`** and cannot be turned off by
repository policy — a repository may only ever exclude *more* (EPIC-003).

## 6. Acceptance criteria

- **AC-1** AWS access key id, GitHub token, Slack token, Google API key, private
  key block, JWT and `key=value` secrets are redacted from a commit message.
- **AC-2** The redacted marker names the kind, and the value never appears in
  the database.
- **AC-3** Surrounding text survives — only the credential is replaced.
- **AC-4** `.env`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `*.p12`, `*.pfx`,
  `credentials`, `.npmrc`, `.pgpass` are excluded by default.
- **AC-5** `.env.example` and `.env.template` are **not** excluded.
- **AC-6** Excluded paths appear in the report with a reason.
- **AC-7** A repository policy cannot disable a default exclusion.
- **AC-8** The report states how many secrets were redacted, by kind, and never
  the values.
- **AC-9** Detection does not fire on ordinary source — a test over this
  repository's own commit messages redacts nothing.
- **AC-10** Redaction is applied to branch names and evidence statements, not
  only commit messages.

## 7. Test requirements

- Unit: each pattern, with a positive and a near-miss negative.
- **AC-9 proved against the real corpus**, not a fixture: run the detector over
  every commit message in this repository and assert zero hits.
- Integration: index a repository containing secrets and assert the database
  holds none of them.
- The fixture uses documented example credentials (`AKIAIOSFODNN7EXAMPLE`) and
  syntactically valid but non-issued tokens. No real credential in the tree.

## 8. Security

- Patterns are anchored and non-backtracking; commit messages are attacker-controlled.
- Redaction is applied before the value reaches storage, logging or an error.
- A failure in the detector must not fail indexing — it fails *closed*, dropping
  the text rather than storing it unredacted.

## 9. Definition of Done

All ACs pass against real infrastructure; `npm run verify` green; the
demonstration in §2 returns nothing; limitations recorded.
