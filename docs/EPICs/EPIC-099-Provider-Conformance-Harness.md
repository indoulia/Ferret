# EPIC-099 — Provider Conformance Harness

**Status: APPROVED | Priority: P0 | Domain: Evaluation & Quality**

> **Specification note.** EPIC-016 built the conformance *suite* and says so in
> its own opening: it "is the conformance suite, not the cross-provider quality
> harness that runs it over time (EPIC-099)". This Epic is that harness, and it
> is deliberately small — most of the work was done, correctly, three Epics ago.
>
> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).

## 1. Objective

Run the conformance suite over **every** provider in one pass, and make a
provider that nothing runs it against a failing build.

## 2. Problem, measured

EPIC-016 is VALIDATED and its suite is good: eighteen stable checks, a
structured report, an assertion helper, published through
`@indoulia/ferret/testing`. Its AC-11 applied the suite to Ferret's own
providers, and that was done.

**It was done by hand, three times, in three files.**

| provider | where it is checked |
| --- | --- |
| `GitSourceProvider` | `tests/unit/provider-conformance.test.ts:346` |
| code parser | `tests/unit/code-parser.test.ts:309` |
| `PostgresStorageProvider` | `tests/integration/providers/conformance.test.ts:54` |

Nothing enumerates the set. A fourth provider — the Jira provider EPIC-071
plans, a second parser, anything a contributor adds — is conformant only if
somebody remembers to write a fourth test, and the failure mode is silence.

This is the same shape as the four defects EPIC-100 was written for: a control
correctly applied to the subjects someone listed, and not to the subject nobody
listed. EPIC-100 fixed it for redaction, credentials, search branches and
process spawners by enumerating from the source. Providers are the remaining
set.

**A second gap, smaller: there is no cross-provider view.** Three separate
reports in three files, two of which need different fixtures, means nobody can
answer "which checks does Ferret's provider surface pass, across all of it"
without running three suites and merging them by eye. EPIC-098 built exactly
that view for retrieval quality; providers have none.

## 3. Scope

1. **An enumerated coverage gate** — every provider implementation in `src/` is
   covered by a conformance run, with the set read from the source.
2. **A cross-provider harness** — one call that runs the suite over a set of
   provider factories and returns one comparable report: per provider, per
   check, with counts.
3. **A printed summary**, so a run says which providers it covered and how many
   checks each passed, rather than only failing loudly.
4. **Reuse of EPIC-016 entirely.** No new check, no second runner, no second
   report shape.

## 4. Non-scope

- **New conformance checks.** Adding one is EPIC-016's, and this Epic must not
  become the place checks accumulate without an owner.
- **Changing `runConformance`, `assertConformant`, the check ids or the report
  shape.** EPIC-016 is VALIDATED and its stable identifiers are a published
  contract (`@indoulia/ferret/testing`).
- **Running the harness against third-party providers automatically.** Ferret
  does not install other people's packages to test them. The harness is
  *reachable* by an author who wants it, which EPIC-016 AC-12 already delivered.
- **Provider health, restart or failure isolation** — EPIC-014, EPIC-093.
- **A CLI command.** Nothing on record asks for `ferret conformance`, and the
  audience for this is a test run, not an operator.
- **Scheduling or trend history** — EPIC-092, EPIC-078.

## 5. Inputs

`runConformance`, `ConformanceReport`, `CONFORMANCE_CHECKS` and the check
identifiers (EPIC-016); the provider factories in `src/`; the source scanner
already written for EPIC-100's enumerated invariants.

## 6. Outputs

- `runProviderConformance(...)` — the cross-provider pass and its report.
- A test that enumerates provider implementations and fails on an uncovered one.
- A printed per-provider summary.

## 7. Dependencies

EPIC-011, EPIC-012, EPIC-016 (VALIDATED — the suite this runs), EPIC-100 (the
enumeration pattern). Nothing here changes an acceptance criterion of any of
them.

## 8. Contracts

### The set of providers is read, never listed

The whole point. A harness whose subjects are a literal array is a harness that
covers what its author remembered, which is the state today spread across three
files.

### A provider that cannot be constructed cheaply is still counted

The storage provider needs a database; the code parser needs a grammar. A
harness that silently skipped them would report full coverage over the two easy
ones. An expensive provider is **declared covered elsewhere**, by name, in the
enumeration — so the gate distinguishes *"checked in the integration suite"*
from *"nobody checks this"*, and the second fails.

### The report is EPIC-016's, aggregated

One `ConformanceReport` per provider, plus counts. No new shape, so a check id
means the same thing here as in the suite that produced it.

## 9. Acceptance criteria

- **AC-1** Every provider implementation in `src/` is either run by the harness
  or explicitly declared as covered elsewhere; a provider that is neither fails
  the build.
- **AC-2** The enumeration is read from the source, and fails when it finds no
  providers at all.
- **AC-3** The harness runs the suite over several providers in one call and
  returns one report per provider, using EPIC-016's shape unchanged.
- **AC-4** The aggregate reports, per provider, how many checks passed, failed
  and were skipped, and whether the provider is conformant.
- **AC-5** A non-conformant provider makes the aggregate non-conformant, and
  the failing check ids are named.
- **AC-6** The run prints which providers it covered, so a passing run states
  its own scope.
- **AC-7** No check identifier, report field or exported name from EPIC-016
  changes.
- **AC-8** The harness adds no more than 5 seconds to `npm run verify` beyond
  the conformance runs that already happen.

## 10. Test requirements

- **Unit** — the aggregate over a conformant and a deliberately non-conformant
  provider; the enumeration's failing-closed assertion; the "declared covered
  elsewhere" path proved by removing a declaration and observing the failure.
- **No new integration fixture.** The storage provider's conformance run already
  exists against a real server and stays where it is; this Epic asserts that it
  exists, not that it runs twice.

## 11. Security requirements

The harness runs providers. It composes them with `createTestProviderContext`,
which since EPIC-081 projects the configuration and grants no credential, so a
conformance run cannot hand a provider a secret it would not receive in
production.

## 12. Observability

AC-6. A passing security or quality gate that does not say what it covered is
the failure mode EPIC-100 named; this prints the provider list and per-provider
counts.

## 13. Performance constraints

AC-8. The harness runs each provider's lifecycle a handful of times; the
expensive providers are not re-run here.

## 14. Definition of Done

Every acceptance criterion satisfied; `npm run verify` green; a validation
document; the registry updated; anything the enumeration turns up filed against
its owning Epic.

## 15. Governance alignment

- **§4 Provider-First** — a contract nothing checks is a contract in prose.
- **§6 Evidence Before Inference** — an enumerated set is evidence; three
  hand-written tests are three assertions about what someone remembered.
- **§19** — the harness pattern EPIC-098 established, applied to a second kind
  of quality.
- **AI Development Rules §7** — scope is the enumeration and the aggregate. No
  new checks.

## 16. Raised, not absorbed

- **This Epic may find that a provider is not conformant.** If it does, the
  finding is filed against that provider's Epic and fixed there. The harness
  reports; it does not repair, and it must not be weakened to make an existing
  provider pass.
- **"Declared covered elsewhere" is an escape hatch.** It is bounded — a
  declaration names the provider and the file that covers it, and the gate
  fails if that file does not mention the provider — but a future author could
  use it to opt out. Recorded rather than designed around, because the
  alternative is a harness that cannot run at all without a database.
