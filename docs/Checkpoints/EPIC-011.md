# Development Checkpoint — EPIC-011

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-011 — Provider Contracts (P0, Provider Platform)

**Objective:** The versioned, capability-shaped contracts every external system
and replaceable implementation sits behind.

**Branch:** `feat/epic-011-provider-contracts`, cut from `main` at `93e01b4`.

**Epic status:** VALIDATED — 8/8 acceptance criteria PASS. Two test areas
recorded **NOT APPLICABLE** with reasons (see the evidence §4). Evidence in
[`docs/EPICs/validation/EPIC-011-VALIDATION.md`](../EPICs/validation/EPIC-011-VALIDATION.md).

---

## A process change starts here

**EPIC-011 had no specification file.** The registry (v3.0) approves Epics 011
through 107 by name, domain and priority only; specification files existed for
001–010.

So this Epic wrote its own specification first, to
[`EPIC-SPECIFICATION-STANDARD.md`](../EPICs/EPIC-SPECIFICATION-STANDARD.md), from
the registry entry and the governance documents, and it is committed alongside
the implementation. **Every Epic from here does the same**, and each validation
document says so plainly — because it means the acceptance criteria being
validated were authored by the same work that satisfies them. The specification
is always in the diff for review.

Scope is drawn from the registry's domain and the governance rules. Nothing is
invented, and a specification that would expand scope beyond the registry entry
should be raised rather than written.

---

## Completed

- **Eight capabilities**, each independently versioned with a stated supported
  span: `storage`, `source.repository`, `source.history`, `source.file`,
  `source.project`, `parser`, `embedding`, `mcp`.
- **Capability declaration** on the provider contract, optional so EPIC-001-era
  providers keep working.
- **Selection by capability** — `forCapability`, `allForCapability`,
  `declarationFor`, `supports`, `capabilities` — backed by an index rather than a
  scan.
- **Partial implementation** via a named operation subset, discoverable before
  the call rather than by exception.
- **Declared limits** — pagination, server-side filtering, incremental reads,
  page size, rate limit — queryable before an operation is attempted.
- **Validation at registration**, atomically, so a bad declaration leaves no
  trace.
- **The storage provider adopts the contract** with no behavioural change.
- **An architecture rule** proving the core reaches no concrete provider.

## Files

```text
docs/EPICs/EPIC-011-Provider-Contracts.md    the specification, written to the standard
src/providers/capabilities.ts                capabilities, versions, limits, verdicts

tests/unit/capabilities.test.ts              28 cases
```

Modified: `src/providers/contract.ts` (declaration + descriptor),
`src/providers/registry.ts` (capability index and selection),
`src/providers/index.ts`, `src/index.ts`, `src/errors/codes.ts`
(`E_CAPABILITY_UNAVAILABLE`), `src/cli/exit-codes.ts`,
`src/storage/provider.ts` (declares `storage`),
`tests/unit/boundaries.test.ts` (capability boundary),
`tests/unit/providers.test.ts` (descriptor shape).

## Tests

`npm run verify` — **839 passed, 3 skipped** across 37 files, zero unhandled
errors. `npm audit` — **0 vulnerabilities**.

## The defect these tests caught

**Registration was not atomic.** Declarations were validated after the provider
had been inserted, so an invalid one left a half-registered provider — present in
`size` and `describe()`, absent from the capability index. Fixed by validating
before recording anything.

## Notes for whoever picks this up

- **Ask for a capability, never for a provider.** `registry.forCapability(...)`.
  If you find yourself importing a concrete provider outside its own directory,
  the boundary test will stop you, and it is right to.
- **`supports()` returns a verdict; prefer it to `assertSupported()`.**
  Governance §13 wants a missing capability to reduce what Ferret can answer, not
  break what it can. Throwing is for the few call sites that genuinely cannot
  degrade.
- **Declare limits honestly.** A provider claiming `supportsServerSideFilter`
  when it cannot filter makes every caller wrong. Absent means "not claimed",
  which is the safe reading.
- **Method signatures are deliberately not fixed yet.** A capability says *what*
  a provider offers; the interface is defined by the Epic that first needs it.
  Designing signatures now would be designing against imagined requirements.

## Blockers

None.

## Known limitations

Full table in the validation evidence. Carried forward:

- Seven of eight capabilities have no implementation yet — the honest state of a
  foundation Epic → **EPIC-017**, **021**, **024**, **054**, **064**, **071**
- Contracts declare capabilities, not method signatures → **EPIC-012** and each
  consuming Epic
- Selection is registration order, with no user preference → **EPIC-013**, **EPIC-015**
- Cancellation and error-classification invariants are stated but unverified →
  **EPIC-016**
- Capabilities are not yet surfaced by `ferret status` / `doctor` → **EPIC-014**
- No provider deregistration → **EPIC-014** if it becomes a requirement

## Next step

**EPIC-012 — Provider SDK**, then **EPIC-013** (Registry & Discovery),
**EPIC-015** (Configuration & Secrets) and **EPIC-016** (Conformance Testing).

EPIC-012's job is to make writing a provider easy and correct: base classes that
handle lifecycle boilerplate, helpers for emitting canonical entities,
relationships and evidence, cancellation and retry helpers, and test doubles so a
provider author can test without a live upstream. It is also where the method
signatures for each capability should finally be pinned — by then EPIC-017 will
be close enough to say what a `source.repository` provider actually needs.

EPIC-014 (Provider Lifecycle & Health, P1) can be taken alongside, and would close
two limitations recorded here.
