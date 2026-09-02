# EPIC-100 — Security Regression Suite

**Status: APPROVED | Priority: P0 | Domain: Evaluation & Quality**

> **Specification note.** Written from the registry entry
> (`docs/EPICs/README.md:214`, Evaluation & Quality, P0) and from four defects
> found in VALIDATED code during a single session on 2026-09-02. No other
> document parks a limitation on EPIC-100; a repository-wide grep for `100`
> returns that registry line and nothing else.
>
> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> §2 describes the code as it is, with numbers taken from the defects rather
> than from an argument about what might go wrong.

## 1. Objective

Test the security properties that live **between** components, so a control no
single Epic owns cannot be lost without a build failing.

## 2. Problem, measured

Ferret's security testing is thorough and per-Epic. Seventeen test files carry
security assertions — redaction, secret detection, permission filtering,
containment, authorization, boundaries — and every one of them passes.

**Four security defects shipped anyway, in code marked VALIDATED**, and were
found by running the product rather than by any of those tests. Every one is a
*cross-Epic invariant*: a property of the relationship between two components,
where each component's own test was correct.

| defect | each part tested | the untested property |
| --- | --- | --- |
| The log redactor knew six credential formats; the ingestion redactor knew twelve. A Slack, Google, npm or Stripe token Ferret refuses to **store** printed verbatim to stderr. (#93) | `redact.test.ts` (51 cases) and `secrets.test.ts` both green | *the two lists are the same size* |
| Every provider received the database password on `context.config` — a parser, an MCP server, a Git source. (EPIC-081 §2) | EPIC-015 tested that a provider gets only its own `settings` | *a provider cannot reach a credential at all* |
| `detectGit` started `git --version` with the whole parent environment, including `FERRET_DATABASE_PASSWORD`, and had since EPIC-001. (#94) | `runner.ts`'s `scrubEnvironment` was tested and correct | *every process spawner scrubs, not just the tested one* |
| `ferret init --save` replaced a stored `$secret` reference with the cleartext it resolved to — the command whose own doc comment recommends the reference. (#92) | `ConfigStore` tested; `resolveSecrets` tested | *a reference survives a write-read-write round trip* |

A fifth, found the same way: `content_hash` was a function of a timestamp's
*spelling*, so EPIC-008's integrity check had never worked for any observation
carrying a non-UTC `observedAt` — and nobody knew, because that check **had no
production caller** (EPIC-094 §2).

The pattern is not carelessness. It is that a per-Epic suite tests what an Epic
built, and a security property is frequently a statement about two Epics at
once. Nothing in the repository tests those statements, and nothing fails when
one is broken.

**A second, quieter problem: a control with no caller is indistinguishable from
a control.** `EvidenceStore.verify` existed, was correct, was tested, and was
reachable from nothing. EPIC-094 found it; a suite that asserted "every declared
control is exercised on a production path" would have found it three Epics
earlier.

## 3. Scope

1. **A named suite** — `tests/security/`, run by `npm run test:security` and
   included in `npm run verify` — holding *only* cross-cutting invariants.
2. **Enumerated coverage, never a hand-written list.** Each invariant derives
   its subjects from the source: every secret pattern, every process spawner,
   every retrieval branch, every context constructor. A new one fails the suite
   until it is covered.
3. **The five findings above as permanent regressions**, each stated as the
   property rather than as the incident.
4. **A caller assertion** for security controls: a control Ferret declares is
   reachable from a production path, not only from a test.
5. **`npm run test:security` usable alone**, so the suite can be run against a
   candidate build without the rest.

## 4. Non-scope

- **Rewriting or moving the seventeen existing files.** They test what their
  Epics built and are correct. This Epic adds the statements between them; a
  suite that absorbed them would make every Epic's evidence harder to find.
- **New security controls.** Nothing here adds a mechanism. If an invariant
  cannot be satisfied, the finding is filed against the owning Epic.
- **Penetration testing, fuzzing, dependency CVE scanning.** The dependency
  audit job already exists; fuzzing is unowned and unrequested.
- **Authenticating a principal** — declined by EPIC-068 §4 and EPIC-083 §4.
- **Secret scanning of Git history**, or of the working tree beyond the existing
  packaging scan.
- **Performance of the security path** — EPIC-101. **Measured 2026-09-03 at
  1.08×** — 1.94 ms unscoped against 1.98 ms scoped at p95 over 20 000 evidence
  rows. Reported as a *ratio* rather than an absolute, because an absolute would
  be a fact about the machine. The security path is not where Ferret's time
  goes.
- **Audit events** — EPIC-085.

## 5. Inputs

- `SECRET_KINDS` (`src/security/secrets.ts`) and `SECRET_VALUE_PATTERNS`
  (`src/errors/redact.ts`).
- `CREDENTIAL_ENV`, `withoutCredentials`, `CREDENTIAL_CONFIG_PATHS`,
  `withoutCredentialFields`.
- The union branches of `RetrievalStore.search` and `scopePredicate` /
  `permissionPredicate`.
- `ProviderContext` construction sites.
- EPIC-084's `contain` / `CONTENT_OPEN` / `CONTENT_CLOSE`.
- The import-graph scanner already written in `tests/unit/boundaries.test.ts`.

## 6. Outputs

- `tests/security/` and an `npm run test:security` script.
- One file per invariant, named for the property rather than for the Epic.
- A documented rule for where a new security test belongs.

## 7. Dependencies

EPIC-058, EPIC-068, EPIC-069, EPIC-081, EPIC-082, EPIC-083, EPIC-084, EPIC-091 —
all IMPLEMENTED or VALIDATED. This Epic asserts their composition and changes
none of their acceptance criteria.

## 8. Contracts

### An invariant enumerates its subjects from the source

A hand-written list of things to check is a list that goes stale on the next
commit, silently, in the direction of checking less. Every invariant here reads
the set it applies to — the patterns, the spawners, the branches — so adding a
subject without covering it is a failing build rather than an omission nobody
sees.

This is the property that would have caught three of the four defects in §2.

### The suite tests relationships, not components

A test belongs here only if it is a statement about **two or more** parts.
"Redaction masks a Slack token" belongs to EPIC-082. "The log redactor covers
every kind the ingestion redactor covers" belongs here, because neither Epic
owns it and both would pass without it.

### A failure names the property, not the incident

`the log redactor is a superset of the content redactor` is a sentence someone
can act on in a year. `regression for #93` is not.

### The suite fails closed

An invariant that cannot enumerate its subjects — a renamed export, a moved
file — fails rather than passing over an empty set. A security test that
silently checks nothing is worse than no test, and is the specific failure mode
this Epic must not introduce.

## 9. Acceptance criteria

- **AC-1** `npm run test:security` runs the suite alone and is part of
  `npm run verify`.
- **AC-2** Every credential kind in `SECRET_KINDS` is redacted from a log field,
  an error message and configuration output, with the set enumerated from
  `SECRET_KINDS` rather than listed.
- **AC-3** Adding a kind to `SECRET_KINDS` without covering it fails the suite.
  Proved by a test that asserts the enumeration is total, not by inspection.
- **AC-4** No `ProviderContext` construction site in `src/` hands a provider a
  credential field, enumerated from the construction sites.
- **AC-5** Every module in `src/` that imports `node:child_process` reaches the
  credential scrub, enumerated from the imports.
- **AC-6** A `$secret` reference survives every path that rewrites the
  configuration file, enumerated from `ConfigStore`'s mutating methods.
- **AC-7** Every union branch of `RetrievalStore.search` applies the scope
  predicate, enumerated from the branches.
- **AC-8** No security control Ferret declares is unreachable from a production
  path; a control whose only callers are tests fails the suite.
- **AC-9** No real credential appears in the shipped tree — the existing
  packaging scan, restated here as a security invariant rather than a packaging
  one.
- **AC-10** Untrusted repository text reaching an AI client is inside EPIC-084's
  content fences, enumerated from the MCP tools that return indexed content.
- **AC-11** Every invariant fails when its property is broken, proved by a
  deliberate local break in the test's own fixture — not by trusting that a
  passing test would fail.
- **AC-12** The suite adds no more than 10 seconds to `npm run verify`.

## 10. Test requirements

The suite *is* the test requirement. What matters is how each invariant is
written:

- **Enumerated, from the source.** `SECRET_KINDS.map(...)`, the import graph,
  the branch list — never a literal array of names.
- **Failing-closed proved.** Each invariant has a companion assertion that its
  subject set is non-empty, so a rename cannot turn it into a no-op.
- **Behaviour where behaviour is observable**, structure only where it is not.
  A redaction invariant asserts masked output; a spawner invariant asserts an
  import, because the alternative is a parser.
- **No new fixtures carrying real-looking credentials** beyond the synthetic
  ones EPIC-082's tests already use.

## 11. Security requirements

- The suite reads source and runs code. It stores nothing, and adds no
  credential, fixture or environment variable to the tree.
- A failure message names the property and the subject; it never prints the
  value that failed to be redacted, which would put the secret in the CI log the
  test exists to keep it out of.

## 12. Observability

`npm run test:security` reports which invariants ran and over how many subjects.
A count is what makes "the suite passed" mean something: 12 kinds, 2 spawners,
4 branches.

## 13. Performance constraints

AC-12. The suite is structural and unit-level; anything needing a database
belongs in the integration suites that already have one.

## 14. Definition of Done

Every acceptance criterion satisfied; `npm run verify` green with the suite in
it; a validation document; the registry updated; any invariant that cannot be
satisfied filed against its owning Epic rather than weakened.

## 15. Governance alignment

- **§12 Security** — "Security controls are enforced by Ferret, not by AI
  prompts." A control nothing exercises is not enforced.
- **§6 Evidence Before Inference** — an enumerated invariant is evidence; a
  hand-written list is an assertion about what someone remembered.
- **§19** — the golden-dataset principle applied to security: measure the
  property, do not assert it.
- **AI Development Rules §7** — scope is the five findings and the machinery to
  keep them found. No new controls.

## 16. Raised, not absorbed

- **AC-8 may not be satisfiable as stated.** "Reachable from a production path"
  is an import-graph question, and a control reached only through a port —
  which is most of them — looks unreachable to a scanner. If it cannot be made
  precise, the honest outcome is a narrower criterion naming the specific
  controls checked, recorded rather than dropped.
- **This Epic will find defects.** Writing an enumerated invariant over an
  existing codebase is how the five in §2 were found in the first place. Any it
  turns up are filed against their owning Epic and fixed there, not absorbed
  here — except where the fix is the same change as the invariant.
- **The suite duplicates some existing assertions.** `boundaries.test.ts`
  already asserts the spawner invariant, added by EPIC-081. Moving it would take
  scope from EPIC-081's evidence; referencing it from here and asserting it
  exists is the smaller change, and is what §4 chooses.
